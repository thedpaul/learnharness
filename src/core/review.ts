/**
 * Spaced reviews + calibration (pure; no IO).
 *
 * CARDS derive from the record, never stored: every graded quiz answer in a
 * session (the question call's tool result — its `details` is the full
 * QuestionAnswerData snapshot: question, options, correct indices,
 * explanation, the learner's answer and confidence) is one card. Review
 * HISTORY is an append-only ledger (reviews.jsonl, one line per review),
 * and the SCHEDULE derives from the session answer plus those lines —
 * Leitner boxes, the same "position derives, nothing tracks" rule as the
 * plan statuses.
 *
 * CHECKS gate the deck: a card enters reviews only after a model has
 * checked it (src/agent/subagents/card-checker.ts) — the answer key is
 * right, the question stands on its own (else the check writes the context
 * it needs), and every option gets a one-line note. Checks are a second
 * ledger (review-checks.jsonl), so they sync like the reviews.
 *
 * CALIBRATION reads every confidence-rated answer (sessions and reviews):
 * per confidence bin, how often the learner was actually right.
 */
import { seededRandom, type QuestionAnswerData } from "./question-core.ts";

export interface ReviewCard {
	/** `${chatId}:${toolCallId}` — stable across syncs and devices. */
	id: string;
	chatId: string;
	chatTitle: string;
	/** The plan node the question was about (teach checks), if any. */
	nodeId?: string;
	/** A practice problem (owner, 2026-11-07): no options — reviewed by
	 *  working it, revealing `solution` and grading yourself. Absent = a
	 *  multiple-choice quiz card. */
	kind?: "problem";
	/** The problem's model solution (problem cards). */
	solution?: string;
	questionText: string;
	/** Stored order; `note` = the authoring model's per-option comment. */
	options: { index: number; label: string; note?: string }[];
	correctIndices: number[];
	explanation?: string;
	/** The answer in the session: the first point on the schedule. */
	firstAnswer: ReviewAnswer;
	/** The teaching right before the question (server-side, for the check). */
	lead?: string;
	/** From the check: what the question needs to stand on its own. */
	context?: string;
	/** From the check: the concept it tests (clusters related cards across topics). */
	concept?: string;
}

export interface ReviewAnswer {
	at: string;
	correct: boolean;
	/** 0-100; absent on "I don't know". */
	confidence?: number;
	/** Right but needed help (a practice problem solved with hints): the
	 *  next interval is halved, as for a low-confidence right answer. */
	hinted?: boolean;
}

/** One reviews.jsonl line. */
export interface ReviewEvent extends ReviewAnswer {
	card: string;
}

const LEAD_CHARS = 4000;

/** Minimal structural slice of the native record (LhMessage). */
interface NativeLike {
	role?: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	details?: unknown;
	isError?: boolean;
	timestamp?: number;
}

/** Concluded practice problems: every outcome but a dismissal. */
const PROBLEM_OUTCOMES: Record<string, { correct: boolean; hinted?: boolean }> = {
	solved: { correct: true },
	solvedWithHints: { correct: true, hinted: true },
	movedOn: { correct: false },
	surrendered: { correct: false },
};

/** Cards from a practice session: one per concluded problem (owner,
 *  2026-11-07), keyed by the problem call. The outcome is the first answer. */
