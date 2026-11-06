import assert from "node:assert/strict";
import { test } from "node:test";
import {
	calibration,
	checkedCard,
	dueCards,
	extractReviewCards,
	parseReviewChecks,
	parseReviewLedger,
	REVIEW_BOX_DAYS,
	REVIEW_CHECK_VERSION,
	scheduleCard,
	streakDays,
	type ReviewCard,
} from "../src/core/review.ts";

const answer = (over: Record<string, unknown> = {}) => ({
	kind: "quiz",
	tool: "quiz",
	questionText: "2 + 2?",
	options: [
		{ index: 1, label: "3" },
		{ index: 2, label: "4" },
	],
	dontKnow: false,
	answers: [{ label: "4", value: "b", index: 2 }],
	correctIndices: [2],
	explanation: "Count.",
	correct: true,
	confidence: 80,
	answeredAt: "2030-01-01T10:00:00.000Z",
	...over,
});

const transcript = (details: unknown, toolCallId = "call_1") => [
	{ role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "quiz", arguments: { nodeId: "add" } }] },
	{ role: "toolResult", toolCallId, toolName: "quiz", details },
];

test("cards: one per graded quiz answer, with the plan node and the session answer", () => {
	const [card, ...rest] = extractReviewCards("chat_a", "Arithmetic", transcript(answer()));
	assert.equal(rest.length, 0);
	assert.equal(card!.id, "chat_a:call_1");
	assert.equal(card!.nodeId, "add");
	assert.deepEqual(card!.correctIndices, [2]);
	assert.deepEqual(card!.firstAnswer, { at: "2030-01-01T10:00:00.000Z", correct: true, confidence: 80 });
});

test("cards: dismissed, ungraded and non-quiz answers are skipped; I-don't-know has no confidence", () => {
	assert.equal(extractReviewCards("c", "t", transcript(answer({ dismissed: true }))).length, 0);
	assert.equal(extractReviewCards("c", "t", transcript(answer({ correctIndices: [] }))).length, 0);
	assert.equal(extractReviewCards("c", "t", transcript(answer({ kind: "explain" }))).length, 0);
	const [idk] = extractReviewCards("c", "t", transcript(answer({ dontKnow: true, correct: false, confidence: 50 })));
	assert.equal(idk!.firstAnswer.confidence, undefined);
	assert.equal(idk!.firstAnswer.correct, false);
});

const card = (first: Partial<ReviewCard["firstAnswer"]> = {}): ReviewCard => ({
	id: "c:1",
	chatId: "c",
	chatTitle: "t",
	questionText: "q",
	options: [],
	correctIndices: [1],
	firstAnswer: { at: "2030-01-01T00:00:00.000Z", correct: true, confidence: 90, ...first },
});
const days = (n: number) => new Date(Date.parse("2030-01-01T00:00:00.000Z") + n * 86_400_000);

test("schedule: correct answers climb the boxes, a wrong one starts over", () => {
	const c = card();
	assert.equal(scheduleCard(c, [], days(0)).box, 0);
	assert.equal(scheduleCard(c, [], days(0)).dueAt, days(REVIEW_BOX_DAYS[0]).toISOString());
	assert.equal(scheduleCard(c, [], days(1)).due, true);
	const events = [
		{ card: "c:1", at: days(1).toISOString(), correct: true, confidence: 90 },
		{ card: "c:1", at: days(4).toISOString(), correct: true, confidence: 90 },
	];
	const s = scheduleCard(c, events, days(5));
	assert.equal(s.box, 2);
	assert.equal(s.dueAt, days(4 + REVIEW_BOX_DAYS[2]).toISOString());
	assert.equal(s.due, false);
	assert.equal(s.reviews, 2);
	const wrong = scheduleCard(c, [...events, { card: "c:1", at: days(11).toISOString(), correct: false, confidence: 90 }], days(11));
	assert.equal(wrong.box, 0);
	assert.equal(wrong.dueAt, days(12).toISOString());
});

test("schedule: right but unsure halves the interval; other cards' events are ignored", () => {
	const s = scheduleCard(card({ confidence: 30 }), [{ card: "other", at: days(9).toISOString(), correct: false }], days(0));
	assert.equal(s.dueAt, days(0.5).toISOString());
	assert.equal(s.lastAt, days(0).toISOString());
});

test("due cards: only the due ones, most overdue first", () => {
	const a = { ...card(), id: "a" };
	const b = { ...card({ at: days(-5).toISOString() }), id: "b" };
	const c = { ...card({ at: days(30).toISOString() }), id: "c" };
	assert.deepEqual(dueCards([a, b, c], [], days(2)).map((x) => x.id), ["b", "a"]);
});

test("calibration: bins, Brier score and bias", () => {
	const cal = calibration([
		{ at: "x", correct: true, confidence: 90 },
		{ at: "x", correct: false, confidence: 90 },
		{ at: "x", correct: true, confidence: 52 },
		{ at: "x", correct: false }, // I don't know: not rated
	]);
	assert.equal(cal.count, 3);
	assert.deepEqual(cal.bins, [
		{ confidence: 50, count: 1, accuracy: 1 },
		{ confidence: 90, count: 2, accuracy: 0.5 },
	]);
	assert.ok(Math.abs(cal.brier! - (0.01 + 0.81 + 0.2304) / 3) < 1e-9);
	assert.ok(Math.abs(cal.bias! - ((90 + 90 + 52) / 3 - 200 / 3)) < 1e-9);
	assert.deepEqual(calibration([]), { bins: [], count: 0, brier: null, bias: null });
});

