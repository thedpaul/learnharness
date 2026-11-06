import assert from "node:assert/strict";
import { test } from "node:test";
import {
	cleanTranscript, pcm16ToFloat32, pcm16ToWav, transcribeWithEndpoint,
} from "../src/server/transcribe.ts";
import { parseDictationSettingsBody } from "../src/server/settings-body.ts";
import { resolveSettings, sanitizeUserSettings, transcriptionsUrl, whisperLanguage } from "../src/core/index.ts";

test("WAV wrapping: a 44-byte RIFF header over the untouched PCM", () => {
	const pcm = new Uint8Array(new Int16Array([0, 1000, -1000, 32767]).buffer);
	const wav = pcm16ToWav(pcm);
	const v = new DataView(wav.buffer);
	assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), "RIFF");
	assert.equal(new TextDecoder().decode(wav.subarray(8, 12)), "WAVE");
	assert.equal(v.getUint32(24, true), 16000);
	assert.equal(v.getUint32(40, true), pcm.byteLength);
	assert.deepEqual(wav.subarray(44), pcm);
	assert.deepEqual([...pcm16ToFloat32(pcm)].map((x) => Math.round(x * 32768)), [0, 1000, -1000, 32767]);
});

test("transcripts drop Whisper's bracketed non-speech captions", () => {
	assert.equal(cleanTranscript(" [BLANK_AUDIO] "), "");
	assert.equal(cleanTranscript(" so (music) the slope  [laughs] grows"), "so the slope grows");
});

test("language and URL mapping", () => {
	assert.equal(whisperLanguage("multi"), undefined);
	assert.equal(whisperLanguage("en-GB"), "en");
	assert.equal(whisperLanguage("zh-Hant"), "zh");
	assert.equal(transcriptionsUrl("http://127.0.0.1:8080/v1/"), "http://127.0.0.1:8080/v1/audio/transcriptions");
	assert.equal(transcriptionsUrl("http://h/v1/audio/transcriptions"), "http://h/v1/audio/transcriptions");
});

test("endpoint: multipart WAV + model + language, honest failures", async () => {
	const pcm = new Uint8Array(3200);
	let form: FormData | undefined;
	let target = "";
	const text = await transcribeWithEndpoint(pcm, { url: "http://local/v1", model: "base.en" }, "en-US", async (url, init) => {
		target = String(url);
		form = init!.body as FormData;
		return Response.json({ text: " hello [BLANK_AUDIO]" });
	});
	assert.equal(text, "hello");
	assert.equal(target, "http://local/v1/audio/transcriptions");
	assert.equal(form!.get("model"), "base.en");
	assert.equal(form!.get("language"), "en");
	assert.equal((form!.get("file") as Blob).size, 44 + 3200);
	await assert.rejects(
		transcribeWithEndpoint(pcm, { url: "http://local/v1", model: "m" }, "multi", async () => new Response("nope", { status: 404 })),
		/Transcription endpoint failed \(404\): nope/,
	);
	assert.equal(await transcribeWithEndpoint(new Uint8Array(0), { url: "http://x", model: "m" }, "en", async () => { throw new Error("no call"); }), "");
});

test("dictation settings: strict writes, field-wise reads, Deepgram stays the default", () => {
	assert.deepEqual(parseDictationSettingsBody({ engine: "whisper", whisperModel: "onnx-community/whisper-small" }), {
		ok: true, settings: { engine: "whisper", whisperModel: "onnx-community/whisper-small" },
	});
	assert.equal(parseDictationSettingsBody({ engine: "vosk" }).ok, false);
	assert.equal(parseDictationSettingsBody({ whisperModel: "openai/whisper-huge" }).ok, false);
	assert.equal(parseDictationSettingsBody({ endpointUrl: "file:///etc/passwd" }).ok, false);
	assert.equal(parseDictationSettingsBody({ endpointModel: "  " }).ok, false);

	const record = sanitizeUserSettings({ version: 1, dictation: { language: "xx", engine: "endpoint", endpointUrl: "http://h:1/v1", endpointModel: " m " } });
	assert.deepEqual(record!.dictation, { engine: "endpoint", endpointUrl: "http://h:1/v1", endpointModel: "m" });
	const resolved = resolveSettings(record).dictation;
	assert.equal(resolved.language, "en");
	assert.equal(resolved.engine, "endpoint");
	assert.equal(resolveSettings(null).dictation.engine, "deepgram");
	assert.equal(resolveSettings(null).dictation.endpointModel, "whisper-1");
});
