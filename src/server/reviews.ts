/**
 * Spaced reviews (src/core/review.ts): the deck derives from every
 * session's graded quiz answers; reviews append to data/reviews.jsonl and
 * card checks to data/review-checks.jsonl (ledgers — synced and merged by
 * line like the graph ledgers).
 *
 * A card reaches the queue only once checked "ok" (card-checker.ts): new
 * cards are checked in the background, one session at a time, on the
 * auditor role's model (the cheap slot). Nothing configured → they wait.
 *
 * Topics (sessions) get their field(s) the same way, once each
 * (data/review-fields.jsonl, topic-fielder.ts): a topic can be reviewed
 * mixed with the topics sharing a field.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { checkCards, type CardCheckResult } from "../agent/subagents/card-checker.ts";
import { fieldTopics } from "../agent/subagents/topic-fielder.ts";
import { emit } from "../core/events.ts";
import {
	calibration,
	checkedCard,
	checkIsStale,
	deckCards,
	dueCards,
	duplicateAliases,
	foldDuplicates,
	extractReviewCards,
	isCorrect,
	knownConcepts,
	clusteredOrder,
	mixedOrder,
	parseTopicFields,
	relatedTopics,
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
const FIELDS = () => path.join(PATHS.data, "review-fields.jsonl");

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
const readFields = (): Map<string, string[]> => parseTopicFields(readText(FIELDS()));

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

/** A duplicate stands only against an OLDER card that exists (the older
 *  one is kept); anything else the checker said is an ordinary pass. */
function keepOldest(r: CardCheckResult, byId: ReadonlyMap<string, ReviewCard>): CardCheckResult {
	if (r.verdict !== "duplicate") return r;
	const card = byId.get(r.id);
	const original = r.duplicateOf ? byId.get(r.duplicateOf) : undefined;
	if (card && original && original.id !== card.id && original.firstAnswer.at < card.firstAnswer.at) return r;
	const { duplicateOf: _d, ...rest } = r;
	return { ...rest, verdict: "ok" };
}

function runChecks(
	select: (card: ReviewCard) => boolean,
	corrections?: Map<string, string[]>,
	onProgress?: (done: number, total: number) => void,
): Promise<void> {
	const slot = checkerSlot();
	const run = (async () => {
		try {
			// Oldest first, so a repeat meets the card it repeats already checked.
			const todo = allCards().filter(select).sort((a, b) => a.firstAnswer.at.localeCompare(b.firstAnswer.at));
			if (todo.length === 0) return;
			let done = 0;
			onProgress?.(done, todo.length);
			const engine = checker === checkCards ? auditorEngine() : undefined;
			const checks = readChecks();
			const concepts = knownConcepts(checks.values());
			// The deck as the checker compares against it: every card now
			// standing ok, kept current as this run's verdicts land.
			const all = allCards();
			const byId = new Map(all.map((c) => [c.id, c]));
			const standing = new Map(all.filter((c) => checks.get(c.id)?.verdict === "ok").map((c) => [c.id, checks.get(c.id)!.concept]));
			const byChat = new Map<string, ReviewCard[]>();
			for (const c of todo) byChat.set(c.chatId, [...(byChat.get(c.chatId) ?? []), c]);
			for (const [chatId, cards] of byChat) {
				for (let i = 0; i < cards.length; i += BATCH) {
					const batch = cards.slice(i, i + BATCH);
					const inBatch = new Set(batch.map((c) => c.id));
					const newest = batch.reduce((t, c) => (c.firstAnswer.at > t ? c.firstAnswer.at : t), "");
					const existing = [...standing]
						.filter(([id]) => !inBatch.has(id) && byId.get(id)!.firstAnswer.at < newest)
						.map(([id, concept]) => ({ id, question: byId.get(id)!.questionText, ...(concept ? { concept } : {}) }));
					const results = (await checker({ cards: batch, sessionTitle: batch[0]!.chatTitle, engine, corrections: corrections?.get(chatId), concepts, existing }))
						.map((r) => keepOldest(r, byId));
					const at = new Date().toISOString();
					const lines = results.map((r) =>
						JSON.stringify({ card: r.id, at, v: REVIEW_CHECK_VERSION, verdict: r.verdict, reason: r.reason, context: r.context, explanation: r.explanation, concept: r.concept, duplicateOf: r.duplicateOf, notes: r.notes }),
					);
					if (lines.length) {
						fs.mkdirSync(PATHS.data, { recursive: true });
						fs.appendFileSync(CHECKS(), `${lines.join("\n")}\n`);
						emit("reviews-changed", {});
						if (results.some((r) => r.verdict !== "ok")) emit("changes-changed", {});
					}
					for (const r of results) {
						if (r.verdict === "ok") standing.set(r.id, r.concept);
						else standing.delete(r.id);
					}
					// Later sessions in this run reuse the names just given.
					for (const r of results) if (r.concept && !concepts.includes(r.concept)) concepts.push(r.concept);
					done += batch.length;
					onProgress?.(done, todo.length);
				}
			}
			slot.lastError = undefined;
			slot.failedAt = undefined;
		} catch (err) {
			slot.lastError = err instanceof Error ? err.message : String(err);
			slot.failedAt = Date.now();
		}
	})();
	// Cleared after it settles, not in a finally: a run with nothing to do
	// (or no model) ends synchronously, and a finally would clear the slot
	// before this assignment, leaving a settled run there for good — every
	// later kick returned it and new cards were never checked.
	slot.running = run;
	void run.then(() => {
		if (slot.running === run) slot.running = undefined;
	});
	return run;
}

