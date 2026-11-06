import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// The service reads its paths at import: a scratch data dir.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-reviews-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");

const quiz = (id: string, q: string, answeredAt: string) => [
	{ role: "assistant", content: [{ type: "text", text: `Teaching for ${q}` }, { type: "toolCall", id, name: "quiz", arguments: {} }] },
	{
		role: "toolResult",
		toolCallId: id,
		toolName: "quiz",
		details: {
			kind: "quiz",
			questionText: q,
			options: [{ index: 1, label: "right" }, { index: 2, label: "wrong" }],
			dontKnow: false,
			answers: [{ label: "right", value: "right", index: 1 }],
			correctIndices: [1],
			explanation: "Because.",
			correct: true,
			confidence: 90,
			answeredAt,
		},
	},
];

test("reviews: only checked-ok cards queue, by topic; answers update the counts", async () => {
	const { stores } = await import("../src/server/stores.ts");
	const { reviewStatus, reviewCounts, recordReview, kickReviewChecks, setReviewChecker } = await import("../src/server/reviews.ts");
	type Result = import("../src/agent/subagents/card-checker.ts").CardCheckResult;

	const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
	const a = stores.chatStore.createChat("Loops");
	stores.chatStore.saveMessages(a.id, [...quiz("q1", "What does the loop above print?", old), ...quiz("q2", "Bad key?", old)] as never);
	const b = stores.chatStore.createChat("Sets");
	stores.chatStore.saveMessages(b.id, quiz("q3", "Union?", old) as never);

	const seen: string[][] = [];
	setReviewChecker(async ({ cards }) => {
		seen.push(cards.map((c) => c.id));
		assert.ok(cards.every((c) => c.lead?.startsWith("Teaching for")), "the checker sees the teaching");
		return cards.map((c): Result => c.id.endsWith(":q2")
			? { id: c.id, verdict: "wrong" as const, reason: "Both options are right.", notes: {} }
			: { id: c.id, verdict: "ok" as const, ...(c.id.endsWith(":q1") ? { context: "```\nfor i in range(3): print(i)\n```" } : {}), notes: { "1": "yes", "2": "no" } });
	});

	// Unchecked: nothing queues yet; the check runs in the background.
	assert.equal(reviewStatus().pending, 3);
	assert.equal(reviewStatus().due, 0);
	await kickReviewChecks();
	assert.equal(seen.length, 2, "one batch per session");

	const all = reviewStatus();
	assert.equal(all.pending, 0);
	assert.equal(all.due, 2);
	assert.deepEqual(all.held.map((h) => [h.questionText, h.verdict, h.reason]), [["Bad key?", "wrong", "Both options are right."]]);
	assert.deepEqual(all.topics.map((t) => [t.title, t.due]).sort(), [["Loops", 1], ["Sets", 1]]);
	const q1 = all.queue.find((q) => q.questionText.startsWith("What does"))!;
	assert.match(q1.context!, /range\(3\)/);
	assert.ok(!("correctIndices" in q1) && !JSON.stringify(q1).includes("yes"), "no answers or notes before answering");

	const loops = reviewStatus(new Date(), { topic: a.id });
	assert.deepEqual(loops.queue.map((q) => q.id), [q1.id]);

	const result = recordReview(q1.id, [1], 70)!;
	assert.equal(result.correct, true);
	assert.deepEqual(result.notes, { "1": "yes", "2": "no" });
	assert.equal(reviewCounts().due, 1);
	assert.equal(reviewStatus(new Date(), { topic: a.id }).due, 0);
	assert.equal(recordReview(`${a.id}:q2`, [1], 50), null, "a held card can't be answered");

	// Reset: recent reviews are dropped (by topic, by period); the card comes due again.
	const { resetReviews } = await import("../src/server/reviews.ts");
	const q3 = `${b.id}:q3`;
	recordReview(q3, [1], 80);
	assert.equal(reviewCounts().due, 0);
	assert.deepEqual(resetReviews(30, { topic: a.id }), { removed: 1 });
	assert.equal(reviewStatus(new Date(), { topic: a.id }).due, 1, "the Loops card is due again");
	assert.equal(reviewStatus(new Date(), { topic: b.id }).due, 0, "other topics keep their reviews");
	assert.deepEqual(resetReviews(30, {}, new Date(Date.now() + 40 * 86_400_000)), { removed: 0 }, "older than the period: kept");
	assert.deepEqual(resetReviews(null), { removed: 1 });
	assert.equal(reviewCounts().due, 2);
	setReviewChecker(null);
});
