import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { useDictation, type Dictation } from "../components/dictation.tsx";
import { notifySettingsSaved } from "../components/settings-signal.ts";
import { useDictationLanguage } from "../components/dictation-preference.ts";
import type { DictationSettings } from "../src/core/index.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

class AudioGraph {
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
}
class Worklet {
	static last: Worklet | undefined;
	port: { onmessage?: (e: { data: unknown }) => void } = {};
	constructor() { Worklet.last = this; }
	connect() {}
	disconnect() {}
}

const globals = globalThis as Record<string, unknown>;
let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;

async function fixture(dictation: DictationSettings) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const state = {
		appends: [] as string[],
		sockets: 0,
		tokenMints: 0,
		warmups: 0,
		posted: [] as Blob[],
		signals: [] as AbortSignal[],
		nextTranscription: undefined as Promise<Response> | undefined,
	};
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
		WebSocket: class { constructor() { state.sockets++; } },
		AudioContext: AudioGraph, AudioWorkletNode: Worklet,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string, init?: RequestInit) => {
			if (url === "/api/stt/token") { state.tokenMints++; return Response.json({ token: "t" }); }
			if (url === "/api/settings") return Response.json({ settings: { version: 1, dictation } });
			assert.equal(url, "/api/stt/transcribe");
			if (init?.method !== "POST") { state.warmups++; return Response.json({ ready: true }); }
			state.posted.push(init.body as Blob);
			state.signals.push(init.signal!);
			if (state.nextTranscription) return state.nextTranscription;
			return Response.json({ text: "spoken words" });
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	};
	const { createRoot } = await import("react-dom/client");
	let latest!: Dictation;
	function Harness() {
		latest = useDictation({ append: (text) => state.appends.push(text) });
		useDictationLanguage();
		return null;
	}
	const root = createRoot(document.getElementById("root")!);
	await act(async () => { root.render(<Harness />); });
	// Drop a previous fixture's window-lifetime preference cache.
	await act(async () => { notifySettingsSaved("dictation"); });
	dispose = async () => { await act(async () => { root.unmount(); }); };
	// Mount pre-mints a Deepgram token; count only what runs do.
	state.tokenMints = 0;
	return {
		state,
		get dictation() { return latest; },
		frame: (samples = 2048) => Worklet.last!.port.onmessage!({ data: { type: "audio", buffer: new Int16Array(samples).buffer } }),
	};
}

afterEach(async () => { await dispose?.(); restore?.(); dispose = undefined; restore = undefined; });

test("whisper: records without a socket, transcribes the whole run once at stop", async () => {
	const f = await fixture({ language: "en", engine: "whisper" });
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.dictation.phase, "recording");
	assert.equal(f.state.sockets, 0);
	assert.equal(f.state.tokenMints, 0);
	assert.equal(f.state.warmups, 1, "the model warms while the learner speaks");
	f.frame();
	f.frame();
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.state.posted.length, 1);
	assert.equal(f.state.posted[0]!.size, 2 * 2048 * 2);
	assert.deepEqual(f.state.appends, ["spoken words"]);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.state.tokenMints, 0, "keyless runs never mint Deepgram tokens");
});

test("endpoint: a silent run sends nothing; errors surface on the bar", async () => {
	const f = await fixture({ language: "en", engine: "endpoint" });
	await act(async () => { f.dictation.toggle(); });
	assert.equal(f.state.warmups, 0);
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.state.posted.length, 0);
	assert.equal(f.dictation.phase, "idle");

	f.state.nextTranscription = Promise.resolve(Response.json({ message: "Dictation needs a transcription endpoint URL" }, { status: 503 }));
	await act(async () => { f.dictation.toggle(); });
	f.frame();
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.error, "Dictation needs a transcription endpoint URL");
	assert.deepEqual(f.state.appends, []);

	f.state.nextTranscription = Promise.resolve(Response.json({ text: "" }));
	await act(async () => { f.dictation.toggle(); });
	f.frame();
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.error, "No speech heard. Check your microphone");
});

test("cancel during transcription aborts it and discards the text; finish() waits for the text", async () => {
	const f = await fixture({ language: "en", engine: "whisper" });
	const slow = deferred<Response>();
	f.state.nextTranscription = slow.promise;
	await act(async () => { f.dictation.toggle(); });
	f.frame();
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.phase, "stopping");
	await act(async () => { f.dictation.cancel(); });
	assert.equal(f.state.signals[0]!.aborted, true);
	await act(async () => { slow.resolve(Response.json({ text: "too late" })); });
	assert.deepEqual(f.state.appends, []);
	assert.equal(f.dictation.phase, "idle");

	f.state.nextTranscription = undefined;
	await act(async () => { f.dictation.toggle(); });
	f.frame();
	let finished = false;
	await act(async () => { void f.dictation.finish().then(() => { finished = true; }); });
	assert.equal(finished, true);
	assert.deepEqual(f.state.appends, ["spoken words"]);
});
