/**
 * Spaced reviews (src/core/review.ts): the deck derives from every
 * session's graded quiz answers; reviews append to data/reviews.jsonl and
 * card checks to data/review-checks.jsonl (ledgers — synced and merged by
 * line like the graph ledgers).
 *
 * A card reaches the queue only once checked "ok" (card-checker.ts): new
 * cards are checked in the background, one session at a time, on the
 * auditor role's model (the cheap slot). Nothing configured → they wait.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { checkCards } from "../agent/subagents/card-checker.ts";
import { emit } from "../core/events.ts";
import {
	calibration,
	checkedCard,
	checkIsStale,
	dueCards,
	extractReviewCards,
	isCorrect,
	parseReviewChecks,
	parseReviewLedger,
	REVIEW_CHECK_VERSION,
	reviewSettingsOf,
	reviewsToday,
	scheduleCard,
	type Calibration,
	type ReviewCard,
	type ReviewCheck,
	type ReviewEvent,
	type ReviewSettings,
} from "../core/index.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { providerKeyPresent } from "./keys.ts";
import { lanPaired } from "./sync/lan.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { stores } from "./stores.ts";

const LEDGER = () => path.join(PATHS.data, "reviews.jsonl");
const CHECKS = () => path.join(PATHS.data, "review-checks.jsonl");

/** Per-chat card cache, keyed by the record's updatedAt. */
const cache = new Map<string, { updatedAt: string; cards: ReviewCard[] }>();

function allCards(): ReviewCard[] {
	const out: ReviewCard[] = [];
	const live = new Set<string>();
	for (const summary of stores.chatStore.listChats()) {
		live.add(summary.id);
		const hit = cache.get(summary.id);
		if (hit && hit.updatedAt === summary.updatedAt) {
			out.push(...hit.cards);
			continue;
		}
		const record = stores.chatStore.getChat(summary.id);
		if (!record) continue;
		const cards = extractReviewCards(record.id, record.title, record.messages as never);
		cache.set(summary.id, { updatedAt: summary.updatedAt, cards });
		out.push(...cards);
	}
	for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
	return out;
}

const readText = (file: string) => {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return "";
	}
};
const readLedger = (): ReviewEvent[] => parseReviewLedger(readText(LEDGER()));
const readChecks = (): Map<string, ReviewCheck> => parseReviewChecks(readText(CHECKS()));

// ─── background checks ──────────────────────────────────────────────────────

const BATCH = 6;
/** After a failed run (no model, offline), wait before trying again. */
const RETRY_MS = 10 * 60_000;
/** A phone paired with a computer leaves fresh cards to the computer (the
 *  checks sync back) and only checks what is still unchecked after this. */
const PHONE_DEFER_MS = 24 * 60 * 60_000;
const deferToComputer = () => process.env.LH_PLATFORM === "android" && lanPaired();

type CheckerSlot = { running?: Promise<void>; lastError?: string; failedAt?: number };
const checkerKey = "__lhReviewChecker";
function checkerSlot(): CheckerSlot {
	const g = globalThis as typeof globalThis & { [checkerKey]?: CheckerSlot };
	return (g[checkerKey] ??= {});
}

export function auditorEngine() {
	const spec = resolveRoleSpec("auditor", stores.settingsStore.readSettings());
	if (!spec) throw new Error("No model is set for background work (Settings → Providers, the cheap slot)");
	if (!providerKeyPresent(spec.provider)) throw new Error(`${spec.provider} isn't connected (Settings → Providers)`);
	return piEngineForSpec(spec, true, undefined, () => stores.settingsStore.readSettings()?.models?.cheap?.cacheRetention);
}

/** The fact recheck's once-per-start hook (fact-check.ts registers it: the
 *  badges' first count is the app's start, and the import stays one-way). */
let startupRecheck: (() => void) | undefined;
export function onFirstCount(fn: () => void): void {
	startupRecheck = fn;
}

/** Test seam: a scripted checker replaces the model call. */
type Checker = typeof checkCards;
let checker: Checker = checkCards;
export function setReviewChecker(fn: Checker | null): void {
	checker = fn ?? checkCards;
	const slot = checkerSlot();
	slot.failedAt = undefined;
	slot.lastError = undefined;
}

/** Check every unchecked card, and re-check those an older checker passed,
 *  one session batch at a time. A paired phone leaves the re-checks to the
 *  computer (they arrive with the next sync). Never throws. */
export function kickReviewChecks(): Promise<void> {
	const slot = checkerSlot();
	if (slot.running) return slot.running;
	if (slot.failedAt && Date.now() - slot.failedAt < RETRY_MS) return Promise.resolve();
	const checks = readChecks();
	const defer = deferToComputer();
	return runChecks((c) => {
		const check = checks.get(c.id);
		if (!check) return !defer || Date.now() - Date.parse(c.firstAnswer.at) > PHONE_DEFER_MS;
		return !defer && checkIsStale(check);
	});
}

