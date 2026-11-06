/**
 * In-flight sharing pins (fluidity pass, 2026-11-06): overlapping reads of
 * one URL share one request and one parsed body; a read after the response
 * settles fetches fresh; failures carry no body.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { sharedGetJson } from "../components/shared-get.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function countingFetch(respond: () => Response) {
	const calls: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request) => {
		calls.push(String(input));
		return respond();
	}) as typeof fetch;
	return calls;
}

describe("sharedGetJson", () => {
	it("overlapping reads of one URL make one request and share the body", async () => {
		const calls = countingFetch(() => Response.json({ coverage: { totalMessages: 3 } }));
		const [a, b, c] = await Promise.all([
			sharedGetJson<{ coverage: unknown }>("/api/chats/x"),
			sharedGetJson<{ coverage: unknown }>("/api/chats/x"),
			sharedGetJson<{ coverage: unknown }>("/api/chats/x"),
		]);
		assert.equal(calls.length, 1);
		assert.equal(a.body, b.body);
		assert.equal(b.body, c.body);
		assert.deepEqual(a.body, { coverage: { totalMessages: 3 } });
	});

	it("a read after the response settles fetches fresh (no cache)", async () => {
		const calls = countingFetch(() => Response.json({ n: 1 }));
		await sharedGetJson("/api/settings");
		await sharedGetJson("/api/settings");
		assert.equal(calls.length, 2);
	});

	it("different URLs never share", async () => {
		const calls = countingFetch(() => Response.json({}));
		await Promise.all([sharedGetJson("/api/chats/a"), sharedGetJson("/api/chats/b")]);
		assert.deepEqual(calls.sort(), ["/api/chats/a", "/api/chats/b"]);
	});

	it("a failed response reports its status and carries no body", async () => {
		countingFetch(() => new Response("nope", { status: 404 }));
		assert.deepEqual(await sharedGetJson("/api/chats/gone"), { ok: false, status: 404, body: null });
	});

	it("a rejected fetch rejects every sharer, and the next read retries", async () => {
		let fail = true;
		const calls = countingFetch(() => {
			if (fail) throw new Error("offline");
			return Response.json({ ok: 1 });
		});
		const reads = [sharedGetJson("/api/chats/y"), sharedGetJson("/api/chats/y")];
		for (const r of reads) await assert.rejects(r, /offline/);
		fail = false;
		assert.deepEqual((await sharedGetJson("/api/chats/y")).body, { ok: 1 });
		assert.equal(calls.length, 2);
	});
});
