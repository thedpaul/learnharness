/**
 * The fact recheck: graph propositions are meant to be true
 * (contracts/graph.ts), but facts drift and extraction can be wrong. One
 * run re-verifies the graph's propositions (fact-checker.ts, a batch per
 * birth session), appends a CORRECTION line for each false one (getGraph
 * swaps the statement in), then rechecks the review cards — already checked
 * ones too — with those corrections in hand (reviews.ts recheckCards).
 *
 * Verdicts go to graph/fact-checks.jsonl (synced with the graph ledgers):
 * a node is re-verified only once its last check is older than the window.
 * Triggers: the graph view's "Recheck facts" button (everything, now) and,
 * when Settings → Graph → "Recheck facts on startup" is on, once per server
 * start (only what is past the window). A phone paired with a computer
 * leaves the startup run to the computer.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { checkFacts, type FactCheckResult } from "../agent/subagents/fact-checker.ts";
import { emit } from "../core/events.ts";
import { getGraph } from "../core/graph.ts";
import { birthSessionOf } from "../core/session-clusters.ts";
import { resolveSettings } from "../core/settings-resolution.ts";
import { lanPaired } from "./sync/lan.ts";
import { auditorEngine, onFirstCount, recheckCards } from "./reviews.ts";
import { stores } from "./stores.ts";

const FACT_CHECKS = () => path.join(PATHS.graph, "fact-checks.jsonl");
/** A checked fact (and card) is checked again after this. */
export const RECHECK_WINDOW_MS = 30 * 86_400_000;
const BATCH = 15;

export type FactCheckLine = { node: string; at: string; verdict: FactCheckResult["verdict"]; reason?: string };

export type RecheckStatus = {
	running: boolean;
	phase: "facts" | "cards" | null;
	done: number;
	total: number;
	/** The last finished run. */
	last: { at: string; checked: number; corrected: { name: string; statement: string; reason?: string }[]; error?: string } | null;
};

type Slot = { running?: Promise<void>; status: RecheckStatus; startupDone?: boolean };
const slotKey = "__lhFactRecheck";
function slot(): Slot {
	const g = globalThis as typeof globalThis & { [slotKey]?: Slot };
	return (g[slotKey] ??= { status: { running: false, phase: null, done: 0, total: 0, last: null } });
}

export function recheckStatus(): RecheckStatus {
	return slot().status;
}

function lastChecks(): Map<string, string> {
	const out = new Map<string, string>();
	let text = "";
	try {
		text = fs.readFileSync(FACT_CHECKS(), "utf-8");
	} catch {
		return out;
	}
	for (const line of text.split("\n")) {
		try {
			const c = JSON.parse(line) as Partial<FactCheckLine>;
			if (typeof c.node === "string" && typeof c.at === "string" && (out.get(c.node) ?? "") < c.at) out.set(c.node, c.at);
		} catch { /* torn or blank line */ }
	}
	return out;
}

/** Test seam: a scripted fact checker replaces the model call. */
type Checker = typeof checkFacts;
let checker: Checker = checkFacts;
export function setFactChecker(fn: Checker | null): void {
	checker = fn ?? checkFacts;
}

const changed = () => emit("recheck-changed", {});

/** Run the recheck: `force` = everything now; otherwise only past the window. */
export function runRecheck(opts: { force?: boolean } = {}): Promise<void> {
	const s = slot();
	if (s.running) return s.running;
	const before = opts.force ? undefined : Date.now() - RECHECK_WINDOW_MS;
	const status = s.status;
	const run = (async () => {
		const corrected: NonNullable<RecheckStatus["last"]>["corrected"] = [];
		let checked = 0;
		let error: string | undefined;
		try {
			const seen = lastChecks();
			const nodes = getGraph(stores.graphStore).nodes.filter((n) => {
				const at = seen.get(n.id);
				return !at || before === undefined || Date.parse(at) < before;
			});
			Object.assign(status, { running: true, phase: "facts", done: 0, total: nodes.length });
			changed();
			const bySession = new Map<string, typeof nodes>();
			for (const n of nodes) {
				const key = birthSessionOf(n) ?? "";
				bySession.set(key, [...(bySession.get(key) ?? []), n]);
			}
			const corrections = new Map<string, string[]>();
			const engine = nodes.length && checker === checkFacts ? auditorEngine() : undefined;
			for (const [session, group] of bySession) {
				const title = stores.chatStore.getChat(session)?.title ?? "Notes";
				for (let i = 0; i < group.length; i += BATCH) {
					const batch = group.slice(i, i + BATCH);
					const results = await checker({
						facts: batch.map((n) => ({ id: n.id, name: n.name, statement: n.statement })),
						sessionTitle: title,
						engine,
					});
					const at = new Date().toISOString();
					for (const r of results) {
						if (r.verdict !== "false") continue;
						const node = batch.find((n) => n.id === r.id)!;
						stores.graphStore.appendNode({
							id: node.id,
							name: r.name,
							statement: r.statement,
							aliases: [],
							createdAt: node.createdAt,
							provenance: [],
							correction: { at, ...(r.reason ? { reason: r.reason } : {}) },
						});
						corrected.push({ name: r.name, statement: r.statement, ...(r.reason ? { reason: r.reason } : {}) });
						// Cards are grouped by chat; every chat the node came up in gets the fix.
						for (const chat of new Set(node.provenance.map((p) => p.chatId))) {
							corrections.set(chat, [...(corrections.get(chat) ?? []), `${node.statement} → ${r.statement}`]);
						}
					}
					const lines = results.map((r) => JSON.stringify({ node: r.id, at, verdict: r.verdict, ...("reason" in r && r.reason ? { reason: r.reason } : {}) }));
					if (lines.length) {
						fs.mkdirSync(PATHS.graph, { recursive: true });
						fs.appendFileSync(FACT_CHECKS(), `${lines.join("\n")}\n`);
					}
					checked += results.length;
					status.done += batch.length;
					changed();
				}
			}
			Object.assign(status, { phase: "cards", done: 0, total: 0 });
			changed();
			await recheckCards({ before, corrections });
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			status.last = { at: new Date().toISOString(), checked, corrected, ...(error ? { error } : {}) };
			Object.assign(status, { running: false, phase: null, done: 0, total: 0 });
			s.running = undefined;
			changed();
		}
	})();
	s.running = run;
	return run;
}

/** Once per server start, when the setting is on (never on a phone paired with a computer). */
export function maybeStartupRecheck(): void {
	const s = slot();
	if (s.startupDone) return;
	s.startupDone = true;
	if (process.env.LH_PLATFORM === "android" && lanPaired()) return;
	if (!resolveSettings(stores.settingsStore.readSettings()).graph.recheckOnStartup) return;
	void runRecheck();
}

onFirstCount(maybeStartupRecheck);
