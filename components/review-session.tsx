"use client";

/**
 * Spaced reviews (src/core/review.ts): your own past quiz questions, re-asked
 * on a schedule — one card at a time, graded on the spot, no model call.
 * Cards arrive checked (card-checker.ts): context when they need it, a note
 * per option. A topic picker narrows the deck to one session. Below the
 * queue: the calibration chart for the same deck.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalibrationChart } from "@/components/calibration-chart";
import { CONFIDENCE_COLORS, confidenceRailStyle } from "@/components/confidence-rail";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { playCue } from "@/components/sound-cues";
import { TopBar } from "@/components/top-bar";
import { GlyphMark } from "@/components/ui/glyph-mark";
import { cn } from "@/lib/utils";
import { useServerEvent } from "@/components/server-events";
import { CONFIDENCE_STOPS, DEFAULT_CONFIDENCE_INDEX, seededRandom, streakDays, type Calibration } from "@/src/core";

type Question = {
	id: string;
	chatId: string;
	chatTitle: string;
	context?: string;
	questionText: string;
	options: { index: number; label: string }[];
	multiple: boolean;
	box: number;
	reviews: number;
};
type Topic = { id: string; title: string; total: number; due: number };
type Held = { id: string; chatTitle: string; questionText: string; verdict: string; reason?: string };
type Status = {
	due: number;
	total: number;
	pending: number;
	checkError: string | null;
	held: Held[];
	topics: Topic[];
	queue: Question[];
	calibration: Calibration;
	activity: string[];
};
type Result = { correct: boolean; correctIndices: number[]; explanation?: string; notes: Record<string, string>; nextDueAt: string };

const TOPIC_KEY = "lh:review-topic";

const statusUrl = (topic: string) => (topic ? `/api/reviews?topic=${encodeURIComponent(topic)}` : "/api/reviews");

/** A fresh order per review: position never becomes the memory. */
function shuffled<T>(list: T[], seed: string): T[] {
	const rand = seededRandom(seed);
	const out = [...list];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

function whenLabel(iso: string): string {
	const days = Math.round((Date.parse(iso) - Date.now()) / 86_400_000);
	if (days <= 0) return "later today";
	if (days === 1) return "tomorrow";
	return `in ${days} days`;
}

export function ReviewSession() {
	const [status, setStatus] = useState<Status | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [i, setI] = useState(0);
	const [done, setDone] = useState({ right: 0, total: 0 });
	const [topic, setTopic] = useState<string | null>(null);
	const [showHeld, setShowHeld] = useState(false);
	const answering = useRef(false);

	useEffect(() => {
		setTopic(window.localStorage.getItem(TOPIC_KEY) ?? "");
	}, []);

	/** A new round: the queue restarts from the top. */
	const load = useCallback(async (t: string) => {
		try {
			const res = await fetch(statusUrl(t), { cache: "no-store" });
			setStatus((await res.json()) as Status);
			setI(0);
			setError(null);
		} catch {
			setError("Couldn't load your reviews.");
		}
	}, []);
	useEffect(() => {
		if (topic !== null) void load(topic);
	}, [topic, load]);

	/** Counts, topics, checks and calibration; the round in progress keeps its queue. */
	const refreshCounts = useCallback(async () => {
		if (topic === null) return;
		try {
			const fresh = (await (await fetch(statusUrl(topic), { cache: "no-store" })).json()) as Status;
			setStatus((s) => {
				// Nothing queued yet (cards still being checked): newly
				// checked cards start a round right away.
				if (!s || s.queue.length === 0) {
					setI(0);
					return fresh;
				}
				return { ...fresh, queue: s.queue };
			});
		} catch { /* keep the last view */ }
	}, [topic]);
	useServerEvent("reviews-changed", () => {
		if (!answering.current) void refreshCounts();
	});

	const pickTopic = (t: string) => {
		window.localStorage.setItem(TOPIC_KEY, t);
		setDone({ right: 0, total: 0 });
		setTopic(t);
	};

	const card = status?.queue[i];
	const streak = status ? streakDays(status.activity, new Date(), new Date().getTimezoneOffset()) : 0;
	const allDue = status?.topics.reduce((n, t) => n + t.due, 0) ?? 0;

	return (
		<div className="flex h-dvh min-w-0 flex-1 flex-col">
			<TopBar>
				<span className="font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">Reviews</span>
				<div className="min-w-4 flex-1" />
				{status && (
					<span className="shrink-0 whitespace-nowrap font-mono text-xs text-muted-foreground" data-testid="review-counts">
						{streak > 0 ? `${streak}d streak · ` : ""}
						{status.due} due
						<span className="max-sm:hidden"> · {status.total} cards</span>
					</span>
				)}
			</TopBar>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6">
					{status && (status.topics.length > 1 || !!topic) && (
						<select
							value={topic ?? ""}
							onChange={(e) => pickTopic(e.target.value)}
							aria-label="Topic"
							data-testid="review-topic"
							className="h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 font-ui text-sm text-foreground outline-none"
						>
							<option value="">All topics{allDue ? ` · ${allDue} due` : ""}</option>
							{topic && !status.topics.some((t) => t.id === topic) && <option value={topic}>This topic has no cards now</option>}
							{status.topics.map((t) => (
								<option key={t.id} value={t.id}>
									{t.title} · {t.due ? `${t.due} due` : `${t.total} cards`}
								</option>
							))}
						</select>
					)}
					{error && <p className="text-sm text-destructive">{error}</p>}
					{!status && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
					{status && card && (
						<ReviewCardView
							key={card.id}
							card={card}
							position={`${i + 1} / ${status.queue.length}`}
							onSubmitting={() => {
								answering.current = true;
							}}
							onAnswered={() => {
								answering.current = false;
								// Answered: out of the due set until it comes back.
								setStatus((s) => s && {
									...s,
									due: Math.max(0, s.due - 1),
									topics: s.topics.map((t) => (t.id === card.chatId ? { ...t, due: Math.max(0, t.due - 1) } : t)),
								});
								void refreshCounts();
							}}
							onNext={(right) => {
								setDone((d) => ({ right: d.right + (right ? 1 : 0), total: d.total + 1 }));
								if (i + 1 < status.queue.length) setI(i + 1);
								else void load(topic ?? "");
							}}
						/>
					)}
					{status && !card && (
						<div className="flex flex-col items-center gap-2 py-6 text-center" data-testid="review-empty">
							<p className="font-title text-2xl">{done.total > 0 ? "Done for now" : status.total === 0 ? "No reviews yet" : "All caught up"}</p>
							<p className="max-w-sm text-sm text-muted-foreground">
								{done.total > 0
									? `${done.right} of ${done.total} right this round. Each question comes back just before you'd forget it.`
									: status.total === 0
										? "Every check you answer in a teaching session becomes a review card. Start a session and they'll show up here."
										: "Nothing is due. Questions come back on a schedule: sooner when you miss them, later when you know them."}
							</p>
						</div>
					)}
					{status && (status.pending > 0 || status.held.length > 0) && (
						<div className="flex flex-col gap-1.5 text-xs text-muted-foreground" data-testid="review-checks">
							{status.pending > 0 && (
								<p data-testid="review-pending">
									{status.checkError
										? `${status.pending} new card${status.pending === 1 ? " is" : "s are"} waiting for a check: ${status.checkError}`
										: `Checking ${status.pending} new card${status.pending === 1 ? "" : "s"}: each is verified, and given context if it needs it, before it joins your reviews.`}
								</p>
							)}
							{status.held.length > 0 && (
								<>
									<button
										type="button"
										className="self-start underline underline-offset-2 hover:text-foreground"
										onClick={() => setShowHeld((v) => !v)}
										data-testid="review-held-toggle"
									>
										{status.held.length} card{status.held.length === 1 ? "" : "s"} held back by the check
									</button>
									{showHeld && (
										<ul className="flex flex-col gap-2" data-testid="review-held">
											{status.held.map((h) => (
												<li key={h.id} className="rounded-md border border-border/60 p-2">
													<div className="line-clamp-3 text-foreground/80">
														<ToolContentResponse>{h.questionText}</ToolContentResponse>
													</div>
													<div className="mt-1">
														{h.verdict === "wrong" ? "Wrong answer key" : "Unclear"}
														{h.reason ? `: ${h.reason}` : ""}
													</div>
												</li>
											))}
										</ul>
									)}
								</>
							)}
						</div>
					)}
					{status && (
						<section className="flex flex-col gap-3 border-t border-border pt-6">
							<h2 className="font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">Calibration</h2>
							<CalibrationChart data={status.calibration} />
						</section>
					)}
					{status && status.total > 0 && (
						<ResetReviews
							topicTitle={topic ? status.topics.find((t) => t.id === topic)?.title : undefined}
							onReset={async (days) => {
								const q = new URLSearchParams();
								if (days !== null) q.set("days", String(days));
								if (topic) q.set("topic", topic);
								const res = await fetch(`/api/reviews?${q}`, { method: "DELETE" });
								if (!res.ok) throw new Error();
								const { removed } = (await res.json()) as { removed: number };
								setDone({ right: 0, total: 0 });
								await load(topic ?? "");
								return removed;
							}}
						/>
					)}
				</div>
			</div>
		</div>
	);
}

const RESET_SPANS: { days: number | null; label: string }[] = [
	{ days: 1, label: "today" },
	{ days: 7, label: "the last 7 days" },
	{ days: 30, label: "the last 30 days" },
	{ days: null, label: "all time" },
];

/** Undo recent reviews: those cards fall back to their earlier schedule. Two taps, no dialog. */
function ResetReviews({ topicTitle, onReset }: { topicTitle?: string; onReset: (days: number | null) => Promise<number> }) {
	const [span, setSpan] = useState(2);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const pick = RESET_SPANS[span]!;
	const run = async () => {
		setBusy(true);
		try {
			const removed = await onReset(pick.days);
			setMessage(removed ? `Reset ${removed} review${removed === 1 ? "" : "s"}.` : "No reviews in that period.");
		} catch {
			setMessage("Couldn't reset your reviews.");
		} finally {
			setBusy(false);
			setConfirming(false);
		}
	};
	return (
		<section className="flex flex-col gap-2 border-t border-border pt-6 text-xs text-muted-foreground" data-testid="review-reset">
			<h2 className="font-ui text-xs font-medium uppercase tracking-wide">Reset reviews</h2>
			<p>
				Forget the reviews you did{topicTitle ? ` in ${topicTitle}` : ""} and start those cards over from their earlier schedule.
				Your session answers stay.
			</p>
			<div className="flex flex-wrap items-center gap-2">
				<select
					value={span}
					onChange={(e) => {
						setSpan(Number(e.target.value));
						setConfirming(false);
						setMessage(null);
					}}
					aria-label="Reset period"
					data-testid="review-reset-span"
					className="h-8 min-w-0 rounded-md border border-border bg-background px-2 font-ui text-sm text-foreground outline-none"
				>
					{RESET_SPANS.map((s, n) => (
						<option key={s.label} value={n}>
							{s.label[0]!.toUpperCase() + s.label.slice(1)}
						</option>
					))}
				</select>
				{confirming ? (
					<>
						<button
							type="button"
							disabled={busy}
							onClick={() => void run()}
							data-testid="review-reset-confirm"
							className="h-8 rounded-md bg-destructive px-3 font-ui text-sm text-white disabled:opacity-60"
						>
							Reset {pick.label}
						</button>
						<button type="button" disabled={busy} onClick={() => setConfirming(false)} className="h-8 px-2 font-ui text-sm hover:text-foreground">
							Cancel
						</button>
					</>
				) : (
					<button
						type="button"
						onClick={() => {
							setConfirming(true);
							setMessage(null);
						}}
						data-testid="review-reset-start"
						className="h-8 rounded-md border border-border px-3 font-ui text-sm text-foreground hover:bg-muted"
					>
						Reset…
					</button>
				)}
			</div>
			{message && <p data-testid="review-reset-message">{message}</p>}
		</section>
	);
}

function ReviewCardView({ card, position, onNext, onAnswered, onSubmitting }: {
	card: Question;
	position: string;
	onNext: (right: boolean) => void;
	onAnswered: () => void;
	onSubmitting: () => void;
}) {
	const options = useMemo(() => shuffled(card.options, `${card.id}:${card.reviews}`), [card]);
	const [selected, setSelected] = useState<number[]>([]);
	const [confIdx, setConfIdx] = useState(DEFAULT_CONFIDENCE_INDEX);
	const [result, setResult] = useState<Result | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const toggle = (index: number) => {
		if (result) return;
		setSelected((s) => (card.multiple ? (s.includes(index) ? s.filter((x) => x !== index) : [...s, index]) : [index]));
	};
	const submit = async () => {
		if (selected.length === 0 || busy) return;
		setBusy(true);
		setError(null);
		onSubmitting();
		try {
			const res = await fetch("/api/reviews", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ card: card.id, selected, confidence: CONFIDENCE_STOPS[confIdx] }),
			});
			const json = (await res.json()) as Result & { message?: string };
			if (!res.ok) throw new Error(json.message ?? "Couldn't save the answer");
			setResult(json);
			onAnswered();
			playCue(json.correct ? "correct" : "wrong");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Couldn't save the answer");
		} finally {
			setBusy(false);
		}
	};
	const key = new Set(result?.correctIndices ?? []);
	const value = CONFIDENCE_STOPS[confIdx]!;

	return (
		<article className="flex flex-col gap-4 rounded-2xl border bg-card p-4 shadow-lg" data-testid="review-card">
			<div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
				<Link href={`/chat/${card.chatId}`} className="min-w-0 truncate hover:text-foreground">
					{card.chatTitle}
				</Link>
				<span className="shrink-0 font-mono">{position}</span>
			</div>
			{card.context && (
				<div className="lh-prose rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground" data-testid="review-context">
					<ToolContentResponse>{card.context}</ToolContentResponse>
				</div>
			)}
			<div className="lh-prose text-[0.95rem]">
				<ToolContentResponse>{card.questionText}</ToolContentResponse>
			</div>
			{card.multiple && !result && <p className="-mt-2 text-xs text-muted-foreground">Pick every answer that applies.</p>}
			<div className="flex flex-col gap-2">
				{options.map((opt) => {
					const sel = selected.includes(opt.index);
					const right = key.has(opt.index);
					return (
						<button
							key={opt.index}
							type="button"
							onClick={() => toggle(opt.index)}
							disabled={!!result}
							data-testid="review-option"
							className={cn(
								"flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
								!result && (sel ? "border-primary bg-accent" : "hover:bg-accent/50"),
								result && sel && right && "border-green-500/60 bg-green-500/10",
								result && sel && !right && "border-red-500/60 bg-red-500/10",
								result && !sel && right && "border-green-500/40",
								result && !sel && !right && "text-muted-foreground",
							)}
						>
							{result && (sel || right) && (
								<GlyphMark kind={right ? "check" : "x"} className={cn("size-3.5 shrink-0", right ? "text-green-500" : "text-red-500")} />
							)}
							<span className="min-w-0">
								<ToolContentResponse>{opt.label}</ToolContentResponse>
								{result?.notes[String(opt.index)] && (
									<ToolContentResponse className="lh-prose block text-xs text-muted-foreground" data-testid="review-option-note">
										{result.notes[String(opt.index)]}
									</ToolContentResponse>
								)}
							</span>
						</button>
					);
				})}
			</div>
			{!result ? (
				<>
					<div className="flex items-center gap-3">
						<span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">Confidence</span>
						<div className="relative h-4 min-w-0 flex-1">
							<div
								aria-hidden
								className="pointer-events-none absolute top-1/2 left-2 right-2 h-1.5 -translate-y-1/2 rounded-full border border-border"
								style={confidenceRailStyle(value)}
							/>
							<input
								type="range"
								min={0}
								max={100}
								step={1}
								value={value}
								aria-label="Confidence — the probability your answer is correct"
								onChange={(e) => {
									const v = Number(e.target.value);
									let best = 0;
									for (let k = 1; k < CONFIDENCE_STOPS.length; k++) {
										if (Math.abs(CONFIDENCE_STOPS[k]! - v) < Math.abs(CONFIDENCE_STOPS[best]! - v)) best = k;
									}
									setConfIdx(best);
								}}
								style={{ color: CONFIDENCE_COLORS[confIdx] }}
								className={cn(
									"absolute inset-0 h-4 w-full cursor-pointer appearance-none bg-transparent outline-none",
									"[&::-webkit-slider-runnable-track]:h-4 [&::-webkit-slider-runnable-track]:bg-transparent",
									"[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-current",
								)}
							/>
						</div>
						<span className="w-9 shrink-0 text-right font-mono text-sm tabular-nums">{value}%</span>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<button
						type="button"
						onClick={() => void submit()}
						disabled={selected.length === 0 || busy}
						data-testid="review-submit"
						className="self-end rounded-lg bg-primary px-4 py-2 font-ui text-sm font-medium text-primary-foreground disabled:opacity-40"
					>
						Check
					</button>
				</>
			) : (
				<>
					<p className={cn("text-sm font-medium", result.correct ? "text-green-500" : "text-red-500")} data-testid="review-verdict">
						{result.correct ? "Correct" : "Not quite"}
						<span className="ml-2 font-normal text-muted-foreground">· back {whenLabel(result.nextDueAt)}</span>
					</p>
					{result.explanation && (
						<div className="lh-prose text-sm text-muted-foreground">
							<ToolContentResponse>{result.explanation}</ToolContentResponse>
						</div>
					)}
					<button
						type="button"
						onClick={() => onNext(result.correct)}
						data-testid="review-next"
						className="self-end rounded-lg bg-primary px-4 py-2 font-ui text-sm font-medium text-primary-foreground"
					>
						Next
					</button>
				</>
			)}
		</article>
	);
}
