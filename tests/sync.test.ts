import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { mergeLedgerText, mergeSettings } from "../src/core/sync-merge.ts";
import { isSyncedPath, runSync, type Remote, type RemoteFile } from "../src/server/sync/engine.ts";

// ─── merges ─────────────────────────────────────────────────────────────────

test("ledger merge: both devices' additions survive, local order first", () => {
	const base = "a\nb\n";
	assert.equal(mergeLedgerText(base, "a\nb\nlocal1\n", "a\nb\nremote1\n"), "a\nb\nlocal1\nremote1\n");
});

test("ledger merge: a removal on either side stays removed (session deletion)", () => {
	const base = "a\nb\nc\n";
	assert.equal(mergeLedgerText(base, "a\nc\n", "a\nb\nc\nd\n"), "a\nc\nd\n");
	assert.equal(mergeLedgerText(base, "a\nb\nc\nx\n", "b\nc\n"), "b\nc\nx\n");
	assert.equal(mergeLedgerText("", "", ""), "");
});

test("ledger merge: first sync (no base) is a union without duplicates", () => {
	assert.equal(mergeLedgerText("", "a\nb\n", "b\nc\n"), "a\nb\nc\n");
});

test("settings merge: per key, device keys and file-access folders stay local", () => {
	const base = { appearance: { font: "x" }, models: { strong: "a" }, dictation: { engine: "deepgram" } };
	const local = { appearance: { font: "y" }, models: { strong: "a" }, dictation: { engine: "android" }, agent: { fileAccess: { restricted: true, folders: ["/data/me"] } } };
	const remote = { appearance: { font: "x" }, models: { strong: "b" }, dictation: { engine: "whisper" }, agent: { quizzing: "mc", fileAccess: { restricted: true, folders: ["/home/me"] } } };
	const merged = mergeSettings(base, local, remote, true);
	assert.deepEqual(merged.appearance, { font: "y" }); // only local changed
	assert.deepEqual(merged.models, { strong: "b" }); // only remote changed
	assert.deepEqual(merged.dictation, { engine: "android" }); // device key
	assert.deepEqual(merged.agent, { quizzing: "mc", fileAccess: { restricted: true, folders: ["/data/me"] } });
});

test("settings merge: both changed the same key → the newer side wins", () => {
	const base = { models: { strong: "a" } };
	assert.deepEqual(mergeSettings(base, { models: { strong: "l" } }, { models: { strong: "r" } }, true).models, { strong: "r" });
	assert.deepEqual(mergeSettings(base, { models: { strong: "l" } }, { models: { strong: "r" } }, false).models, { strong: "l" });
});

test("synced paths: progress and settings only", () => {
	for (const p of ["settings.json", "reviews.jsonl", "review-checks.jsonl", "review-fields.jsonl", "chats/chat_a.json", "jobs/job_1.json", "graph/nodes.jsonl", "graph/positions.json"]) assert.ok(isSyncedPath(p), p);
	for (const p of ["models/x/y.onnx", ".sync/state.json", "debug/a.jsonl", "chats/../auth.json", "chats/sub/a.json"]) assert.ok(!isSyncedPath(p), p);
});

// ─── engine, against an in-memory remote ────────────────────────────────────

class MemoryRemote implements Remote {
	files = new Map<string, { id: string; body: Buffer; modifiedTime: string }>();
	private n = 0;
	clock = 0;
	private meta(p: string, f: { id: string; body: Buffer; modifiedTime: string }): RemoteFile {
		return { id: f.id, path: p, md5: createHash("md5").update(f.body).digest("hex"), modifiedTime: f.modifiedTime };
	}
	async list() { return [...this.files].map(([p, f]) => this.meta(p, f)); }
	async download(file: RemoteFile) { return this.files.get(file.path)!.body; }
	async upload(p: string, body: Buffer, id?: string) {
		const f = { id: id ?? `id${++this.n}`, body: Buffer.from(body), modifiedTime: new Date(Date.UTC(2030, 0, 1, 0, 0, ++this.clock)).toISOString() };
		this.files.set(p, f);
		return this.meta(p, f);
	}
	async remove(file: RemoteFile) { this.files.delete(file.path); }
}

function device(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-"));
}
const put = (dir: string, rel: string, text: string) => {
	fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), text);
};
const get = (dir: string, rel: string) => {
	try { return fs.readFileSync(path.join(dir, rel), "utf-8"); } catch { return null; }
};

test("engine: phone progress reaches the desktop and both keep their own additions", async () => {
	const remote = new MemoryRemote();
	const desktop = device();
	const phone = device();
	put(desktop, "chats/chat_a.json", '{"id":"a"}');
	put(desktop, "graph/nodes.jsonl", '{"id":"n1"}\n');
	await runSync(desktop, remote);
	await runSync(phone, remote);
	assert.equal(get(phone, "chats/chat_a.json"), '{"id":"a"}');
	assert.equal(get(phone, "graph/nodes.jsonl"), '{"id":"n1"}\n');

	put(phone, "graph/nodes.jsonl", '{"id":"n1"}\n{"id":"n2"}\n');
	put(phone, "chats/chat_b.json", '{"id":"b"}');
	put(desktop, "graph/nodes.jsonl", '{"id":"n1"}\n{"id":"n3"}\n');
	await runSync(phone, remote);
	const r = await runSync(desktop, remote);
	assert.equal(get(desktop, "graph/nodes.jsonl"), '{"id":"n1"}\n{"id":"n3"}\n{"id":"n2"}\n');
	assert.equal(get(desktop, "chats/chat_b.json"), '{"id":"b"}');
	assert.ok(r.changedLocal.includes("chats/chat_b.json"));
	await runSync(phone, remote);
	assert.equal(get(phone, "graph/nodes.jsonl"), get(desktop, "graph/nodes.jsonl"));
});