/**
 * The recheck (src/server/fact-check.ts): checked cards too — every card
 * whose last check is older than `before` (all of them without it) is
 * checked again; the newest check wins. `corrections` are the corrected
 * graph facts per session, so cards built on an old fact fail the check
 * (a session with corrections has all its cards rechecked).
 */
export async function recheckCards(opts: { before?: number; corrections?: Map<string, string[]>; onProgress?: (done: number, total: number) => void } = {}): Promise<void> {
	const slot = checkerSlot();
	if (slot.running) await slot.running;
	const checks = readChecks();
	await runChecks((c) => {
		const at = checks.get(c.id)?.at;
		return !at || opts.before === undefined || Date.parse(at) < opts.before || !!opts.corrections?.has(c.chatId);
	}, opts.corrections, opts.onProgress);
	if (slot.lastError) throw new Error(slot.lastError);
}

function runChecks(
	select: (card: ReviewCard) => boolean,
	corrections?: Map<string, string[]>,
	onProgress?: (done: number, total: number) => void,
): Promise<void> {
	const slot = checkerSlot();
	const run = (async () => {
		try {
			const todo = allCards().filter(select);
			if (todo.length === 0) return;
			let done = 0;
			onProgress?.(done, todo.length);
			const engine = checker === checkCards ? auditorEngine() : undefined;
			const byChat = new Map<string, ReviewCard[]>();
			for (const c of todo) byChat.set(c.chatId, [...(byChat.get(c.chatId) ?? []), c]);
			for (const [chatId, cards] of byChat) {
				for (let i = 0; i < cards.length; i += BATCH) {
					const batch = cards.slice(i, i + BATCH);
					const results = await checker({ cards: batch, sessionTitle: batch[0]!.chatTitle, engine, corrections: corrections?.get(chatId) });
					const at = new Date().toISOString();
					const lines = results.map((r) =>
						JSON.stringify({ card: r.id, at, v: REVIEW_CHECK_VERSION, verdict: r.verdict, reason: r.reason, context: r.context, notes: r.notes }),
					);
					if (lines.length) {
						fs.mkdirSync(PATHS.data, { recursive: true });
						fs.appendFileSync(CHECKS(), `${lines.join("\n")}\n`);
						emit("reviews-changed", {});
						if (results.some((r) => r.verdict !== "ok")) emit("changes-changed", {});
					}
					done += batch.length;
					onProgress?.(done, todo.length);
				}
			}
			slot.lastError = undefined;
			slot.failedAt = undefined;
		} catch (err) {
			slot.lastError = err instanceof Error ? err.message : String(err);
			slot.failedAt = Date.now();
		} finally {
			slot.running = undefined;
		}
	})();
	slot.running = run;
	return run;
}

// ─── status ─────────────────────────────────────────────────────────────────

/** A card as the client sees it before answering: no correct answer. */
export type ReviewQuestion = {
	id: string;
	chatId: string;
	chatTitle: string;
	context?: string;
	questionText: string;
	options: { index: number; label: string }[];
	multiple: boolean;
	box: number;
	/** How many times it has been reviewed (seeds the option shuffle). */
	reviews: number;
};

/** One session's share of the deck (the topic picker). */
export type ReviewTopic = { id: string; title: string; total: number; due: number };

export interface ReviewStatus {
	due: number;
	total: number;
	/** Cards not checked yet, and the reason checking is stalled (if it is). */
	pending: number;
	checkError: string | null;
	held: { id: string; chatTitle: string; questionText: string; verdict: string; reason?: string }[];
	topics: ReviewTopic[];
	queue: ReviewQuestion[];
	/** Due in total, before the daily limit (`due` is what the limit allows now). */
	dueAll: number;
	doneToday: number;
	settings: ReviewSettings;
	calibration: Calibration;
	/** Every answer time (sessions + reviews), for the client's local-day streak. */
	activity: string[];
}

function deck(now: Date) {
	const cards = allCards();
	const checks = readChecks();
	const events = readLedger();
	const ok = cards.filter((c) => checks.get(c.id)?.verdict === "ok").map((c) => checkedCard(c, checks.get(c.id)));
	const settings = reviewSettingsOf(stores.settingsStore.readSettings());
	const doneToday = reviewsToday(events, now);
	/** What the daily limit still allows today (Infinity = no limit). */
	const left = settings.maxPerDay > 0 ? Math.max(0, settings.maxPerDay - doneToday) : Infinity;
	return { cards, checks, events, ok, due: dueCards(ok, events, now), settings, doneToday, left };
}

/** The sidebar and home badges: what can be reviewed now (the daily limit applied). */
export function reviewCounts(now = new Date()): { due: number; total: number; settings: ReviewSettings } {
	const { ok, due, left, settings } = deck(now);
	void kickReviewChecks();
	startupRecheck?.();
	return { due: Math.min(due.length, left), total: ok.length, settings };
}

