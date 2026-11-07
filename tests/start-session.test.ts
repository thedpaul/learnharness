import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { ChatStore, JobStore } from "../src/core/ports.ts";

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lh-start-session-")));
const prior = process.env.LH_DATA_DIR;
process.env.LH_DATA_DIR = path.join(root, "data");
after(async () => {
	if (prior === undefined) delete process.env.LH_DATA_DIR;
	else process.env.LH_DATA_DIR = prior;
	await fs.rm(root, { recursive: true, force: true });
});

const { createProberTools, createTeacherTools } = await import("../src/agent/tools.ts");
const { practiceTools } = await import("../src/agent/tools/practice.ts");
const { startSessionTool } = await import("../src/agent/tools/start-session.ts");
const { composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { startedSession } = await import("../components/artifacts/start-session-card.tsx");

const details = (r: { details: unknown }) => r.details as Record<string, unknown>;

describe("start_session", () => {
	it("creates one session of the caller's kind per turn, with the request kept for the composer", async () => {
		const made: Array<[string, string | undefined]> = [];
		const createSession = (title: string, kind?: "practice") => { made.push([title, kind]); return { id: `chat_${made.length}`, title }; };
		const teach = startSessionTool({ kind: "teach", createSession });
		const first = details(await teach.execute!("c1", { topic: " Fourier transforms ", message: " I want to learn Fourier transforms " }));
		assert.deepEqual(first, { ok: true, id: "chat_1", title: "Fourier transforms", message: "I want to learn Fourier transforms", note: first.note });
		const second = details(await teach.execute!("c2", { topic: "Other", message: "x" }));
		assert.equal(second.ok, false);
		assert.match(String(second.error), /already started/);
		const practice = startSessionTool({ kind: "practice", createSession });
		await practice.execute!("c3", { topic: "Graphs", message: "Give me graph problems" });
		assert.deepEqual(made, [["Fourier transforms", undefined], ["Graphs", "practice"]]);
	});

	it("is registered for prober, teacher and practice only when the factory is wired", () => {
		const ctx = { chatId: "c", chatStore: { getChat: () => null } as unknown as ChatStore,
			jobStore: {} as unknown as JobStore, spawn: () => {}, deliver: () => {} };
		const createSession = () => ({ id: "chat_x", title: "x" });
		for (const tools of [createProberTools(ctx), createTeacherTools(ctx), practiceTools(ctx)]) assert.equal(tools.start_session, undefined);
		for (const tools of [createProberTools({ ...ctx, createSession }), createTeacherTools({ ...ctx, createSession }), practiceTools({ ...ctx, createSession })]) {
			assert.equal(tools.start_session?.name, "start_session");
		}
	});

	it("the card only trusts a successful result with a safe id", () => {
		assert.deepEqual(startedSession({ ok: true, id: "chat_a1", title: "T", message: "m" }), { id: "chat_a1", title: "T", message: "m" });
		assert.equal(startedSession({ ok: false, error: "no" }), null);
		assert.equal(startedSession({ ok: true, id: "../x" }), null);
		assert.equal(startedSession(undefined), null);
	});

	it("every agent is told about new topics; the teacher also about follow-up rounds", () => {
		for (const kind of ["prober", "teacher", "practice"] as const) assert.match(composeInstructions(kind), /start_session/);
		assert.match(composeInstructions("teacher"), /After the goal lands/);
		assert.doesNotMatch(composeInstructions("prober"), /After the goal lands/);
	});
});
