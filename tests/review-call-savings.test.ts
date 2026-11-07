import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-review-savings-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");

const quiz = (id: string, q: string, answeredAt: string) => [
	{ role: "assistant", content: [{ type: "text", text: `Teaching for ${q}` }, { type: "toolCall", id, name: "quiz", arguments: {} }] },
	{
		role: "toolResult", toolCallId: id, toolName: "quiz",
		details: {
			kind: "quiz", questionText: q, options: [{ index: 1, label: "right" }, { index: 2, label: "wrong" }], dontKnow: false,
			answers: [{ label: "right", value: "x", index: 1 }], correctIndices: [1], explanation: "Because.", correct: true, confidence: 90, answeredAt,
		},
	},
];

test("new cards wait until their session is quiet, unless Reviews asks now", async () => {
	const { stores } = await import("../src/server/stores.ts");
	const { kickReviewChecks, reviewCounts, setReviewChecker } = await import("../src/server/reviews.ts");
	const calls: string[][] = [];
	setReviewChecker(async ({ cards }) => {
		calls.push(cards.map((c) => c.id));
		return cards.map((c) => ({ id: c.id, verdict: "ok" as const, notes: {} }));
	});
	const chat = stores.chatStore.createChat("Live lesson");
	const at = new Date().toISOString();
	stores.chatStore.saveMessages(chat.id, quiz("q1", "First?", at) as never);
	await kickReviewChecks();
	stores.chatStore.saveMessages(chat.id, [...quiz("q1", "First?", at), ...quiz("q2", "Second?", at)] as never);
	reviewCounts(); // the badges poll mid-lesson
	await kickReviewChecks();
	assert.deepEqual(calls, [], "nothing is checked while the lesson is going");
	await kickReviewChecks({ now: true });
	assert.deepEqual(calls, [[`${chat.id}:q1`, `${chat.id}:q2`]], "then both in one call");
	setReviewChecker(null);
});

test("v4 checks are brought up to date by one deck-wide duplicate pass; their checks stand", async () => {
	const { stores } = await import("../src/server/stores.ts");
	const { kickReviewChecks, reviewStatus, setReviewChecker, setDuplicateFinder } = await import("../src/server/reviews.ts");
	const { REVIEW_CHECK_VERSION, DUPLICATE_PASS_FROM, parseReviewChecks } = await import("../src/core/review.ts");
	const day = 86_400_000;
	const checksFile = path.join(process.env.LH_DATA_DIR!, "review-checks.jsonl");
	fs.rmSync(checksFile, { force: true });
	const a = stores.chatStore.createChat("Softmax");
	stores.chatStore.saveMessages(a.id, quiz("q1", "Temperature in softmax?", new Date(Date.now() - 9 * day).toISOString()) as never);
	const b = stores.chatStore.createChat("Attention");
	stores.chatStore.saveMessages(b.id, [
		...quiz("q2", "What does softmax temperature do?", new Date(Date.now() - 3 * day).toISOString()),
		...quiz("q3", "Bad key?", new Date(Date.now() - 3 * day).toISOString()),
	] as never);
	const [orig, repeat, held] = [`${a.id}:q1`, `${b.id}:q2`, `${b.id}:q3`];
	const v4 = (card: string, extra: object) => JSON.stringify({ card, at: "2030-01-01T00:00:00.000Z", v: DUPLICATE_PASS_FROM, notes: { "1": "n" }, context: `ctx ${card}`, ...extra });
	fs.mkdirSync(path.dirname(checksFile), { recursive: true });
	fs.writeFileSync(checksFile, [v4(orig, { verdict: "ok", concept: "Softmax" }), v4(repeat, { verdict: "ok", concept: "Temperature" }), v4(held, { verdict: "wrong", reason: "both right" })].join("\n") + "\n");
	const fullChecks: string[][] = [];
	setReviewChecker(async ({ cards }) => {
		fullChecks.push(cards.map((c) => c.id));
		return cards.map((c) => ({ id: c.id, verdict: "ok" as const, notes: {} }));
	});
	const passes: string[][] = [];
	// The model may name the pair either way round: the newer card is the repeat.
	setDuplicateFinder(async ({ cards }) => {
		passes.push(cards.map((c) => c.id));
		return [{ id: orig, duplicateOf: repeat }];
	});
	await kickReviewChecks({ now: true });
	const deckCalls = passes.filter((p) => p.includes(orig));
	assert.equal(deckCalls.length, 1, "one call for the deck");
	assert.ok(!deckCalls[0]!.includes(held), "held cards aren't in the deck");
	assert.ok(!fullChecks.some((ids) => ids.some((id) => [orig, repeat, held].includes(id))), "no full re-check of v4 cards");
	const checks = parseReviewChecks(fs.readFileSync(checksFile, "utf8"));
	assert.deepEqual([orig, repeat, held].map((id) => [checks.get(id)!.v, checks.get(id)!.verdict]), [
		[REVIEW_CHECK_VERSION, "ok"], [REVIEW_CHECK_VERSION, "duplicate"], [REVIEW_CHECK_VERSION, "wrong"],
	]);
	assert.equal(checks.get(repeat)!.duplicateOf, orig);
	assert.equal(checks.get(orig)!.context, `ctx ${orig}`, "the v4 check's content stands");
	assert.equal(checks.get(held)!.reason, "both right");
	assert.ok(reviewStatus().held.some((h) => h.id === repeat && h.verdict === "duplicate"));
	const before = passes.length;
	await kickReviewChecks({ now: true });
	assert.equal(passes.length, before, "nothing left to upgrade: no further pass");
	setReviewChecker(null);
	setDuplicateFinder(null);
});
