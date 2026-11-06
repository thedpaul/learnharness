import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// The service reads its paths at import: point them at a scratch phone.
const phone = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lan-svc-"));
process.env.LH_DATA_DIR = path.join(phone, "data");
process.env.LH_AUTH_FILE = path.join(phone, "auth.json");

test("phone service: every sync runs (the slot is released), status settles", async (t) => {
	const { runSync } = await import("../src/server/sync/engine.ts");
	const { folderRemote } = await import("../src/server/sync/folder-remote.ts");
	const { createHubServer, listen } = await import("../src/server/sync/lan-hub.ts");
	const { encodePairCode, newSecret } = await import("../src/server/sync/lan-crypto.ts");
	const { pairWith, syncNow, syncStatus } = await import("../src/server/sync/index.ts");

	const desktop = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lan-desk-"));
	const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-lan-hub-"));
	const secret = newSecret();
	let peerSyncs = 0;
	const server = createHubServer({
		secret,
		filesDir: path.join(hubDir, "files"),
		hubId: "hub-svc",
		name: "desk",
		syncDesktop: async () => { await runSync(desktop, folderRemote(path.join(hubDir, "files")), undefined, { stateDir: path.join(hubDir, "state") }); },
		onPeerSynced: () => { peerSyncs++; },
	});
	const port = await listen(server, 0, "127.0.0.1");
	t.after(() => server.close());

	await pairWith(encodePairCode({ hosts: ["127.0.0.1"], port, secret }));
	fs.mkdirSync(path.join(desktop, "chats"), { recursive: true });
	fs.writeFileSync(path.join(desktop, "chats", "chat_one.json"), '{"id":"one"}');
	await syncNow();
	assert.equal((await syncStatus()).running, false);

	fs.writeFileSync(path.join(desktop, "chats", "chat_two.json"), '{"id":"two"}');
	await syncNow();
	assert.equal(peerSyncs, 2, "the second sync really ran");
	assert.ok(fs.existsSync(path.join(phone, "data", "chats", "chat_two.json")));
	const status = await syncStatus();
	assert.equal(status.running, false);
	assert.equal(status.lan.client.paired, true);
	assert.equal(status.lan.client.lastError, null);
});