function extractProblemCards(chatId: string, chatTitle: string, messages: readonly NativeLike[]): ReviewCard[] {
	const failed = new Set<string>();
	for (const m of messages) if (m.role === "toolResult" && m.isError && typeof m.toolCallId === "string") failed.add(m.toolCallId);
	const cards: ReviewCard[] = [];
	let lead = "";
	let posed: { id: string; statement: string; solution: string; lead: string } | undefined;
	const concluded = new Map<string, { outcome: string; problem: NonNullable<typeof posed> }>();
	for (const m of messages) {
		if (m.role === "user") lead = "";
		if (m.role === "toolResult" && typeof m.toolCallId === "string") {
			const hit = concluded.get(m.toolCallId);
			const first = hit && !m.isError ? PROBLEM_OUTCOMES[hit.outcome] : undefined;
			if (hit && first) {
				cards.push({
					id: `${chatId}:${hit.problem.id}`,
					chatId,
					chatTitle,
					kind: "problem",
					questionText: hit.problem.statement,
					solution: hit.problem.solution,
					options: [],
					correctIndices: [],
					firstAnswer: {
						at: new Date(typeof m.timestamp === "number" ? m.timestamp : 0).toISOString(),
						correct: first.correct,
						...(first.hinted ? { hinted: true } : {}),
					},
					lead: hit.problem.lead || undefined,
				});
			}
			concluded.delete(m.toolCallId);
			continue;
		}
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const b of m.content as Array<{ type?: string; id?: string; name?: string; text?: string; arguments?: unknown }>) {
			if (b.type === "text" && typeof b.text === "string") lead = `${lead}\n\n${b.text}`.slice(-LEAD_CHARS);
			if (b.type !== "toolCall" || typeof b.id !== "string" || failed.has(b.id)) continue;
			const args = (b.arguments ?? {}) as { statement?: unknown; modelSolution?: unknown; outcome?: unknown };
			if (b.name === "problem" && typeof args.statement === "string" && typeof args.modelSolution === "string") {
				posed = { id: b.id, statement: args.statement, solution: args.modelSolution, lead: lead.trim() };
			} else if (b.name === "conclude" && posed && typeof args.outcome === "string") {
				concluded.set(b.id, { outcome: args.outcome, problem: posed });
				posed = undefined;
			}
		}
	}
	return cards;
}

/** Cards from one session's native messages: graded quiz answers with
 *  options and a known correct answer, and concluded practice problems.
 *  Dismissed questions and problems never count. */
export function extractReviewCards(chatId: string, chatTitle: string, messages: readonly NativeLike[]): ReviewCard[] {
	return [...extractQuizCards(chatId, chatTitle, messages), ...extractProblemCards(chatId, chatTitle, messages)];
}

function extractQuizCards(chatId: string, chatTitle: string, messages: readonly NativeLike[]): ReviewCard[] {
	const nodeOf = new Map<string, string>();
	const leadOf = new Map<string, string>();
	// The teaching since the learner last spoke: what a question leans on.
	let lead = "";
	for (const m of messages) {
		if (m.role === "user") lead = "";
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const b of m.content as Array<{ type?: string; id?: string; text?: string; arguments?: unknown }>) {
			if (b.type === "text" && typeof b.text === "string") lead = `${lead}\n\n${b.text}`.slice(-LEAD_CHARS);
			if (b.type !== "toolCall" || typeof b.id !== "string") continue;
			leadOf.set(b.id, lead.trim());
			const nodeId = (b.arguments as { nodeId?: unknown } | undefined)?.nodeId;
			if (typeof nodeId === "string") nodeOf.set(b.id, nodeId);
		}
	}
	const cards: ReviewCard[] = [];
	for (const m of messages) {
		if (m.role !== "toolResult" || typeof m.toolCallId !== "string") continue;
		const d = m.details as Partial<QuestionAnswerData> | undefined;
		if (!d || d.kind !== "quiz" || d.dismissed) continue;
		if (!Array.isArray(d.options) || d.options.length < 2) continue;
		if (!Array.isArray(d.correctIndices) || d.correctIndices.length === 0) continue;
		if (typeof d.questionText !== "string" || typeof d.answeredAt !== "string") continue;
		cards.push({
			id: `${chatId}:${m.toolCallId}`,
			chatId,
			chatTitle,
			nodeId: nodeOf.get(m.toolCallId),
			questionText: d.questionText,
			options: d.options.map((o) => ({ index: o.index, label: o.label, ...(o.note ? { note: o.note } : {}) })),
			correctIndices: [...d.correctIndices],
			explanation: d.explanation,
			firstAnswer: {
				at: d.answeredAt,
				correct: d.correct === true,
				confidence: d.dontKnow ? undefined : d.confidence,
			},
			lead: leadOf.get(m.toolCallId) || undefined,
		});
	}
	return cards;
}

/** Days until the next review, per box. A wrong answer goes back to box 0. */
export const REVIEW_BOX_DAYS = [1, 3, 7, 16, 35, 80] as const;
const DAY_MS = 86_400_000;
/** Right but unsure (confidence below this): the interval is halved. */
const UNSURE_BELOW = 50;

export interface CardSchedule {
	box: number;
	lastAt: string;
	dueAt: string;
	due: boolean;
	reviews: number;
}

