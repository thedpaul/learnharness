/**
 * The graph fact checker: re-verifies a batch of graph propositions (every
 * node is meant to be a TRUE statement — contracts/graph.ts) from ONE
 * session, and rewrites the false ones. Facts drift (new versions, new
 * results) and extraction can mistake a learner's wrong idea for a fact;
 * this is the recheck behind src/server/fact-check.ts.
 */
import type { Usage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

export type FactToCheck = { id: string; name: string; statement: string };

export type FactCheckResult =
	| { id: string; verdict: "ok" }
	| { id: string; verdict: "unclear"; reason?: string }
	| { id: string; verdict: "false"; name: string; statement: string; reason?: string };

const factSchema = Type.Object({
	facts: Type.Array(
		Type.Object({
			id: Type.String({ description: "The proposition id, exactly as given." }),
			verdict: Type.Union([Type.Literal("ok"), Type.Literal("false"), Type.Literal("unclear")], {
				description:
					"ok: true as stated (today). false: wrong, outdated or overstated — give the corrected version. " +
					"unclear: contested or can't be judged; leave it as is.",
			}),
			name: Type.Optional(Type.String({ description: "For false: a short label for the corrected proposition (keep the old one if it still fits)." })),
			statement: Type.Optional(Type.String({ description: "For false: the corrected proposition — one true, self-contained statement, same scope and style." })),
			reason: Type.Optional(Type.String({ description: "For false/unclear: one sentence on what was wrong." })),
		}),
	),
});

const SYSTEM = `You fact-check a learner's knowledge graph. Each entry is a proposition extracted from a lesson and is supposed to be TRUE, self-contained and precise.

For every proposition:
- "ok" if it is correct as stated, as of today. Don't nitpick wording; simplifications a good textbook would make are fine.
- "false" if it is wrong, outdated, or claims more than is true. Then write the corrected proposition: the closest TRUE statement on the same point, same scope and style (markdown and LaTeX $...$ allowed), plus a short name.
- "unclear" if it is genuinely contested or you can't judge it.

Be careful: only mark "false" when you are confident. Submit every proposition in one call.`;

export async function checkFacts(opts: {
	facts: FactToCheck[];
	sessionTitle: string;
	engine: PiEngine | undefined;
	signal?: AbortSignal;
	onStep?: (usage: Usage, model: string) => void;
}): Promise<FactCheckResult[]> {
	const ids = new Set(opts.facts.map((f) => f.id));
	const prompt = `Lesson: ${opts.sessionTitle}\n\n${opts.facts.map((f) => `## ${f.id} — ${f.name}\n${f.statement}`).join("\n\n")}`;
	const value = await runSubmitAgent<Static<typeof factSchema>>({
		role: "auditor",
		toolName: "submit_facts",
		toolDescription: "Submit the verdict for every proposition.",
		parameters: factSchema,
		fill: (input) => input as Static<typeof factSchema>,
		systemPrompt: SYSTEM,
		prompt,
		engine: opts.engine,
		signal: opts.signal,
		onStep: (usage, model) => opts.onStep?.(usage, model),
		neverSubmitted: "the fact checker never submitted its verdicts",
		validate: (v) => {
			const got = new Set(v.facts.map((f) => f.id));
			const missing = [...ids].filter((id) => !got.has(id));
			if (missing.length) return `missing verdicts for: ${missing.join(", ")}`;
			const bare = v.facts.filter((f) => f.verdict === "false" && !f.statement?.trim()).map((f) => f.id);
			return bare.length ? `false verdicts need a corrected statement: ${bare.join(", ")}` : null;
		},
	});
	const byId = new Map(opts.facts.map((f) => [f.id, f]));
	return value.facts
		.filter((f) => ids.has(f.id))
		.map((f): FactCheckResult => {
			const reason = f.reason?.trim() ? { reason: f.reason.trim() } : {};
			if (f.verdict === "false") {
				return { id: f.id, verdict: "false", name: f.name?.trim() || byId.get(f.id)!.name, statement: f.statement!.trim(), ...reason };
			}
			return f.verdict === "unclear" ? { id: f.id, verdict: "unclear", ...reason } : { id: f.id, verdict: "ok" };
		});
}
