/**
 * The topic fielder: labels each review topic (one session) with the broad
 * field(s) it belongs to, so the review page can mix in cards from related
 * topics (src/core/review.ts relatedTopics). One call labels every new
 * topic; the topics labelled before are shown so their field names are
 * reused and related topics land on the same label.
 */
import type { Usage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

export type TopicToField = {
	id: string;
	title: string;
	/** A few of its review questions, so a vague title still reads clearly. */
	questions: string[];
};

export type TopicFieldResult = { id: string; fields: string[] };

const fieldSchema = Type.Object({
	topics: Type.Array(
		Type.Object({
			id: Type.String({ description: "The topic id, exactly as given." }),
			fields: Type.Array(Type.String(), {
				description:
					"One or two broad fields, a few words each (e.g. 'Machine learning', 'Linux and systems'). " +
					"Reuse a field name from the labelled topics, letter for letter, whenever it fits.",
			}),
		}),
	),
});

const SYSTEM = `You sort a learner's lessons into broad fields, so their spaced reviews can mix questions from related lessons — interleaving related material strengthens learning.

For every new topic, give one or two fields:
- Broad enough that related lessons share one: two lessons on different machine-learning models are both "Machine learning", not "Diffusion models" and "Mixture of experts".
- Not so broad that unrelated lessons meet: "Science" or "Technology" is too wide.
- A second field only when the lesson clearly overlaps another area (e.g. "Machine learning" and "Probability").
- When a field of an already labelled topic fits, use its name exactly as written.

Submit every new topic in one call.`;

export async function fieldTopics(opts: {
	topics: TopicToField[];
	/** Topics labelled before, with their fields (the names to reuse). */
	known: { title: string; fields: string[] }[];
	engine: PiEngine | undefined;
	signal?: AbortSignal;
	onStep?: (usage: Usage, model: string) => void;
}): Promise<TopicFieldResult[]> {
	const ids = new Set(opts.topics.map((t) => t.id));
	const known = opts.known.length
		? `## Already labelled\n${opts.known.map((k) => `- ${k.title}: ${k.fields.join("; ")}`).join("\n")}\n\n`
		: "";
	const topics = opts.topics
		.map((t) => [`## Topic ${t.id}`, `Title: ${t.title}`, ...(t.questions.length ? ["Some of its questions:", ...t.questions.map((q) => `- ${q}`)] : [])].join("\n"))
		.join("\n\n");
	const value = await runSubmitAgent<Static<typeof fieldSchema>>({
		role: "auditor",
		toolName: "submit_fields",
		toolDescription: "Submit the fields of every new topic.",
		parameters: fieldSchema,
		fill: (input) => input as Static<typeof fieldSchema>,
		systemPrompt: SYSTEM,
		prompt: `${known}# New topics\n\n${topics}`,
		engine: opts.engine,
		signal: opts.signal,
		onStep: (usage, model) => opts.onStep?.(usage, model),
		neverSubmitted: "the topic fielder never submitted its fields",
		validate: (v) => {
			const got = new Set(v.topics.filter((t) => t.fields.some((f) => f.trim())).map((t) => t.id));
			const missing = [...ids].filter((id) => !got.has(id));
			return missing.length ? `missing fields for: ${missing.join(", ")}` : null;
		},
	});
	return value.topics
		.filter((t) => ids.has(t.id))
		.map((t) => ({ id: t.id, fields: t.fields.map((f) => f.trim()).filter(Boolean).slice(0, 2) }));
}
