/**
 * Changes: what the checks found after the fact — session questions the
 * card check flagged (wrong answer key, unclear; reviews.ts) and graph facts
 * the fact recheck corrected (fact-check.ts). Each change has an id that is
 * new whenever the finding is (`card:<card>@<check time>`,
 * `fact:<node>@<correction time>`), and data/seen-changes.jsonl records the
 * ids the learner has seen (synced: seen on one device is seen on both).
 * Unseen changes carry the "!" in the sidebar, the Changes page and the
 * session's own question card.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { LEDGER_FILES, PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import { flaggedCards } from "./reviews.ts";

const SEEN = () => path.join(PATHS.data, "seen-changes.jsonl");

export type Change =
	| {
			id: string;
			kind: "card";
			at: string;
			seen: boolean;
			chatId: string;
			chatTitle: string;
			toolCallId: string;
			questionText: string;
			verdict: "wrong" | "unclear";
			reason?: string;
	  }
	| { id: string; kind: "fact"; at: string; seen: boolean; nodeId: string; name: string; statement: string; was: string; reason?: string };

const readLines = (file: string): unknown[] => {
	let text = "";
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch {
		return [];
	}
	const out: unknown[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch { /* torn line */ }
	}
	return out;
};

function seenIds(): Set<string> {
	const out = new Set<string>();
	for (const l of readLines(SEEN())) {
		const id = (l as { id?: unknown }).id;
		if (typeof id === "string") out.add(id);
	}
	return out;
}

/** Corrections straight from the node ledger: each with the statement it replaced. */
function factChanges(seen: Set<string>): Change[] {
	const current = new Map<string, string>();
	const out: Change[] = [];
	for (const raw of readLines(LEDGER_FILES.nodes)) {
		const l = raw as { id?: unknown; name?: unknown; statement?: unknown; correction?: { at?: unknown; reason?: unknown } };
		if (typeof l.id !== "string" || typeof l.statement !== "string") continue;
		if (!l.correction) {
			if (!current.has(l.id)) current.set(l.id, l.statement);
			continue;
		}
		const was = current.get(l.id);
		if (was === undefined || typeof l.correction.at !== "string") continue;
		current.set(l.id, l.statement);
		const id = `fact:${l.id}@${l.correction.at}`;
		out.push({
			id,
			kind: "fact",
			at: l.correction.at,
			seen: seen.has(id),
			nodeId: l.id,
			name: typeof l.name === "string" ? l.name : "",
			statement: l.statement,
			was,
			...(typeof l.correction.reason === "string" ? { reason: l.correction.reason } : {}),
		});
	}
	return out;
}

export function listChanges(opts: { chatId?: string } = {}): { unseen: number; items: Change[] } {
	const seen = seenIds();
	const cards: Change[] = flaggedCards()
		.filter(({ card }) => !opts.chatId || card.chatId === opts.chatId)
		.map(({ card, check }) => {
			const id = `card:${card.id}@${check.at}`;
			return {
				id,
				kind: "card" as const,
				at: check.at,
				seen: seen.has(id),
				chatId: card.chatId,
				chatTitle: card.chatTitle,
				toolCallId: card.id.slice(card.chatId.length + 1),
				questionText: card.questionText,
				verdict: check.verdict as "wrong" | "unclear",
				...(check.reason ? { reason: check.reason } : {}),
			};
		});
	const items = [...cards, ...(opts.chatId ? [] : factChanges(seen))].sort((a, b) => b.at.localeCompare(a.at));
	return { unseen: items.filter((c) => !c.seen).length, items };
}

export function markChangesSeen(ids: string[]): void {
	const seen = seenIds();
	const fresh = [...new Set(ids)].filter((id) => !seen.has(id));
	if (fresh.length === 0) return;
	const at = new Date().toISOString();
	fs.mkdirSync(PATHS.data, { recursive: true });
	fs.appendFileSync(SEEN(), `${fresh.map((id) => JSON.stringify({ id, at })).join("\n")}\n`);
	emit("changes-changed", {});
}
