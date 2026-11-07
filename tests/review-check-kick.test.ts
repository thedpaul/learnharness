import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// The services read their paths at import: a scratch data dir.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-kick-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");

test("a check run with nothing to do doesn't block the next one", async () => {
	const { stores } = await import("../src/server/stores.ts");
	const { kickReviewChecks, reviewStatus, setReviewChecker } = await import("../src/server/reviews.ts");
	const checked: string[] = [];
	setReviewChecker(async ({ cards }) => {
		checked.push(...cards.map((c) => c.id));
		return cards.map((c) => ({ id: c.id, verdict: "ok" as const, notes: {} }));
	});
	await kickReviewChecks(); // nothing to check yet: settles synchronously

	const chat = stores.chatStore.createChat("Later");
	stores.chatStore.saveMessages(chat.id, [
		{ role: "assistant", content: [{ type: "text", text: "Teaching" }, { type: "toolCall", id: "q1", name: "quiz", arguments: {} }] },
		{
			role: "toolResult", toolCallId: "q1", toolName: "quiz",
			details: {
				kind: "quiz", questionText: "Q?", options: [{ index: 1, label: "a" }, { index: 2, label: "b" }], dontKnow: false,
				answers: [{ label: "a", value: "a", index: 1 }], correctIndices: [1], correct: true, confidence: 80, answeredAt: new Date().toISOString(),
			},
		},
	] as never);
	await kickReviewChecks({ now: true });
	assert.deepEqual(checked, [`${chat.id}:q1`]);
	assert.equal(reviewStatus().total, 1);
	setReviewChecker(null);
});
