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
};

export type CardCheckResult = {
	id: string;
	verdict: "ok" | "wrong" | "unclear";
	reason?: string;
	context?: string;
	notes: Record<string, string>;
};

const checkSchema = Type.Object({
	checks: Type.Array(
		Type.Object({
			id: Type.String({ description: "The card id, exactly as given." }),
			verdict: Type.Union([Type.Literal("ok"), Type.Literal("wrong"), Type.Literal("unclear")], {
				description:
					"ok: the marked answer is correct and the only correct one. wrong: the marked answer is incorrect, " +
					"or another option is just as correct. unclear: it can't be answered fairly even with context " +
					"(ambiguous wording, depends on something that can't be restated).",
			}),
			reason: Type.Optional(Type.String({ description: "For wrong/unclear: one sentence the learner can read." })),
			context: Type.String({
				description:
					"Markdown placed above the question so it stands on its own months later: the code, formula, " +
					"definition or scenario it refers to ('the loop above', 'this function'). Empty string if the " +
					"question already stands alone. Never hint at the answer.",
			}),
			notes: Type.Array(
				Type.Object({
					option: Type.Integer({ description: "The option number as given." }),
					note: Type.String({ description: "One short line: why this option is right, or the misconception behind it." }),
				}),
				{ description: "One note for EVERY option." },
			),
		}),
	),
});

const SYSTEM = `You check flashcards before they enter a learner's spaced-review deck. Each card is a multiple-choice question a tutor asked during a lesson; the learner will see it again days or months later, alone, without the lesson.

For every card:
1. Solve it yourself from the options. Compare with the marked answer. If the marked answer is wrong, or another option is equally correct, the verdict is "wrong" — a false card is worse than no card.
2. Decide whether it stands on its own. If it leans on the lesson ("the code above", "this example", a variable defined earlier), write the missing piece as context: reproduce the code or formula exactly, state the setup in a sentence or two. Keep it as short as the question allows, and never give away the answer. If even with context it can't be answered fairly, the verdict is "unclear".
3. Write one short note per option: why it is right, or which misconception picks it.

Use markdown and LaTeX ($...$) like the cards do. Submit every card in one call.`;

function cardBlock(c: CardToCheck): string {
	const options = c.options.map((o) => `${o.index}. ${o.label}`).join("\n");
	const key = c.correctIndices.join(", ");
	return [
		`## Card ${c.id}`,
		c.lead ? `### The lesson right before it\n${c.lead}` : "### The lesson right before it\n(none recorded)",
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
	signal?: AbortSignal;
	onStep?: (usage: Usage, model: string) => void;
}): Promise<CardCheckResult[]> {
	const ids = new Set(opts.cards.map((c) => c.id));
	const fixes = opts.corrections?.length
		? `## Corrected since the lesson\nThe lesson taught some of these wrongly; trust these versions:\n${opts.corrections.map((c) => `- ${c}`).join("\n")}\n\n---\n\n`
		: "";
	const prompt = `Lesson: ${opts.sessionTitle}\n\n${fixes}${opts.cards.map(cardBlock).join("\n\n---\n\n")}`;
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
			notes: Object.fromEntries(c.notes.filter((n) => n.note.trim()).map((n) => [String(n.option), n.note.trim()])),
		}));
}
