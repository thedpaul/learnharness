/**
 * Spaced reviews (src/core/review.ts): the deck derives from every
 * session's graded quiz answers; reviews append to data/reviews.jsonl (a
 * ledger — synced and merged by line like the graph ledgers).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import {
	calibration,
	dueCards,
	extractReviewCards,
	isCorrect,
	parseReviewLedger,
	scheduleCard,
	type Calibration,
	type ReviewCard,
	type ReviewEvent,
} from "../core/index.ts";
import { stores } from "./stores.ts";

const LEDGER = () => path.join(PATHS.data, "reviews.jsonl");

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

function readLedger(): ReviewEvent[] {
	try {
		return parseReviewLedger(fs.readFileSync(LEDGER(), "utf-8"));
	} catch {
		return [];
	}
}

/** A card as the client sees it before answering: no correct answer. */
export type ReviewQuestion = {
	id: string;
	chatId: string;
	chatTitle: string;
	questionText: string;
	options: { index: number; label: string }[];
	multiple: boolean;
	box: number;
};

export interface ReviewStatus {
	due: number;
	total: number;
	queue: ReviewQuestion[];
	calibration: Calibration;
	/** Every answer time (sessions + reviews), for the client's local-day streak. */
	activity: string[];
}

export function reviewStatus(now = new Date(), limit = 20): ReviewStatus {
	const cards = allCards();
	const events = readLedger();
	const due = dueCards(cards, events, now);
	return {
		due: due.length,
		total: cards.length,
		queue: due.slice(0, limit).map((c) => ({
			id: c.id,
			chatId: c.chatId,
			chatTitle: c.chatTitle,
			questionText: c.questionText,
			options: c.options,
			multiple: c.correctIndices.length > 1,
			box: c.schedule.box,
		})),
		calibration: calibration([...cards.map((c) => c.firstAnswer), ...events]),
		activity: [...cards.map((c) => c.firstAnswer.at), ...events.map((e) => e.at)],
	};
}

export type ReviewResult = {
	correct: boolean;
	correctIndices: number[];
	explanation?: string;
	nextDueAt: string;
};

/** Grade one review and append it to the ledger. null = unknown card. */
export function recordReview(cardId: string, selected: number[], confidence: number | undefined, now = new Date()): ReviewResult | null {
	const card = allCards().find((c) => c.id === cardId);
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
	const schedule = scheduleCard(card, [...readLedger()], now);
	return { correct, correctIndices: card.correctIndices, explanation: card.explanation, nextDueAt: schedule.dueAt };
}