// ─── topic fields ───────────────────────────────────────────────────────────

/** Topics labelled per call, and the questions shown per topic. */
const FIELD_BATCH = 20;
const FIELD_QUESTIONS = 5;

type Fielder = typeof fieldTopics;
let fielder: Fielder = fieldTopics;
const fielderKey = "__lhTopicFielder";
function fielderSlot(): CheckerSlot {
	const g = globalThis as typeof globalThis & { [fielderKey]?: CheckerSlot };
	return (g[fielderKey] ??= {});
}

/** Test seam: a scripted fielder replaces the model call. */
export function setTopicFielder(fn: Fielder | null): void {
	fielder = fn ?? fieldTopics;
	const slot = fielderSlot();
	slot.failedAt = undefined;
	slot.lastError = undefined;
}

/** Label every topic with reviewable cards that has no field yet. A paired
 *  phone leaves fresh topics to the computer, like the card checks. Never throws. */
export function kickTopicFields(): Promise<void> {
	const slot = fielderSlot();
	if (slot.running) return slot.running;
	if (slot.failedAt && Date.now() - slot.failedAt < RETRY_MS) return Promise.resolve();
	const run = (async () => {
		try {
			const fields = readFields();
			const checks = readChecks();
			const byTopic = new Map<string, ReviewCard[]>();
			for (const c of allCards()) {
				if (fields.has(c.chatId) || checks.get(c.id)?.verdict !== "ok") continue;
				byTopic.set(c.chatId, [...(byTopic.get(c.chatId) ?? []), c]);
			}
			const defer = deferToComputer();
			const todo = [...byTopic].filter(([, cards]) => !defer || cards.some((c) => Date.now() - Date.parse(c.firstAnswer.at) > PHONE_DEFER_MS));
			if (todo.length === 0) return;
			const engine = fielder === fieldTopics ? auditorEngine() : undefined;
			const titles = new Map(todo.map(([id, cards]) => [id, cards[0]!.chatTitle]));
			const known = [...fields].filter(([id, f]) => f.length && titleOf(id)).map(([id, f]) => ({ title: titleOf(id)!, fields: f }));
			for (let i = 0; i < todo.length; i += FIELD_BATCH) {
				const batch = todo.slice(i, i + FIELD_BATCH).map(([id, cards]) => ({
					id,
					title: titles.get(id)!,
					questions: cards.slice(0, FIELD_QUESTIONS).map((c) => c.questionText.replace(/\s+/g, " ").slice(0, 200)),
				}));
				const results = await fielder({ topics: batch, known, engine });
				const at = new Date().toISOString();
				const lines = results.filter((r) => r.fields.length).map((r) => JSON.stringify({ topic: r.id, fields: r.fields, at }));
				if (lines.length) {
					fs.mkdirSync(PATHS.data, { recursive: true });
					fs.appendFileSync(FIELDS(), `${lines.join("\n")}\n`);
					emit("reviews-changed", {});
				}
				for (const r of results) known.push({ title: titles.get(r.id) ?? r.id, fields: r.fields });
			}
			slot.lastError = undefined;
			slot.failedAt = undefined;
		} catch (err) {
			slot.lastError = err instanceof Error ? err.message : String(err);
			slot.failedAt = Date.now();
		}
	})();
	// Cleared after it settles, as in runChecks (a run can end synchronously).
	slot.running = run;
	void run.then(() => {
		if (slot.running === run) slot.running = undefined;
	});
	return run;
}

const titleOf = (chatId: string) => cache.get(chatId)?.cards[0]?.chatTitle;

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

/** One session's share of the deck (the topic picker); `related` = the
 *  topics sharing a field with it (what "Mix related topics" adds). */
