import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, test } from "node:test";
import { mixedOrder, parseTopicFields, relatedTopics } from "../src/core/review.ts";

// The services read their paths at import: a scratch data dir.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-mix-"));
process.env.LH_DATA_DIR = path.join(dir, "data");
process.env.LH_AUTH_FILE = path.join(dir, "auth.json");

describe("related topics", () => {
	it("the newest labelling per topic wins; bad lines are skipped", () => {
		const text = [
			JSON.stringify({ topic: "a", fields: ["Old"], at: "2026-01-01T00:00:00Z" }),
			"not json",
			JSON.stringify({ topic: "a", fields: ["Machine learning", " ", 3], at: "2026-02-01T00:00:00Z" }),
			JSON.stringify({ topic: "b", fields: "nope", at: "2026-02-01T00:00:00Z" }),
		].join("\n");
		assert.deepEqual([...parseTopicFields(text)], [["a", ["Machine learning"]]]);
	});

	it("topics sharing any field are related, ignoring case and punctuation", () => {
		const fields = new Map([
			["mdlm", ["Machine learning", "Probability"]],
			["moe", ["machine-learning"]],
			["stats", ["Probability"]],
			["linux", ["Linux and systems"]],
		]);
		assert.deepEqual(relatedTopics("mdlm", fields), ["moe", "stats"]);
		assert.deepEqual(relatedTopics("moe", fields), ["mdlm"]);
		assert.deepEqual(relatedTopics("linux", fields), []);
		assert.deepEqual(relatedTopics("unknown", fields), []);
	});

	it("a mixed order is a seeded permutation", () => {
		const cards = Array.from({ length: 12 }, (_, i) => i);
		const a = mixedOrder(cards, "seed");
		assert.deepEqual(a, mixedOrder(cards, "seed"));
		assert.deepEqual([...a].sort((x, y) => x - y), cards);
		assert.notDeepEqual(a, cards);
	});
});

const quiz = (id: string, q: string, answeredAt: string) => [
	{ role: "assistant", content: [{ type: "text", text: `Teaching for ${q}` }, { type: "toolCall", id, name: "quiz", arguments: {} }] },
	{
		role: "toolResult",
		toolCallId: id,
		toolName: "quiz",
		details: {
			kind: "quiz", questionText: q, options: [{ index: 1, label: "right" }, { index: 2, label: "wrong" }],
			dontKnow: false, answers: [{ label: "right", value: "right", index: 1 }], correctIndices: [1], correct: false, confidence: 50, answeredAt,
		},
	},
];

test("mix: a topic's round takes in the due cards of topics sharing its field, labelled once each", async () => {
	const { stores } = await import("../src/server/stores.ts");
	const { kickReviewChecks, kickTopicFields, reviewStatus, setReviewChecker, setTopicFielder } = await import("../src/server/reviews.ts");
	const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
	const mk = (title: string, n: number) => {
		const chat = stores.chatStore.createChat(title);
		stores.chatStore.saveMessages(chat.id, Array.from({ length: n }, (_, i) => quiz(`${title}${i}`, `${title} question ${i}?`, old)).flat() as never);
		return chat.id;
	};
	const mdlm = mk("MDLM", 3);
	const moe = mk("MoE", 2);
	const linux = mk("Linux", 2);

	setReviewChecker(async ({ cards }) => cards.map((c) => ({ id: c.id, verdict: "ok" as const, notes: {} })));
	await kickReviewChecks();
	const calls: { titles: string[]; known: string[] }[] = [];
	setTopicFielder(async ({ topics, known }) => {
		calls.push({ titles: topics.map((t) => t.title).sort(), known: known.map((k) => k.title) });
		assert.ok(topics.every((t) => t.questions.length > 0));
		return topics.map((t) => ({ id: t.id, fields: [t.title === "Linux" ? "Linux and systems" : "Machine learning"] }));
	});
	await kickTopicFields();
	await kickTopicFields();
	assert.deepEqual(calls, [{ titles: ["Linux", "MDLM", "MoE"], known: [] }], "each topic is labelled once");

	const plain = reviewStatus(new Date(), { topic: mdlm });
	assert.equal(plain.queue.length, 3);
	assert.deepEqual(plain.topics.find((t) => t.id === mdlm)!.related, [moe]);
	assert.deepEqual(plain.topics.find((t) => t.id === linux)!.related, []);

	const mixed = reviewStatus(new Date(), { topic: mdlm, mix: true });
	assert.equal(mixed.queue.length, 5);
	assert.deepEqual(new Set(mixed.queue.map((c) => c.chatId)), new Set([mdlm, moe]));
	assert.equal(mixed.due, 5);
	assert.equal(mixed.total, 5);
	assert.equal(reviewStatus(new Date(), { topic: linux, mix: true }).queue.length, 2, "no related topic: the topic alone");

	// A new topic is labelled with the earlier labels shown for reuse.
	mk("Transformers", 1);
	// The status calls above may have a check and a labelling in flight.
	for (let i = 0; i < 2; i++) {
		const g = globalThis as any;
		console.log("DBG0", !!g.__lhReviewChecker?.running, g.__lhReviewChecker?.failedAt, reviewStatus.length);
		await kickReviewChecks();
		console.log("DBG1", stores.chatStore.listChats().map((c: any) => c.title + c.updatedAt));
		await kickTopicFields();
	}
	console.log("DBG", JSON.stringify(calls), reviewStatus().total, reviewStatus().pending, reviewStatus().checkError);
	assert.deepEqual(calls[1]!.titles, ["Transformers"]);
	assert.deepEqual(calls[1]!.known.sort(), ["Linux", "MDLM", "MoE"]);
	assert.equal(reviewStatus(new Date(), { topic: mdlm, mix: true }).queue.length, 6);
	setReviewChecker(null);
	setTopicFielder(null);
});