test("engine: deleting a session on one device deletes it on the other", async () => {
	const remote = new MemoryRemote();
	const a = device();
	const b = device();
	put(a, "chats/chat_x.json", "{}");
	await runSync(a, remote);
	await runSync(b, remote);
	fs.rmSync(path.join(a, "chats/chat_x.json"));
	await runSync(a, remote);
	assert.equal(remote.files.has("chats/chat_x.json"), false);
	await runSync(b, remote);
	assert.equal(get(b, "chats/chat_x.json"), null);
});

test("engine: a session edited on both devices → newer wins, the other copy is kept", async () => {
	const remote = new MemoryRemote();
	const a = device();
	const b = device();
	put(a, "chats/chat_x.json", '{"v":0}');
	await runSync(a, remote);
	await runSync(b, remote);
	put(b, "chats/chat_x.json", '{"v":"b"}');
	await runSync(b, remote); // remote now 2030 — newer than a's local edit
	put(a, "chats/chat_x.json", '{"v":"a"}');
	const r = await runSync(a, remote);
	assert.equal(r.conflicts, 1);
	assert.equal(get(a, "chats/chat_x.json"), '{"v":"b"}');
	const conflicts = fs.readdirSync(path.join(a, ".sync/conflicts"));
	assert.equal(fs.readFileSync(path.join(a, ".sync/conflicts", conflicts[0]!, "chats/chat_x.json.local"), "utf-8"), '{"v":"a"}');
});

test("engine: running jobs stay local, settled ones sync", async () => {
	const remote = new MemoryRemote();
	const a = device();
	put(a, "jobs/job_1.json", '{"status":"running"}');
	await runSync(a, remote);
	assert.equal(remote.files.has("jobs/job_1.json"), false);
	put(a, "jobs/job_1.json", '{"status":"done"}');
	await runSync(a, remote);
	assert.equal(remote.files.get("jobs/job_1.json")?.body.toString(), '{"status":"done"}');
	// Re-running locally must not delete the remote copy.
	put(a, "jobs/job_1.json", '{"status":"running"}');
	await runSync(a, remote);
	assert.equal(remote.files.has("jobs/job_1.json"), true);
});

test("engine: settings never overwrite this device's dictation", async () => {
	const remote = new MemoryRemote();
	const desktop = device();
	const phone = device();
	put(desktop, "settings.json", JSON.stringify({ version: 1, dictation: { engine: "whisper" }, appearance: { a: 1 } }));
	await runSync(desktop, remote);
	put(phone, "settings.json", JSON.stringify({ version: 1, dictation: { engine: "android" } }));
	await runSync(phone, remote);
	const phoneSettings = JSON.parse(get(phone, "settings.json")!) as Record<string, unknown>;
	assert.deepEqual(phoneSettings.dictation, { engine: "android" });
	assert.deepEqual(phoneSettings.appearance, { a: 1 });
	put(desktop, "settings.json", JSON.stringify({ version: 1, dictation: { engine: "whisper" }, appearance: { a: 2 } }));
	await runSync(desktop, remote);
	await runSync(phone, remote);
	const after = JSON.parse(get(phone, "settings.json")!) as Record<string, unknown>;
	assert.deepEqual(after.dictation, { engine: "android" });
	assert.deepEqual(after.appearance, { a: 2 });
});

test("engine: two devices with different dictation settings don't re-upload settings forever", async () => {
	const remote = new MemoryRemote();
	const desktop = device();
	const phone = device();
	put(desktop, "settings.json", JSON.stringify({ version: 1, dictation: { engine: "whisper" }, appearance: { a: 1 } }));
	await runSync(desktop, remote);
	put(phone, "settings.json", JSON.stringify({ version: 1, dictation: { engine: "android" }, appearance: { a: 1 } }));
	for (let i = 0; i < 3; i++) {
		await runSync(phone, remote);
		await runSync(desktop, remote);
	}
	const uploads = remote.clock;
	await runSync(phone, remote);
	await runSync(desktop, remote);
	assert.equal(remote.clock, uploads, "no uploads once settled");
});

test("engine: a second sync with no changes does nothing", async () => {
	const remote = new MemoryRemote();
	const a = device();
	put(a, "chats/chat_a.json", "{}");
	await runSync(a, remote);
	const r = await runSync(a, remote);
	assert.deepEqual([r.uploaded, r.downloaded, r.merged, r.deleted, r.changedLocal.length], [0, 0, 0, 0, 0]);
});

test("engine: review history from both devices combines", async () => {
	const remote = new MemoryRemote();
	const desktop = device();
	const phone = device();
	put(desktop, "reviews.jsonl", '{"card":"a","at":"1","correct":true}\n');
	await runSync(desktop, remote);
	await runSync(phone, remote);
	put(phone, "reviews.jsonl", '{"card":"a","at":"1","correct":true}\n{"card":"b","at":"2","correct":false}\n');
	put(desktop, "reviews.jsonl", '{"card":"a","at":"1","correct":true}\n{"card":"c","at":"3","correct":true}\n');
	await runSync(phone, remote);
	await runSync(desktop, remote);
	await runSync(phone, remote);
	const lines = (dir: string) => get(dir, "reviews.jsonl")!.trim().split("\n").sort();
	assert.deepEqual(lines(desktop), lines(phone));
	assert.equal(lines(desktop).length, 3);
});