export function reviewStatus(now = new Date(), opts: { topic?: string; limit?: number } = {}): ReviewStatus {
	const { cards, checks, events, ok, due, settings, doneToday, left } = deck(now);
	void kickReviewChecks();
	const topics = new Map<string, ReviewTopic>();
	for (const c of ok) {
		const t = topics.get(c.chatId) ?? { id: c.chatId, title: c.chatTitle, total: 0, due: 0 };
		t.total++;
		topics.set(c.chatId, t);
	}
	for (const c of due) topics.get(c.chatId)!.due++;
	const inTopic = <T extends { chatId: string }>(list: T[]) => (opts.topic ? list.filter((c) => c.chatId === opts.topic) : list);
	const shownDue = inTopic(due);
	const shownOk = inTopic(ok);
	const okIds = new Set(shownOk.map((c) => c.id));
	const rated = [...shownOk.map((c) => c.firstAnswer), ...events.filter((e) => okIds.has(e.card))];
	const allowed = shownDue.slice(0, Math.min(left, opts.limit ?? 20));
	return {
		due: Math.min(shownDue.length, left),
		dueAll: shownDue.length,
		doneToday,
		settings,
		total: shownOk.length,
		pending: cards.filter((c) => !checks.has(c.id)).length,
		checkError: checkerSlot().lastError ?? null,
		held: inTopic(cards)
			.filter((c) => checks.has(c.id) && checks.get(c.id)!.verdict !== "ok")
			.map((c) => ({ id: c.id, chatTitle: c.chatTitle, questionText: c.questionText, verdict: checks.get(c.id)!.verdict, reason: checks.get(c.id)!.reason })),
		topics: [...topics.values()].sort((a, b) => b.due - a.due || b.total - a.total || a.title.localeCompare(b.title)),
		queue: allowed.map((c) => ({
			id: c.id,
			chatId: c.chatId,
			chatTitle: c.chatTitle,
			...(c.context ? { context: c.context } : {}),
			questionText: c.questionText,
			options: c.options.map((o) => ({ index: o.index, label: o.label })),
			multiple: c.correctIndices.length > 1,
			box: c.schedule.box,
			reviews: c.schedule.reviews,
		})),
		calibration: calibration(rated),
		activity: [...cards.map((c) => c.firstAnswer.at), ...events.map((e) => e.at)],
	};
}

/** Cards the check held back (wrong answer key, unclear), with the check
 *  time — the Changes page and the session notes (changes.ts). */
export function flaggedCards(): { card: ReviewCard; check: ReviewCheck }[] {
	const checks = readChecks();
	return allCards()
		.filter((c) => checks.has(c.id) && checks.get(c.id)!.verdict !== "ok")
		.map((c) => ({ card: c, check: checks.get(c.id)! }));
}

export type ReviewResult = {
	correct: boolean;
	correctIndices: number[];
	explanation?: string;
	/** Per-option notes, by option index. */
	notes: Record<string, string>;
	nextDueAt: string;
};

/** Grade one review and append it to the ledger. null = unknown card. */
export function recordReview(cardId: string, selected: number[], confidence: number | undefined, now = new Date()): ReviewResult | null {
	const checks = readChecks();
	const raw = allCards().find((c) => c.id === cardId);
	if (!raw || checks.get(cardId)?.verdict !== "ok") return null;
	const card = checkedCard(raw, checks.get(cardId));
	const correct = isCorrect(selected, card.correctIndices);
	const event: ReviewEvent = {
		card: card.id,
		at: now.toISOString(),
		correct,
		...(typeof confidence === "number" ? { confidence: Math.max(0, Math.min(100, Math.round(confidence))) } : {}),
	};
	fs.mkdirSync(PATHS.data, { recursive: true });
	fs.appendFileSync(LEDGER(), `${JSON.stringify(event)}\n`);
	emit("reviews-changed", {});
	const schedule = scheduleCard(card, readLedger(), now);
	return {
		correct,
		correctIndices: card.correctIndices,
		explanation: card.explanation,
		notes: Object.fromEntries(card.options.filter((o) => o.note).map((o) => [String(o.index), o.note!])),
		nextDueAt: schedule.dueAt,
	};
}

/**
 * Undo the reviews of the last `days` days (all of them when days is
 * null), optionally in one topic: their ledger lines are dropped, so those
 * cards fall back to their earlier schedule and come due again. A removed
 * line stays removed on the other device after a sync (mergeLedgerText).
 * Session answers (the first answer of each card) are never touched.
 */
export function resetReviews(days: number | null, opts: { topic?: string } = {}, now = new Date()): { removed: number } {
	const text = readText(LEDGER());
	if (!text) return { removed: 0 };
	const since = days === null ? -Infinity : now.getTime() - days * 86_400_000;
	let removed = 0;
	const kept = text.split("\n").filter((line) => {
		if (!line.trim()) return false;
		const event = parseReviewLedger(line)[0];
		if (!event) return true;
		const inTopic = !opts.topic || event.card.startsWith(`${opts.topic}:`);
		const drop = inTopic && Date.parse(event.at) >= since;
		if (drop) removed++;
		return !drop;
	});
	if (removed === 0) return { removed };
	writeFileAtomicSync(LEDGER(), kept.length ? `${kept.join("\n")}\n` : "");
	emit("reviews-changed", {});
	return { removed };
}
