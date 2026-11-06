import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// The service reads its paths at import: a scratch data dir.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-review-version-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");

const quiz = (id: string, answeredAt: string) => [
	{ role: "assistant", content: [{ type: "text", text: "Teaching." }, { type: "toolCall", id, name: "quiz", arguments: {} }] },
	{
		role: "toolResult",
		toolCallId: id,
		toolName: "quiz",
		details: {
			kind: "quiz",
			questionText: "What is the scale factor?",
			options: [{ index: 1, label: "right" }, { index: 2, label: "wrong" }],
			dontKnow: false,
			answers: [{ label: "right", value: "right", index: 1 }],
			correctIndices: [1],
			correct: true,
			confidence: 80,
			answeredAt,
		},
	},
];

test("check version: an older check keeps the card reviewable and is re-checked once", async () => {
	const { stores } = await import("../src/server/stores.ts");
	const { kickReviewChecks, reviewStatus, setReviewChecker } = await import("../src/server/reviews.ts");
	const { REVIEW_CHECK_VERSION } = await import("../src/core/review.ts");
	type CardResult = import("../src/agent/subagents/card-checker.ts").CardCheckResult;

	const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
	const chat = stores.chatStore.createChat("Attention");
	stores.chatStore.saveMessages(chat.id, quiz("q1", old) as never);
	const id = `${chat.id}:q1`;
	const checks = path.join(process.env.LH_DATA_DIR!, "review-checks.jsonl");
	fs.mkdirSync(path.dirname(checks), { recursive: true });
	fs.writeFileSync(checks, `${JSON.stringify({ card: id, at: old, v: REVIEW_CHECK_VERSION - 1, verdict: "ok", notes: { "1": "Variance is d_k" } })}\n`);

	const calls: string[][] = [];
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	setReviewChecker(async ({ cards }) => {
		calls.push(cards.map((c) => c.id));
		await gate;
		return cards.map((c): CardResult => ({ id: c.id, verdict: "ok", notes: { "1": "Variance is $d_k$" } }));
	});

	// While the re-check runs, the card is still in the deck.
	const running = kickReviewChecks();
	assert.equal(reviewStatus().total, 1, "the older check still counts");
	release();
	await running;
	assert.deepEqual(calls, [[id]], "the stale card was re-checked");

	const lines = fs.readFileSync(checks, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { v: number; notes?: Record<string, string> });
	assert.equal(lines.at(-1)!.v, REVIEW_CHECK_VERSION);
	await kickReviewChecks();
	assert.equal(calls.length, 1, "a current check is not re-checked again");
	assert.equal(reviewStatus().total, 1);
	setReviewChecker(null);
});
