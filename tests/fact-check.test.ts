import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// The services read their paths at import: a scratch data dir.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-facts-"));
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
			correct: true,
			confidence: 90,
			answeredAt,
		},
	},
];

test("recheck: false graph facts are corrected, and every card (checked ones too) is rechecked with the fix", async () => {
	const { stores } = await import("../src/server/stores.ts");
	const { getGraph } = await import("../src/core/graph.ts");
	const { runRecheck, setFactChecker, recheckStatus } = await import("../src/server/fact-check.ts");
	const { kickReviewChecks, reviewStatus, setReviewChecker } = await import("../src/server/reviews.ts");
	type CardResult = import("../src/agent/subagents/card-checker.ts").CardCheckResult;
	type FactResult = import("../src/agent/subagents/fact-checker.ts").FactCheckResult;

	const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
	const chat = stores.chatStore.createChat("Planets");
	stores.chatStore.saveMessages(chat.id, quiz("q1", "How many planets?", old) as never);
	const node = (id: string, statement: string) => ({ id, name: id, statement, aliases: [], createdAt: old, provenance: [{ chatId: chat.id, messageId: "m1" }] });
	stores.graphStore.appendNode(node("n_pluto", "The solar system has nine planets."));
	stores.graphStore.appendNode(node("n_sun", "The Sun is a star."));

	// The first check: the card passes.
	const cardCalls: { ids: string[]; corrections?: string[] }[] = [];
	setReviewChecker(async ({ cards, corrections }) => {
		cardCalls.push({ ids: cards.map((c) => c.id), corrections });
		return cards.map((c): CardResult => ({ id: c.id, verdict: corrections?.length ? "wrong" : "ok", notes: {} }));
	});
	await kickReviewChecks();
	assert.equal(reviewStatus().total, 1);

	const factCalls: string[][] = [];
	setFactChecker(async ({ facts }) => {
		factCalls.push(facts.map((f) => f.id));
		return facts.map((f): FactResult => f.id === "n_pluto"
			? { id: f.id, verdict: "false", name: "Eight planets", statement: "The solar system has eight planets.", reason: "Pluto was reclassified in 2006." }
			: { id: f.id, verdict: "ok" });
	});

	await runRecheck({ force: true });
	const last = recheckStatus().last!;
	assert.equal(last.error, undefined);
	assert.equal(last.checked, 2);
	assert.deepEqual(last.corrected.map((c) => c.name), ["Eight planets"]);
	const pluto = getGraph(stores.graphStore).nodes.find((n) => n.id === "n_pluto")!;
	assert.equal(pluto.statement, "The solar system has eight planets.");
	assert.equal(pluto.name, "Eight planets");
	assert.ok(!pluto.aliases.includes("The solar system has nine planets."), "the false statement is gone");
	assert.equal(getGraph(stores.graphStore).nodes.length, 2, "a correction adds no node");

	// The already-checked card was checked again, with the correction.
	assert.equal(cardCalls.length, 2);
	assert.match(cardCalls[1]!.corrections![0]!, /nine planets.*eight planets/);
	assert.equal(reviewStatus().total, 0);
	assert.equal(reviewStatus().held.length, 1);

	// Not forced: everything is inside the window, so nothing is checked again.
	await runRecheck();
	assert.equal(factCalls.length, 1);
	assert.equal(cardCalls.length, 2);
	setFactChecker(null);
	setReviewChecker(null);
});
