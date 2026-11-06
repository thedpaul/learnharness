"use client";

/**
 * Spaced reviews (src/core/review.ts): your own past quiz questions, re-asked
 * on a schedule — one card at a time, graded on the spot, no model call.
 * Below the queue: streak, deck size and the calibration chart.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CalibrationChart } from "@/components/calibration-chart";
import { CONFIDENCE_COLORS, confidenceRailStyle } from "@/components/confidence-rail";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { playCue } from "@/components/sound-cues";
import { TopBar } from "@/components/top-bar";
import { GlyphMark } from "@/components/ui/glyph-mark";
import { cn } from "@/lib/utils";
import { CONFIDENCE_STOPS, DEFAULT_CONFIDENCE_INDEX, streakDays, type Calibration } from "@/src/core";

type Question = {
	id: string;
	chatId: string;
	chatTitle: string;
	questionText: string;
	options: { index: number; label: string }[];
	multiple: boolean;
	box: number;
};
type Status = { due: number; total: number; queue: Question[]; calibration: Calibration; activity: string[] };
type Result = { correct: boolean; correctIndices: number[]; explanation?: string; nextDueAt: string };

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

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/reviews", { cache: "no-store" });
			setStatus((await res.json()) as Status);
			setI(0);
		} catch {
			setError("Couldn't load your reviews.");
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);

	const card = status?.queue[i];
	const streak = status ? streakDays(status.activity, new Date(), new Date().getTimezoneOffset()) : 0;

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
				<div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-6">
					{error && <p className="text-sm text-destructive">{error}</p>}
					{!status && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
					{status && card && (
						<ReviewCardView
							key={card.id}
							card={card}
							position={`${i + 1} / ${status.queue.length}`}
							onNext={(right) => {
								setDone((d) => ({ right: d.right + (right ? 1 : 0), total: d.total + 1 }));
								if (i + 1 < status.queue.length) setI(i + 1);
								else void load();
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
					{status && (
						<section className="flex flex-col gap-3 border-t border-border pt-6">
							<h2 className="font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">Calibration</h2>
							<CalibrationChart data={status.calibration} />
						</section>
					)}
				</div>
			</div>
		</div>
	);
}

function ReviewCardView({ card, position, onNext }: { card: Question; position: string; onNext: (right: boolean) => void }) {
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
		try {
			const res = await fetch("/api/reviews", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ card: card.id, selected, confidence: CONFIDENCE_STOPS[confIdx] }),
			});
			const json = (await res.json()) as Result & { message?: string };
			if (!res.ok) throw new Error(json.message ?? "Couldn't save the answer");
			setResult(json);
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
			<div className="lh-prose text-[0.95rem]">
				<ToolContentResponse>{card.questionText}</ToolContentResponse>
			</div>
			{card.multiple && !result && <p className="-mt-2 text-xs text-muted-foreground">Pick every answer that applies.</p>}
			<div className="flex flex-col gap-2">
				{card.options.map((opt) => {
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
