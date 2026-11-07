/**
 * The review-card checker: before a quiz question from a session enters the
 * spaced-review deck (src/core/review.ts), a model checks it with the
 * teaching it came from — is the marked answer really right (and the only
 * right one), can the question be answered months later on its own, and
 * what does each option teach. One call checks a batch of cards from ONE
 * session (the teaching is shared context).
 */
import type { Usage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

export type CardToCheck = {
	id: string;
	questionText: string;
	options: { index: number; label: string }[];
	correctIndices: number[];
	explanation?: string;
	/** The teaching right before the question. */
	lead?: string;
	/** A practice problem's model solution (no options). */
	solution?: string;
};

export type CardCheckResult = {
	id: string;
	verdict: "ok" | "wrong" | "unclear" | "duplicate";
	reason?: string;
	/** For a duplicate: the id of the card it repeats. */
	duplicateOf?: string;
	context?: string;
	/** The tutor's explanation rewritten for review; absent when it was fine as is. */
	explanation?: string;
	/** The concept the card tests (clusters related cards across topics). */
	concept?: string;
	notes: Record<string, string>;
};

const checkSchema = Type.Object({
	checks: Type.Array(
		Type.Object({
			id: Type.String({ description: "The card id, exactly as given." }),
			verdict: Type.Union([Type.Literal("ok"), Type.Literal("wrong"), Type.Literal("unclear"), Type.Literal("duplicate")], {
				description:
					"ok: the marked answer is correct and the only correct one. wrong: the marked answer is incorrect, " +
					"or another option is just as correct. unclear: it can't be answered fairly even with context " +
					"(ambiguous wording, depends on something that can't be restated). duplicate: a correct card that " +
					"asks essentially the same thing as a card already in the deck or an earlier card in this batch.",
			}),
			duplicateOf: Type.Optional(Type.String({ description: "For duplicate: the id of the card it repeats, exactly as given." })),
			reason: Type.Optional(Type.String({ description: "For wrong/unclear: one sentence the learner can read." })),
			context: Type.String({
				description:
					"Markdown placed above the question so it stands on its own months later: the code, formula, " +
					"definition or scenario it refers to ('the loop above', 'this function'). Empty string if the " +
					"question already stands alone. Never hint at the answer.",
			}),
			explanation: Type.String({
				description:
					"The tutor's explanation as the learner reads it after answering in review, where the options " +
					"appear SHUFFLED: refer to options by their content, never by letter, number or position " +
					"('(b)', 'option A', 'the second one'). Keep it short, correct (fix anything wrong) and in LaTeX. " +
					"Empty string if the tutor's explanation already does all that.",
			}),
			concept: Type.String({
				description:
					"The one concept this card tests, as a short name (2-5 words, e.g. 'Softmax temperature', " +
					"'Bayes rule', 'File permissions'): specific enough that cards on it belong together, general " +
					"enough that other lessons can test it too. Reuse a name from the concepts in use, letter for " +
					"letter, whenever it is the same idea.",
			}),
			notes: Type.Array(
				Type.Object({
					option: Type.Integer({ description: "The option number as given." }),
					note: Type.String({ description: "One short line: why this option is right, or the misconception behind it. Math in LaTeX ($\\sqrt{d_k}$), never Unicode symbols or bare subscripts." }),
				}),
				{ description: "One note for EVERY option." },
			),
		}),
	),
});

const SYSTEM = `You check flashcards before they enter a learner's spaced-review deck. Most cards are multiple-choice questions a tutor asked during a lesson; the learner will see it again days or months later, alone, without the lesson.

For every card:
1. Solve it yourself from the options. Compare with the marked answer. If the marked answer is wrong, or another option is equally correct, the verdict is "wrong" — a false card is worse than no card.
2. Decide whether it stands on its own. If it leans on the lesson ("the code above", "this example", a variable defined earlier), write the missing piece as context: reproduce the code or formula exactly, state the setup in a sentence or two. Keep it as short as the question allows, and never give away the answer. If even with context it can't be answered fairly, the verdict is "unclear".
3. Write one short note per option: why it is right, or which misconception picks it.
4. Check the tutor's explanation as the learner will read it in review, after answering, with the options shuffled. If it names options by letter, number or position, gets something wrong, or writes math outside LaTeX, rewrite it: same reasoning, options named by what they say. If it is already right, leave the explanation empty.
5. Name the one concept the card tests. Cards from any lesson that test the same idea are reviewed side by side, so when a concept in use is the same idea, give its name exactly.
6. Check it against the cards already in the deck, and against the cards before it in this batch. If one asks essentially the same question — the same fact or reasoning, so that answering one means you'd answer the other — the verdict is "duplicate" with that card's id in duplicateOf (a card that is also wrong or unclear gets that verdict instead). Testing the same concept from another angle, in another case, or one step further is not a duplicate: keep it. Still write the context, notes and concept for a duplicate.

Some cards are practice problems instead: no options, a model solution the learner compares their own work with after trying it. For those, step 1 is to solve the problem yourself and check the model solution: if it reaches a wrong result or skips a step it needs, the verdict is "wrong". Steps 2, 5 and 6 apply as for any card; leave notes and the explanation empty.

Use markdown like the cards do, and write every formula, symbol and variable in LaTeX — inline $...$, e.g. $\\sqrt{d_k}$, $x_t = \\sqrt{\\bar\\alpha_t}\\,x_0$, $\\sum_j e^{z_j}$ — in notes, context, explanations and reasons alike. Never Unicode math (√, ∑, ᾱ, ≠, ≤) or bare d_k / x^2: the learner's screen renders LaTeX, and plain underscores turn into italics. Submit every card in one call.`;

/** Enough of the deck to spot repeats without crowding the call. */
const MAX_EXISTING = 400;
const oneLine = (text: string) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 240 ? `${flat.slice(0, 240)}…` : flat;
};

