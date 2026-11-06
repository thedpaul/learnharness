import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAnswer, normalizeOptions, toClientQuestion, type QuestionData } from "../src/core/question-core.ts";

test("quiz rationale: kept by normalize, hidden from the live question, saved with the answer in display order", () => {
	const options = normalizeOptions([
		{ label: "6", value: "six", rationale: " 0+1+2+3 " },
		{ label: "10", value: "ten", rationale: "counts to 4" },
		{ label: "4", value: "four" },
	]);
	assert.equal(options[0]!.rationale, "0+1+2+3");
	const qd: QuestionData = {
		id: "q",
		kind: "quiz",
		question: "What prints?",
		mode: "options" as QuestionData["mode"],
		options: [options[1]!, options[2]!, options[0]!], // the shuffled display order
		correctIndices: [3],
		explanation: "Sum the values.",
		createdAt: "2030-01-01T00:00:00.000Z",
	};
	assert.ok(!JSON.stringify(toClientQuestion(qd)).includes("rationale"));
	const answer = buildAnswer(qd, { values: ["six"], confidence: 80 });
	assert.deepEqual(answer.options, [
		{ index: 1, label: "10", note: "counts to 4" },
		{ index: 2, label: "4" },
		{ index: 3, label: "6", note: "0+1+2+3" },
	]);
	assert.equal(answer.correct, true);
});
