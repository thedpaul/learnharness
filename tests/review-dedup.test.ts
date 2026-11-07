import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { deckCards, duplicateAliases, foldDuplicates, parseReviewChecks, REVIEW_CHECK_VERSION, type ReviewCard } from "../src/core/review.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-review-dedup-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");

const check = (card: string, verdict: string, extra: Record<string, unknown> = {}) =>
	JSON.stringify({ card, at: "2030-01-01", v: REVIEW_CHECK_VERSION, verdict, ...extra });

test("duplicate chains resolve to the ok card standing for them; dead ends review as themselves", () => {
	const checks = parseReviewChecks([
		check("a", "ok"),
		check("b", "duplicate", { duplicateOf: "a" }),
		check("c", "duplicate", { duplicateOf: "b" }),
		check("d", "duplicate", { duplicateOf: "w" }),
		check("w", "wrong"),
		check("x", "duplicate", { duplicateOf: "y" }),
		check("y", "duplicate", { duplicateOf: "x" }),
		check("z", "duplicate"),
	].join("\n"));
	assert.deepEqual([...duplicateAliases(checks)].sort(), [["b", "a"], ["c", "a"]]);
	const card = (id: string, at: string, correct: boolean): ReviewCard =>
		({ id, chatId: "s", chatTitle: "S", questionText: id, options: [], correctIndices: [1], firstAnswer: { at, correct, confidence: 80 } }) as unknown as ReviewCard;
	const cards = ["a", "b", "c", "d", "w", "x", "y", "z"].map((id, i) => card(id, `2030-01-0${i + 1}`, true));
	const aliases = duplicateAliases(checks);
	assert.deepEqual(deckCards(cards, checks, aliases).map((c) => c.id), ["a", "d", "x", "y", "z"]);
	const folded = foldDuplicates(cards, [{ card: "b", at: "2030-02-01", correct: false }, { card: "a", at: "2030-02-02", correct: true }], aliases);
	assert.deepEqual(folded.filter((e) => e.card === "a").map((e) => e.at).sort(), ["2030-01-02", "2030-01-03", "2030-02-01", "2030-02-02"]);
	assert.ok(!folded.some((e) => e.card === "b" || e.card === "c"));
});

const quiz = (id: string, q: string, answeredAt: string, correct = true) => [
	{ role: "assistant", content: [{ type: "text", text: `Teaching for ${q}` }, { type: "toolCall", id, name: "quiz", arguments: {} }] },
	{
		role: "toolResult", toolCallId: id, toolName: "quiz",
		details: {
			kind: "quiz", questionText: q, options: [{ index: 1, label: "right" }, { index: 2, label: "wrong" }], dontKnow: false,
			answers: [{ label: correct ? "right" : "wrong", value: "x", index: correct ? 1 : 2 }], correctIndices: [1], explanation: "Because.",
			correct, confidence: 90, answeredAt,
		},
	},
];

test("the checker sees the older deck; the newer repeat leaves the queue and its answers count for the older card", async () => {
	const { stores } = await import("../src/server/stores.ts");
	const { reviewStatus, kickReviewChecks, setReviewChecker, recordReview, flaggedCards } = await import("../src/server/reviews.ts");
	type Result = import("../src/agent/subagents/card-checker.ts").CardCheckResult;
	const day = 86_400_000;
	const older = new Date(Date.now() - 10 * day).toISOString();
	const newer = new Date(Date.now() - 2 * day).toISOString();
	const a = stores.chatStore.createChat("Softmax");
	stores.chatStore.saveMessages(a.id, quiz("q1", "What does temperature do to softmax?", older) as never);
	const b = stores.chatStore.createChat("Attention");
	stores.chatStore.saveMessages(b.id, [...quiz("q2", "How does temperature change a softmax?", newer, false), ...quiz("q3", "Why scale by root d_k?", newer)] as never);
	const orig = `${a.id}:q1`;
	const repeat = `${b.id}:q2`;
	const keep = `${b.id}:q3`;

	const existingSeen: Record<string, string[]> = {};
	setReviewChecker(async ({ cards, existing }) => {
		for (const c of cards) existingSeen[c.id] = (existing ?? []).map((e) => e.id);
		return cards.map((c): Result => c.id === repeat
			? { id: c.id, verdict: "duplicate", duplicateOf: orig, concept: "Softmax temperature", notes: {} }
			// A "duplicate" of a NEWER card is not one: the older card is kept.
			: c.id === orig ? { id: c.id, verdict: "duplicate", duplicateOf: repeat, notes: {} }
			: { id: c.id, verdict: "ok", notes: {} });
	});
	await kickReviewChecks({ now: true });
	assert.deepEqual(existingSeen[orig], [], "nothing older than the first card");
	assert.ok(existingSeen[repeat]!.includes(orig), "the newer session's check sees the older card");

	const status = reviewStatus();
	assert.deepEqual(status.queue.map((q) => q.id).sort(), [orig, keep].sort());
	const origQ = status.queue.find((q) => q.id === orig)!;
	assert.deepEqual([origQ.reviews, origQ.box], [1, 0], "the repeat's missed first answer counts for the older card");
	assert.equal(status.total, 2);
	assert.deepEqual(status.held.map((h) => [h.id, h.verdict]), [[repeat, "duplicate"]]);
	assert.match(status.held[0]!.reason!, /^Same as “What does temperature do to softmax\?” in Softmax$/);
	assert.deepEqual(flaggedCards().map((f) => f.check.verdict), ["duplicate"]);
	assert.equal(recordReview(repeat, [1], 50), null, "the repeat isn't reviewed on its own");
	assert.ok(recordReview(orig, [1], 90));
	setReviewChecker(null);
});
