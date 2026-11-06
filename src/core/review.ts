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
 * CALIBRATION reads every confidence-rated answer (sessions and reviews):
 * per confidence bin, how often the learner was actually right.
 */
import type { QuestionAnswerData } from "./question-core.ts";

export interface ReviewCard {
	/** `${chatId}:${toolCallId}` — stable across syncs and devices. */
	id: string;
	chatId: string;
	chatTitle: string;
	/** The plan node the question was about (teach checks), if any. */
	nodeId?: string;
	questionText: string;
	options: { index: number; label: string }[];
	correctIndices: number[];
	explanation?: string;
	/** The answer in the session: the first point on the schedule. */
	firstAnswer: ReviewAnswer;
}

export interface ReviewAnswer {
	at: string;
	correct: boolean;
	/** 0-100; absent on "I don't know". */
	confidence?: number;
}

/** One reviews.jsonl line. */
export interface ReviewEvent extends ReviewAnswer {
	card: string;
}

/** Minimal structural slice of the native record (LhMessage). */
interface NativeLike {
	role?: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	details?: unknown;
}

/** Cards from one session's native messages: graded quiz answers with
 *  options and a known correct answer. Dismissed questions never count. */
export function extractReviewCards(chatId: string, chatTitle: string, messages: readonly NativeLike[]): ReviewCard[] {
	const nodeOf = new Map<string, string>();
	for (const m of messages) {
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const b of m.content as Array<{ type?: string; id?: string; arguments?: unknown }>) {
			if (b.type !== "toolCall" || typeof b.id !== "string") continue;
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
			options: d.options.map((o) => ({ index: o.index, label: o.label })),
			correctIndices: [...d.correctIndices],
			explanation: d.explanation,
			firstAnswer: {
				at: d.answeredAt,
				correct: d.correct === true,
				confidence: d.dontKnow ? undefined : d.confidence,
			},
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
		unsure = h.correct && (h.confidence ?? 0) < UNSURE_BELOW;
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