function cardBlock(c: CardToCheck): string {
	const options = c.options.map((o) => `${o.index}. ${o.label}`).join("\n");
	const key = c.correctIndices.join(", ");
	const lesson = c.lead ? `### The lesson right before it\n${c.lead}` : "### The lesson right before it\n(none recorded)";
	if (c.solution !== undefined) {
		return [`## Card ${c.id} (practice problem)`, lesson, `### Problem\n${c.questionText}`, `### Model solution\n${c.solution}`].join("\n\n");
	}
	return [
		`## Card ${c.id}`,
		lesson,
		`### Question\n${c.questionText}`,
		`### Options\n${options}`,
		`### Marked correct: ${key}`,
		c.explanation ? `### Tutor's explanation\n${c.explanation}` : "",
	].filter(Boolean).join("\n\n");
}

export async function checkCards(opts: {
	cards: CardToCheck[];
	sessionTitle: string;
	engine: PiEngine | undefined;
	/** Facts from this lesson the fact check corrected (src/server/fact-check.ts):
	 *  a card built on the old version is now wrong. */
	corrections?: string[];
	/** Concept names already in use (src/core/review.ts knownConcepts). */
	concepts?: string[];
	/** Older cards already in the deck, for the duplicate check. */
	existing?: { id: string; question: string; concept?: string }[];
	signal?: AbortSignal;
	onStep?: (usage: Usage, model: string) => void;
}): Promise<CardCheckResult[]> {
	const ids = new Set(opts.cards.map((c) => c.id));
	const fixes = opts.corrections?.length
		? `## Corrected since the lesson\nThe lesson taught some of these wrongly; trust these versions:\n${opts.corrections.map((c) => `- ${c}`).join("\n")}\n\n---\n\n`
		: "";
	const concepts = opts.concepts?.length ? `## Concepts in use\n${opts.concepts.map((c) => `- ${c}`).join("\n")}\n\n---\n\n` : "";
	const deck = opts.existing?.length
		? `## Cards already in the deck\n${[...opts.existing]
				.sort((a, b) => (a.concept ?? "").localeCompare(b.concept ?? ""))
				.slice(0, MAX_EXISTING)
				.map((c) => `- [${c.id}]${c.concept ? ` (${c.concept})` : ""} ${oneLine(c.question)}`)
				.join("\n")}\n\n---\n\n`
		: "";
	const prompt = `Lesson: ${opts.sessionTitle}\n\n${fixes}${concepts}${deck}${opts.cards.map(cardBlock).join("\n\n---\n\n")}`;
	const value = await runSubmitAgent<Static<typeof checkSchema>>({
		role: "auditor",
		toolName: "submit_checks",
		toolDescription: "Submit the check for every card.",
		parameters: checkSchema,
		fill: (input) => input as Static<typeof checkSchema>,
		systemPrompt: SYSTEM,
		prompt,
		engine: opts.engine,
		signal: opts.signal,
		onStep: (usage, model) => opts.onStep?.(usage, model),
		neverSubmitted: "the card checker never submitted its checks",
		validate: (v) => {
			const got = new Set(v.checks.map((c) => c.id));
			const missing = [...ids].filter((id) => !got.has(id));
			return missing.length ? `missing checks for: ${missing.join(", ")}` : null;
		},
	});
	return value.checks
		.filter((c) => ids.has(c.id))
		.map((c) => ({
			id: c.id,
			verdict: c.verdict,
			...(c.reason?.trim() ? { reason: c.reason.trim() } : {}),
			...(c.context.trim() ? { context: c.context.trim() } : {}),
			...(c.explanation.trim() ? { explanation: c.explanation.trim() } : {}),
			...(c.concept.trim() ? { concept: c.concept.trim() } : {}),
			...(c.verdict === "duplicate" && c.duplicateOf?.trim() ? { duplicateOf: c.duplicateOf.trim() } : {}),
			notes: Object.fromEntries(c.notes.filter((n) => n.note.trim()).map((n) => [String(n.option), n.note.trim()])),
		}));
}
