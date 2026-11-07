import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { extractReviewCards, scheduleCard, REVIEW_BOX_DAYS } from "../src/core/review.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-review-practice-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");

const DAY = 86_400_000;
const pose = (id: string, statement: string, t: number) => [
	{ role: "assistant", content: [{ type: "text", text: `Setup for ${statement}` }, { type: "toolCall", id, name: "problem", arguments: { statement, mode: "recall", modelSolution: `Solution of ${statement}` } }], timestamp: t },
	{ role: "toolResult", toolCallId: id, toolName: "problem", isError: false, content: [], timestamp: t },
];
const conclude = (id: string, outcome: string, t: number, isError = false) => [
	{ role: "user", content: "my answer", timestamp: t - 1 },
	{ role: "assistant", content: [{ type: "toolCall", id, name: "conclude", arguments: { outcome, verdict: "v", rung: null, missClass: null, retest: false } }], timestamp: t },
	{ role: "toolResult", toolCallId: id, toolName: "conclude", isError, content: [], timestamp: t },
];

test("every concluded practice problem but a dismissal becomes a card; the outcome is the first answer", () => {
	const t = Date.parse("2030-01-01T10:00:00Z");
	const messages = [
		...pose("p1", "Solve A", t), ...conclude("c1", "solved", t + 1000),
		...pose("p2", "Solve B", t + 2000), ...conclude("c2", "solvedWithHints", t + 3000),
		...pose("p3", "Solve C", t + 4000), ...conclude("c3", "surrendered", t + 5000),
		...pose("p4", "Solve D", t + 6000), ...conclude("c4", "dismissed", t + 7000),
		...pose("p5", "Solve E", t + 8000), ...conclude("c5", "solved", t + 9000, true),
		...pose("p6", "Solve F", t + 10_000),
	];
	const cards = extractReviewCards("chat_p", "Practice", messages);
	assert.deepEqual(cards.map((c) => [c.id, c.kind, c.questionText, c.firstAnswer.correct, !!c.firstAnswer.hinted]), [
		["chat_p:p1", "problem", "Solve A", true, false],
		["chat_p:p2", "problem", "Solve B", true, true],
		["chat_p:p3", "problem", "Solve C", false, false],
	]);
	assert.equal(cards[0]!.solution, "Solution of Solve A");
	assert.equal(cards[0]!.firstAnswer.at, new Date(t + 1000).toISOString());
	assert.match(cards[0]!.lead!, /Setup for Solve A/);
	// Solved with hints: right, but the interval is halved.
	const now = new Date(t);
	assert.equal(Date.parse(scheduleCard(cards[0]!, [], now).dueAt) - (t + 1000), REVIEW_BOX_DAYS[0] * DAY);
	assert.equal(Date.parse(scheduleCard(cards[1]!, [], now).dueAt) - (t + 3000), REVIEW_BOX_DAYS[0] * DAY * 0.5);
});

test("practice cards are checked with their solution, queue with it, and take a self-grade", async () => {
	const { stores } = await import("../src/server/stores.ts");
	const { reviewStatus, kickReviewChecks, setReviewChecker, recordReview } = await import("../src/server/reviews.ts");
	const t = Date.now() - 5 * DAY;
	const chat = stores.chatStore.createChat("Integrals", "practice");
	stores.chatStore.saveMessages(chat.id, [...pose("p1", "Integrate x", t), ...conclude("c1", "movedOn", t + 1000)] as never);
	const seen: Array<string | undefined> = [];
	setReviewChecker(async ({ cards }) => {
		seen.push(...cards.map((c) => c.solution));
		return cards.map((c) => ({ id: c.id, verdict: "ok" as const, notes: {} }));
	});
	await kickReviewChecks({ now: true });
	assert.deepEqual(seen, ["Solution of Integrate x"]);
	const q = reviewStatus().queue.find((x) => x.chatId === chat.id)!;
	assert.deepEqual([q.kind, q.solution, q.options], ["problem", "Solution of Integrate x", []]);
	assert.equal(recordReview(q.id, [1], 50), null, "a problem takes a self-grade, not options");
	const r = recordReview(q.id, true, 70)!;
	assert.equal(r.correct, true);
	assert.equal(reviewStatus().queue.some((x) => x.id === q.id), false);
	setReviewChecker(null);
});
