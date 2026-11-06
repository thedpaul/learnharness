import assert from "node:assert/strict";
import * as fs from "node:fs";
import type * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { runSync } from "../src/server/sync/engine.ts";
import { folderRemote } from "../src/server/sync/folder-remote.ts";
import { httpRemote, lanClient, type LanCall } from "../src/server/sync/http-remote.ts";
import { decodePairCode, encodePairCode, lanKey, newSecret, requestAad, seal, unseal } from "../src/server/sync/lan-crypto.ts";
import { createHubServer, listen } from "../src/server/sync/lan-hub.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lh-lan-"));
const put = (dir: string, rel: string, text: string) => {
	fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), text);
};
const get = (dir: string, rel: string) => {
	try { return fs.readFileSync(path.join(dir, rel), "utf-8"); } catch { return null; }
};

test("pairing code: round trip; junk and wrong lengths are refused", () => {
	const secret = newSecret();
	const text = encodePairCode({ hosts: ["192.168.1.20", "10.0.0.5"], port: 47321, secret });
	assert.match(text, /^lhsync:1:192\.168\.1\.20,10\.0\.0\.5:47321:[A-Za-z0-9_-]{43}$/);
	const back = decodePairCode(` ${text}\n`)!;
	assert.deepEqual(back.hosts, ["192.168.1.20", "10.0.0.5"]);
	assert.equal(back.port, 47321);
	assert.ok(back.secret.equals(secret));
	assert.equal(decodePairCode("https://example.com"), null);
	assert.equal(decodePairCode("lhsync:1:192.168.1.20:47321:short"), null);
	assert.equal(decodePairCode("lhsync:1:evil.example:47321:" + secret.toString("base64url")), null);
});

test("sealing: opens with the same key and aad only", () => {
	const key = lanKey(newSecret());
	const sealed = seal(key, Buffer.from("hello"), "req:1");
	assert.equal(unseal(key, sealed, "req:1").toString(), "hello");
	assert.throws(() => unseal(key, sealed, "req:2"));
	assert.throws(() => unseal(lanKey(newSecret()), sealed, "req:1"));
	const tampered = Buffer.from(sealed);
	tampered[14]! ^= 1;
	assert.throws(() => unseal(key, tampered, "req:1"));
});

test("folder remote: the engine syncs two devices through a plain folder", async () => {
	const hub = tmp();
	const a = tmp();
	const b = tmp();
	put(a, "chats/chat_a.json", '{"id":"a"}');
	put(a, "graph/nodes.jsonl", '{"id":"n1"}\n');
	await runSync(a, folderRemote(hub));
	await runSync(b, folderRemote(hub));
	assert.equal(get(b, "chats/chat_a.json"), '{"id":"a"}');
	put(b, "graph/nodes.jsonl", '{"id":"n1"}\n{"id":"n2"}\n');
	fs.rmSync(path.join(b, "chats/chat_a.json"));
	await runSync(b, folderRemote(hub));
	await runSync(a, folderRemote(hub));
	assert.equal(get(a, "graph/nodes.jsonl"), '{"id":"n1"}\n{"id":"n2"}\n');
	assert.equal(get(a, "chats/chat_a.json"), null);
	assert.deepEqual((await folderRemote(hub).list()).map((f) => f.path), ["graph/nodes.jsonl"]);
});

/** A desktop data dir with a running hub, the way lan.ts wires it. */
async function startHub(t: { after: (fn: () => void) => void }, opts: { now?: () => number } = {}) {
	const desktop = tmp();
	const hubDir = tmp();
	const secret = newSecret();
	const peers: string[] = [];
	let desktopSyncs = 0;
	const server: http.Server = createHubServer({
		secret,
		filesDir: path.join(hubDir, "files"),
		hubId: "hub-1",
		name: "test-desktop",
		syncDesktop: async () => {
			desktopSyncs++;
			await runSync(desktop, folderRemote(path.join(hubDir, "files")), undefined, { stateDir: path.join(hubDir, "state") });
		},
		onPeerSynced: (d) => peers.push(d),
		...opts,
	});
	const port = await listen(server, 0, "127.0.0.1");
	t.after(() => server.close());
	return { desktop, secret, port, peers, base: `http://127.0.0.1:${port}`, syncs: () => desktopSyncs };
}

async function phoneSync(phone: string, call: LanCall) {
	await call("begin");
	try {
		return await runSync(phone, httpRemote(call), undefined, { stateDir: path.join(phone, ".sync", "lan-client") });
	} finally {
		await call("end");
	}
}

test("phone ↔ computer over the hub: both sides' changes meet, sealed end to end", async (t) => {
	const hub = await startHub(t);
	const phone = tmp();
	const call = lanClient(hub.base, hub.secret, "Android phone");
	assert.deepEqual(await call("hello"), { hubId: "hub-1", name: "test-desktop" });

	put(hub.desktop, "chats/chat_d.json", '{"id":"d"}');
	put(hub.desktop, "reviews.jsonl", '{"card":"x","at":"1","correct":true}\n');
	put(phone, "chats/chat_p.json", '{"id":"p"}');
	put(phone, "reviews.jsonl", '{"card":"y","at":"2","correct":false}\n');
	await phoneSync(phone, call);

	assert.equal(get(phone, "chats/chat_d.json"), '{"id":"d"}');
	assert.equal(get(hub.desktop, "chats/chat_p.json"), '{"id":"p"}', "end pulls the phone's changes into the desktop data");
	assert.equal(get(phone, "reviews.jsonl"), get(hub.desktop, "reviews.jsonl"));
	assert.deepEqual(get(hub.desktop, "reviews.jsonl")!.trim().split("\n").sort(), [
		'{"card":"x","at":"1","correct":true}',
		'{"card":"y","at":"2","correct":false}',
	]);
	assert.deepEqual(hub.peers, ["Android phone"]);
	assert.equal(hub.syncs(), 2);

	// A deletion on the desktop reaches the phone next time.
	fs.rmSync(path.join(hub.desktop, "chats/chat_d.json"));
	await phoneSync(phone, call);
	assert.equal(get(phone, "chats/chat_d.json"), null);
});

test("hub: wrong secret, stale timestamp and replays get 401; file ops need begin", async (t) => {
	const hub = await startHub(t);
	await assert.rejects(lanClient(hub.base, newSecret(), "x")("hello"), /pair again/);
	await assert.rejects(lanClient(hub.base, hub.secret, "x", () => Date.now() - 10 * 60_000)("hello"), /pair again/);

	const ts = String(Date.now());
	const body = seal(lanKey(hub.secret), Buffer.from(JSON.stringify({ op: "hello" })), requestAad(ts));
	const send = () => fetch(`${hub.base}/rpc`, { method: "POST", headers: { "x-lh-ts": ts }, body: new Uint8Array(body) });
	assert.equal((await send()).status, 200);
	assert.equal((await send()).status, 401, "the same sealed request twice is a replay");
	assert.equal((await fetch(`${hub.base}/files`)).status, 404);

	const call = lanClient(hub.base, hub.secret, "phone");
	await assert.rejects(call("list"), /begin first/);
	await call("begin");
	await assert.rejects(lanClient(hub.base, hub.secret, "other")("begin"), /another device/);
	await assert.rejects(call("download", { path: "../auth.json" }), /bad path/);
	await call("end");
});