/** The schedule after the session answer and every review of this card. */
export function scheduleCard(card: ReviewCard, events: readonly ReviewEvent[], now: Date): CardSchedule {
	const history = [card.firstAnswer, ...events.filter((e) => e.card === card.id)].sort((a, b) => a.at.localeCompare(b.at));
	let box = -1;
	let unsure = false;
	for (const h of history) {
		box = h.correct ? Math.min(box + 1, REVIEW_BOX_DAYS.length - 1) : 0;
		// No confidence on a right answer = a practice problem's outcome,
		// where only `hinted` says it was shaky.
		unsure = h.correct && (h.hinted === true || (h.confidence ?? 100) < UNSURE_BELOW);
	}
	box = Math.max(box, 0);
	const last = history.at(-1)!;
	const days = REVIEW_BOX_DAYS[box]! * (unsure ? 0.5 : 1);
	const dueAt = new Date(Date.parse(last.at) + days * DAY_MS);
	return { box, lastAt: last.at, dueAt: dueAt.toISOString(), due: dueAt.getTime() <= now.getTime(), reviews: history.length - 1 };
}

/** Due cards, most overdue first. */
export function dueCards(cards: readonly ReviewCard[], events: readonly ReviewEvent[], now: Date): Array<ReviewCard & { schedule: CardSchedule }> {
	return cards
		.map((c) => ({ ...c, schedule: scheduleCard(c, events, now) }))
		.filter((c) => c.schedule.due)
		.sort((a, b) => a.schedule.dueAt.localeCompare(b.schedule.dueAt));
}

// ─── settings: daily limit, schedule ────────────────────────────────────────

/** settings.json → reviews (PUT /api/settings/reviews). */
export interface ReviewSettings {
	/** New reviews a day; 0 = no limit. */
	maxPerDay: number;
	/** When to remind: local weekdays (0 = Sunday) at "HH:MM". */
	schedule: { days: number[]; time: string } | null;
	/** Remind at the scheduled times when something is due. */
	notify: boolean;
	/** Reminders paused until this ISO time (null = not paused). */
	pausedUntil: string | null;
}

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = { maxPerDay: 0, schedule: null, notify: false, pausedUntil: null };

/** Whether reminders are paused at `now`. */
export const remindersPaused = (s: ReviewSettings, now: Date): boolean => !!s.pausedUntil && Date.parse(s.pausedUntil) > now.getTime();

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The stored section, or null when malformed (the parser's 400). */
export function parseReviewSettings(raw: unknown): ReviewSettings | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const out: ReviewSettings = { ...DEFAULT_REVIEW_SETTINGS };
	if (r.maxPerDay !== undefined) {
		if (typeof r.maxPerDay !== "number" || !Number.isInteger(r.maxPerDay) || r.maxPerDay < 0 || r.maxPerDay > 1000) return null;
		out.maxPerDay = r.maxPerDay;
	}
	if (r.schedule !== undefined && r.schedule !== null) {
		const sc = r.schedule as { days?: unknown; time?: unknown };
		if (typeof sc !== "object" || !Array.isArray(sc.days) || typeof sc.time !== "string" || !TIME_RE.test(sc.time)) return null;
		const days = [...new Set(sc.days)];
		if (!days.every((d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6)) return null;
		out.schedule = { days: days.sort(), time: sc.time };
	}
	if (r.notify !== undefined) {
		if (typeof r.notify !== "boolean") return null;
		out.notify = r.notify;
	}
	if (r.pausedUntil !== undefined && r.pausedUntil !== null) {
		if (typeof r.pausedUntil !== "string" || Number.isNaN(Date.parse(r.pausedUntil))) return null;
		out.pausedUntil = new Date(r.pausedUntil).toISOString();
	}
	return out;
}

/** The settings as stored, defaults for anything missing or malformed. */
export function reviewSettingsOf(record: object | null | undefined): ReviewSettings {
	return parseReviewSettings((record as { reviews?: unknown } | null | undefined)?.reviews ?? {}) ?? DEFAULT_REVIEW_SETTINGS;
}

/** The next scheduled time strictly after `after`, in the runtime's local time. */
export function nextReviewTime(schedule: ReviewSettings["schedule"], after: Date): Date | null {
	if (!schedule || schedule.days.length === 0) return null;
	const [h, m] = schedule.time.split(":").map(Number) as [number, number];
	for (let i = 0; i <= 7; i++) {
		const d = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i, h, m, 0, 0);
		if (schedule.days.includes(d.getDay()) && d.getTime() > after.getTime()) return d;
	}
	return null;
}