test("streak: consecutive local days, today optional", () => {
	const now = new Date("2030-01-10T12:00:00.000Z");
	const t = (d: string) => `${d}T12:00:00.000Z`;
	assert.equal(streakDays([t("2030-01-10"), t("2030-01-09"), t("2030-01-08"), t("2030-01-06")], now, 0), 3);
	assert.equal(streakDays([t("2030-01-09"), t("2030-01-08")], now, 0), 2);
	assert.equal(streakDays([t("2030-01-07")], now, 0), 0);
	// 23:30 UTC on the 9th is already the 10th at UTC+1 (offset -60).
	assert.equal(streakDays(["2030-01-09T23:30:00.000Z"], now, -60), 1);
});

test("ledger: valid lines parse, torn lines are skipped", () => {
	const text = '{"card":"a","at":"t","correct":true,"confidence":70}\n{"card":"b","at"\n\n{"card":"c","at":"t","correct":false}\n';
	assert.deepEqual(parseReviewLedger(text), [
		{ card: "a", at: "t", correct: true, confidence: 70 },
		{ card: "c", at: "t", correct: false, confidence: undefined },
	]);
});

test("cards: the teaching since the learner last spoke is the lead; option notes ride along", () => {
	const messages = [
		{ role: "user", content: [{ type: "text", text: "old question" }] },
		{ role: "assistant", content: [{ type: "text", text: "Here is a loop:\n```\nfor i in range(3): print(i)\n```" }] },
		{ role: "user", content: [{ type: "text", text: "ok" }] },
		{ role: "assistant", content: [
			{ type: "text", text: "It prints each i." },
			{ type: "toolCall", id: "call_1", name: "quiz", arguments: {} },
		] },
		{ role: "toolResult", toolCallId: "call_1", toolName: "quiz", details: answer({ options: [{ index: 1, label: "3", note: "counts from 1" }, { index: 2, label: "4" }] }) },
	];
	const [card] = extractReviewCards("c", "t", messages);
	assert.equal(card!.lead, "It prints each i.");
	assert.deepEqual(card!.options[0], { index: 1, label: "3", note: "counts from 1" });
});

test("checks: newest current-version line wins; checkedCard adds context and fills missing notes", () => {
	const text = [
		JSON.stringify({ card: "a", at: "2030-01-01", v: REVIEW_CHECK_VERSION, verdict: "unclear", reason: "vague" }),
		JSON.stringify({ card: "a", at: "2030-01-02", v: REVIEW_CHECK_VERSION, verdict: "ok", context: "Given `x = 2`.", notes: { "1": "n1", "2": "n2" } }),
		JSON.stringify({ card: "b", at: "2030-01-03", v: REVIEW_CHECK_VERSION + 1, verdict: "ok" }),
		"{torn",
	].join("\n");
	const checks = parseReviewChecks(text);
	assert.equal(checks.size, 1);
	assert.equal(checks.get("a")!.verdict, "ok");
	const c = checkedCard({ ...card(), options: [{ index: 1, label: "x", note: "own" }, { index: 2, label: "y" }] }, checks.get("a"));
	assert.equal(c.context, "Given `x = 2`.");
	assert.deepEqual(c.options.map((o) => o.note), ["own", "n2"]);
});

test("review settings: parse, schedule times, pause, today's count", async () => {
	const { parseReviewSettings, reviewSettingsOf, nextReviewTime, lastReviewTime, remindersPaused, reviewsToday, DEFAULT_REVIEW_SETTINGS } = await import("../src/core/review.ts");
	assert.deepEqual(reviewSettingsOf(null), DEFAULT_REVIEW_SETTINGS);
	assert.equal(parseReviewSettings({ maxPerDay: -1 }), null);
	assert.equal(parseReviewSettings({ schedule: { days: [7], time: "09:00" } }), null);
	assert.equal(parseReviewSettings({ schedule: { days: [1], time: "9:00" } }), null);
	const s = parseReviewSettings({ maxPerDay: 20, schedule: { days: [5, 1, 1], time: "18:30" }, notify: true })!;
	assert.deepEqual(s.schedule, { days: [1, 5], time: "18:30" });

	// Local time: Wednesday 2026-11-04 12:00 → Friday 18:30; last slot Monday 18:30.
	const wed = new Date(2026, 10, 4, 12, 0);
	const next = nextReviewTime(s.schedule, wed)!;
	assert.deepEqual([next.getDay(), next.getHours(), next.getMinutes()], [5, 18, 30]);
	const last = lastReviewTime(s.schedule, wed)!;
	assert.deepEqual([last.getDay(), last.getDate()], [1, 2]);
	assert.equal(nextReviewTime(null, wed), null);

	const paused = { ...s, pausedUntil: new Date(2026, 10, 10).toISOString() };
	assert.equal(remindersPaused(paused, wed), true);
	assert.equal(remindersPaused(paused, new Date(2026, 10, 11)), false);
	assert.equal(parseReviewSettings({ pausedUntil: "soon" }), null);

	const at = (h: number, d = 4) => new Date(2026, 10, d, h).toISOString();
	assert.equal(reviewsToday([{ card: "a", at: at(1), correct: true }, { card: "b", at: at(11), correct: false }, { card: "c", at: at(23, 3), correct: true }], wed), 2);
});