export type ReviewTopic = { id: string; title: string; total: number; due: number; related: string[] };

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
	const ledger = readLedger();
	const aliases = duplicateAliases(checks);
	const ok = deckCards(cards, checks, aliases);
	// A near-duplicate's answers count toward the card standing for it.
	const events = foldDuplicates(cards, ledger, aliases);
	const settings = reviewSettingsOf(stores.settingsStore.readSettings());
	const doneToday = reviewsToday(ledger, now);
	/** What the daily limit still allows today (Infinity = no limit). */
	const left = settings.maxPerDay > 0 ? Math.max(0, settings.maxPerDay - doneToday) : Infinity;
	return { cards, checks, ledger, aliases, events, ok, due: dueCards(ok, events, now), settings, doneToday, left };
}

/** The sidebar and home badges: what can be reviewed now (the daily limit applied). */
export function reviewCounts(now = new Date()): { due: number; total: number; settings: ReviewSettings } {
	const { ok, due, left, settings } = deck(now);
	void kickReviewChecks();
	startupRecheck?.();
	return { due: Math.min(due.length, left), total: ok.length, settings };
}

/** `topic` narrows the deck to one session; with `mix`, the topics sharing
 *  a field with it join, and the round comes in a mixed order. Without a
 *  topic, `shuffle` puts every due card in one random order, and with
 *  `cluster` cards testing the same concept come side by side in it. */
export function reviewStatus(now = new Date(), opts: { topic?: string; mix?: boolean; shuffle?: boolean; cluster?: boolean; limit?: number } = {}): ReviewStatus {
	const { cards, checks, ledger, aliases, events, ok, due, settings, doneToday, left } = deck(now);
	void kickReviewChecks().then(() => kickTopicFields());
	const fields = readFields();
	const topics = new Map<string, ReviewTopic>();
	for (const c of ok) {
		const t = topics.get(c.chatId) ?? { id: c.chatId, title: c.chatTitle, total: 0, due: 0, related: [] };
		t.total++;
		topics.set(c.chatId, t);
	}
	for (const c of due) topics.get(c.chatId)!.due++;
	for (const t of topics.values()) t.related = relatedTopics(t.id, fields).filter((id) => topics.has(id));
	const scope = opts.topic ? new Set([opts.topic, ...(opts.mix ? (topics.get(opts.topic)?.related ?? []) : [])]) : null;
	const inTopic = <T extends { chatId: string }>(list: T[]) => (scope ? list.filter((c) => scope.has(c.chatId)) : list);
	const mixed = scope ? scope.size > 1 : !!opts.shuffle;
	const seed = `${opts.topic ?? "all"}:${now.toISOString().slice(0, 10)}:${doneToday}`;
	const shownDue = !mixed ? inTopic(due) : !scope && opts.cluster ? clusteredOrder(due, fields, seed) : mixedOrder(inTopic(due), seed);
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
			.filter((c) => checks.has(c.id) && checks.get(c.id)!.verdict !== "ok" && (checks.get(c.id)!.verdict !== "duplicate" || aliases.has(c.id)))
			.map((c) => ({ id: c.id, chatTitle: c.chatTitle, questionText: c.questionText, verdict: checks.get(c.id)!.verdict, reason: heldReason(c, checks.get(c.id)!, cards) })),
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
		activity: [...cards.map((c) => c.firstAnswer.at), ...ledger.map((e) => e.at)],
	};
}

/** Why a card is out of the queue: the check's reason, or for a
 *  duplicate the question it repeats. */
function heldReason(card: ReviewCard, check: ReviewCheck, cards: readonly ReviewCard[]): string | undefined {
	if (check.verdict !== "duplicate") return check.reason;
	const original = cards.find((c) => c.id === check.duplicateOf);
	return original ? `Same as “${original.questionText.slice(0, 160)}” in ${original.chatTitle}` : check.reason;
}

/** Cards the check held back (wrong answer key, unclear, a near-duplicate
 *  of an older card), with the check time — the Changes page and the
 *  session notes (changes.ts). */
export function flaggedCards(): { card: ReviewCard; check: ReviewCheck }[] {
	const checks = readChecks();
	const aliases = duplicateAliases(checks);
	const cards = allCards();
	return cards
		.filter((c) => checks.has(c.id) && checks.get(c.id)!.verdict !== "ok" && (checks.get(c.id)!.verdict !== "duplicate" || aliases.has(c.id)))
		.map((c) => {
			const check = checks.get(c.id)!;
			const reason = heldReason(c, check, cards);
			return { card: c, check: reason ? { ...check, reason } : check };
		});
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
	const aliases = duplicateAliases(checks);
	const cards = allCards();
	const card = deckCards(cards.filter((c) => c.id === cardId), checks, aliases)[0];
	if (!card) return null;
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
	const schedule = scheduleCard(card, foldDuplicates(cards, readLedger(), aliases), now);
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