/** The most recent scheduled time at or before `now` (the slot a reminder belongs to). */
export function lastReviewTime(schedule: ReviewSettings["schedule"], now: Date): Date | null {
	if (!schedule || schedule.days.length === 0) return null;
	const [h, m] = schedule.time.split(":").map(Number) as [number, number];
	for (let i = 0; i <= 7; i++) {
		const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, h, m, 0, 0);
		if (schedule.days.includes(d.getDay()) && d.getTime() <= now.getTime()) return d;
	}
	return null;
}

/** Reviews done since local midnight (the daily limit's count). */
export function reviewsToday(events: readonly ReviewEvent[], now: Date): number {
	const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	return events.filter((e) => Date.parse(e.at) >= midnight && Date.parse(e.at) <= now.getTime()).length;
}

// ─── calibration ────────────────────────────────────────────────────────────

export interface CalibrationBin {
	/** Bin centre, 0..100 in steps of 10 (the dock's slider grid). */
	confidence: number;
	count: number;
	/** Share answered correctly, 0..1. */
	accuracy: number;
}

export interface Calibration {
	bins: CalibrationBin[];
	count: number;
	/** Mean squared error of confidence vs outcome, 0 (perfect) .. 1. */
	brier: number | null;
	/** Mean confidence − accuracy, in points: > 0 overconfident, < 0 under. */
	bias: number | null;
}

export function calibration(answers: readonly ReviewAnswer[]): Calibration {
	const rated = answers.filter((a): a is ReviewAnswer & { confidence: number } => typeof a.confidence === "number" && Number.isFinite(a.confidence));
	const byBin = new Map<number, { n: number; right: number }>();
	let sq = 0;
	let conf = 0;
	let right = 0;
	for (const a of rated) {
		const c = Math.max(0, Math.min(100, a.confidence));
		const bin = Math.round(c / 10) * 10;
		const slot = byBin.get(bin) ?? { n: 0, right: 0 };
		slot.n++;
		if (a.correct) slot.right++;
		byBin.set(bin, slot);
		const y = a.correct ? 1 : 0;
		sq += (c / 100 - y) ** 2;
		conf += c;
		right += y;
	}
	const n = rated.length;
	return {
		bins: [...byBin.entries()].sort((a, b) => a[0] - b[0]).map(([confidence, s]) => ({ confidence, count: s.n, accuracy: s.right / s.n })),
		count: n,
		brier: n ? sq / n : null,
		bias: n ? conf / n - (100 * right) / n : null,
	};
}

// ─── streak ─────────────────────────────────────────────────────────────────

/** Consecutive days with any answer, ending today or yesterday (local days:
 *  `tzOffsetMinutes` is Date#getTimezoneOffset of the viewer). */
export function streakDays(timestamps: readonly string[], now: Date, tzOffsetMinutes: number): number {
	const day = (ms: number) => Math.floor((ms - tzOffsetMinutes * 60_000) / DAY_MS);
	const days = new Set(timestamps.map((t) => day(Date.parse(t))).filter(Number.isFinite));
	let d = day(now.getTime());
	if (!days.has(d)) d--; // today not studied yet: the streak still counts
	let n = 0;
	while (days.has(d)) {
		n++;
		d--;
	}
	return n;
}

/** Parse reviews.jsonl text; bad lines are skipped. */
export function parseReviewLedger(text: string): ReviewEvent[] {
	const out: ReviewEvent[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line) as Partial<ReviewEvent>;
			if (typeof e.card === "string" && typeof e.at === "string" && typeof e.correct === "boolean") {
				out.push({ card: e.card, at: e.at, correct: e.correct, confidence: typeof e.confidence === "number" ? e.confidence : undefined });
			}
		} catch {
			/* a torn line from a crash: skip */
		}
	}
	return out;
}

// ─── checks ─────────────────────────────────────────────────────────────────

/** Bump to re-check every card (a better checker, a new rule). An older
 *  check keeps its card in the deck until the re-check replaces it; a
 *  check from a newer build is ignored. v2: notes in LaTeX. v3: the
 *  explanation rewritten for shuffled options. v4: the concept. v5:
 *  near-duplicates of an older card. */
export const REVIEW_CHECK_VERSION = 5;

export type ReviewVerdict = "ok" | "wrong" | "unclear" | "duplicate";

/** One review-checks.jsonl line; per card the highest version wins, then the newest. */
export interface ReviewCheck {
	card: string;
	at: string;
	v: number;
	verdict: ReviewVerdict;
	/** Why a card was held back (wrong / unclear). */
	reason?: string;
	/** Markdown the card needs to stand on its own (shown above the question). */
	context?: string;
	/** One line per option, by option index ("1", "2", …). */
	notes?: Record<string, string>;
	/** The explanation rewritten for review (options shuffled); absent = the tutor's stands. */
	explanation?: string;
	/** The concept the card tests, a short name shared across topics (v4+). */
	concept?: string;
	/** A "duplicate" card: the older card it repeats (v5+). */
	duplicateOf?: string;
}

export function parseReviewChecks(text: string): Map<string, ReviewCheck> {
	const out = new Map<string, ReviewCheck>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const c = JSON.parse(line) as Partial<ReviewCheck>;
			if (typeof c.card !== "string" || typeof c.at !== "string") continue;
			if (typeof c.v !== "number" || c.v < 1 || c.v > REVIEW_CHECK_VERSION) continue;
			if (c.verdict !== "ok" && c.verdict !== "wrong" && c.verdict !== "unclear" && c.verdict !== "duplicate") continue;
			const prev = out.get(c.card);
			if (prev && (prev.v > c.v || (prev.v === c.v && prev.at > c.at))) continue;
			out.set(c.card, {
				card: c.card,
				at: c.at,
				v: c.v,
				verdict: c.verdict,
				...(typeof c.reason === "string" && c.reason ? { reason: c.reason } : {}),
				...(typeof c.context === "string" && c.context.trim() ? { context: c.context.trim() } : {}),
				...(c.notes && typeof c.notes === "object" ? { notes: c.notes } : {}),
				...(typeof c.explanation === "string" && c.explanation.trim() ? { explanation: c.explanation.trim() } : {}),
				...(typeof c.concept === "string" && c.concept.trim() ? { concept: c.concept.trim() } : {}),
				...(typeof c.duplicateOf === "string" && c.duplicateOf ? { duplicateOf: c.duplicateOf } : {}),
			});
		} catch {
			/* a torn line: skip */
		}
	}
	return out;
}

/** A check made by an older checker: still valid, due for a re-check. */
export function checkIsStale(check: ReviewCheck | undefined): boolean {
	return !!check && check.v < REVIEW_CHECK_VERSION;
}

/** The card as reviewed: the check's context, its explanation rewritten
 *  for shuffled options when it made one, and per-option notes (the
 *  authoring model's own first, the check's for older cards). */
export function checkedCard(card: ReviewCard, check: ReviewCheck | undefined): ReviewCard {
	if (!check) return card;
	return {
		...card,
		...(check.context ? { context: check.context } : {}),
		...(check.explanation ? { explanation: check.explanation } : {}),
		...(check.concept ? { concept: check.concept } : {}),
		options: card.options.map((o) => {
			const note = o.note ?? check.notes?.[String(o.index)];
			return note ? { ...o, note } : o;
		}),
	};
}

// ─── related topics (the "mix related topics" toggle) ──────────────────────

/** Fields per topic (session id), from data/review-fields.jsonl: one line per
 *  labelling, `{ topic, fields, at }`, the newest line per topic wins. A
 *  model labels each topic once (src/agent/subagents/topic-fielder.ts). */
export function parseTopicFields(text: string): Map<string, string[]> {
	const newest = new Map<string, { at: string; fields: string[] }>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			continue;
		}
		const r = raw as { topic?: unknown; fields?: unknown; at?: unknown };
		if (typeof r.topic !== "string" || typeof r.at !== "string" || !Array.isArray(r.fields)) continue;
		const fields = r.fields.filter((f): f is string => typeof f === "string" && f.trim() !== "").map((f) => f.trim());
		const prev = newest.get(r.topic);
		if (!prev || r.at > prev.at) newest.set(r.topic, { at: r.at, fields });
	}
	return new Map([...newest].map(([topic, v]) => [topic, v.fields]));
}

const fieldKey = (f: string) => f.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The topics sharing at least one field with `topic` (never itself). */
export function relatedTopics(topic: string, fields: ReadonlyMap<string, readonly string[]>): string[] {
	const mine = new Set((fields.get(topic) ?? []).map(fieldKey).filter(Boolean));
	if (mine.size === 0) return [];
	return [...fields]
		.filter(([other, theirs]) => other !== topic && theirs.some((f) => mine.has(fieldKey(f))))
		.map(([other]) => other);
}

/** A mixed round: the due cards of several topics in a seeded random
 *  order, so related topics interleave instead of coming in blocks. */
export function mixedOrder<T>(cards: readonly T[], seed: string): T[] {
	const rand = seededRandom(seed);
	const out = [...cards];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

/** The concept names in use, most used first (the checker reuses them so
 *  cards from different topics land on the same name). */
/** Duplicate card → the card that stands for it in the deck: its chain of
 *  duplicateOf followed to an "ok" card. A duplicate whose chain ends
 *  anywhere else (a held or missing card, a loop) has nothing standing for
 *  it, so it is absent here and reviewed as itself. */
export function duplicateAliases(checks: ReadonlyMap<string, ReviewCheck>): Map<string, string> {
	const out = new Map<string, string>();
	for (const [id, check] of checks) {
		if (check.verdict !== "duplicate") continue;
		const seen = new Set([id]);
		let at = check.duplicateOf;
		while (at && !seen.has(at) && checks.get(at)?.verdict === "duplicate") {
			seen.add(at);
			at = checks.get(at)!.duplicateOf;
		}
		if (at && !seen.has(at) && checks.get(at)?.verdict === "ok") out.set(id, at);
	}
	return out;
}

/** The cards the deck holds: "ok" ones, and duplicates nothing stands for. */
export function deckCards(cards: readonly ReviewCard[], checks: ReadonlyMap<string, ReviewCheck>, aliases: ReadonlyMap<string, string>): ReviewCard[] {
	return cards
		.filter((c) => {
			const v = checks.get(c.id)?.verdict;
			return v === "ok" || (v === "duplicate" && !aliases.has(c.id));
		})
		.map((c) => checkedCard(c, checks.get(c.id)));
}

/** The review history with duplicates folded into the card standing for
 *  them: their reviews, and their first answer from the lesson, count as
 *  answers to it. */
export function foldDuplicates(cards: readonly ReviewCard[], events: readonly ReviewEvent[], aliases: ReadonlyMap<string, string>): ReviewEvent[] {
	if (aliases.size === 0) return [...events];
	const folded = events.map((e) => (aliases.has(e.card) ? { ...e, card: aliases.get(e.card)! } : e));
	for (const c of cards) {
		const to = aliases.get(c.id);
		if (to) folded.push({ ...c.firstAnswer, card: to });
	}
	return folded;
}

export function knownConcepts(checks: Iterable<ReviewCheck>, max = 150): string[] {
	const counts = new Map<string, { name: string; n: number }>();
	for (const c of checks) {
		if (!c.concept) continue;
		const key = fieldKey(c.concept);
		const hit = counts.get(key) ?? { name: c.concept, n: 0 };
		hit.n++;
		counts.set(key, hit);
	}
	return [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, max).map((c) => c.name);
}

/** A shuffled round with related cards side by side: cards testing the same
 *  concept form one run whatever their topic (a card without a concept yet
 *  runs with its topic's field, else its topic); the runs come in a random
 *  order, and so do the cards inside each run. */
export function clusteredOrder<T extends { chatId: string; concept?: string }>(
	cards: readonly T[],
	fields: ReadonlyMap<string, readonly string[]>,
	seed: string,
): T[] {
	const groups = new Map<string, T[]>();
	for (const c of cards) {
		const field = fields.get(c.chatId)?.[0];
		const key = c.concept ? `c:${fieldKey(c.concept)}` : field ? `f:${fieldKey(field)}` : `t:${c.chatId}`;
		groups.set(key, [...(groups.get(key) ?? []), c]);
	}
	return mixedOrder([...groups.entries()], seed).flatMap(([key, run]) => mixedOrder(run, `${seed}:${key}`));
}
