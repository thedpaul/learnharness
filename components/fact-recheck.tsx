"use client";

/**
 * The graph view's "Recheck facts" control (src/server/fact-check.ts):
 * re-verifies every graph proposition and review card now, correcting false
 * statements. Progress rides the recheck-changed event; when a run
 * finishes, the graph refetches and what was corrected is listed below.
 */
import { Loader2Icon, ShieldCheckIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useServerEvent } from "@/components/server-events";
import { Hint } from "@/components/ui/hint";

type Status = {
	running: boolean;
	phase: "facts" | "cards" | null;
	done: number;
	total: number;
	last: { at: string; checked: number; corrected: { name: string; statement: string; reason?: string }[]; error?: string } | null;
};

export function useFactRecheck(onFinished: () => void) {
	const [status, setStatus] = useState<Status | null>(null);
	const [dismissed, setDismissed] = useState<string | null>(null);
	/** The last finished run when the view opened (undefined until the first read). */
	const baseline = useRef<string | null | undefined>(undefined);
	const lastAt = useRef<string | null>(null);
	const seq = useRef(0);
	const read = useCallback(() => {
		const mine = ++seq.current;
		fetch("/api/graph/recheck", { cache: "no-store" })
			.then((r) => r.json() as Promise<Status>)
			.then((s) => {
				if (mine !== seq.current) return; // a newer read is in flight
				const at = s.last?.at ?? null;
				if (baseline.current === undefined) baseline.current = at;
				else if (at !== lastAt.current) onFinished(); // a run finished: the graph may have changed
				lastAt.current = at;
				setStatus(s);
			})
			.catch(() => {});
	}, [onFinished]);
	useEffect(() => read(), [read]);
	useServerEvent("recheck-changed", read);
	const start = () => {
		setStatus((s) => s && { ...s, running: true, phase: "facts", done: 0, total: 0 });
		void fetch("/api/graph/recheck", { method: "POST" }).then(read, () => {});
	};
	const last = status?.last;
	const result = last && !status.running && last.at !== baseline.current && last.at !== dismissed ? last : null;
	return { status, start, result, dismiss: () => setDismissed(last?.at ?? null) };
}

export function FactRecheckButton({ status, onStart }: { status: Status | null; onStart: () => void }) {
	const running = !!status?.running;
	return (
		<div className="graph-chrome-fade-in shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
			<Hint label="Re-verify every graph fact and review card, fixing false ones (cheap model)" side="bottom">
				<button
					type="button"
					onClick={onStart}
					disabled={running}
					data-testid="graph-recheck"
					className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent disabled:opacity-60 disabled:hover:bg-transparent"
				>
					{running ? <Loader2Icon className="size-3 animate-spin" /> : <ShieldCheckIcon className="size-3" />}
					Recheck
				</button>
			</Hint>
		</div>
	);
}

/** The running recheck as a notification card: phase, count and a bar. */
export function FactRecheckProgress({ status }: { status: Status }) {
	const known = status.total > 0;
	const pct = known ? Math.round((status.done / status.total) * 100) : 0;
	const what = status.phase === "cards" ? "Rechecking review cards" : "Checking graph facts";
	return (
		<div
			role="status"
			aria-live="polite"
			className="w-72 max-w-full rounded-xl border bg-card/95 p-3 text-xs shadow-lg backdrop-blur"
			data-testid="graph-recheck-progress"
		>
			<div className="flex items-center gap-2">
				<ShieldCheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="min-w-0 flex-1 truncate text-foreground">{what}</span>
				<span className="shrink-0 tabular-nums text-muted-foreground">{known ? `${status.done}/${status.total}` : "…"}</span>
			</div>
			<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
				{known ? (
					<div className="h-full rounded-full bg-foreground/70 transition-[width] duration-500" style={{ width: `${pct}%` }} />
				) : (
					<div className="lh-recheck-indeterminate h-full w-1/3 rounded-full bg-foreground/50" />
				)}
			</div>
			<p className="mt-1.5 text-muted-foreground">
				{status.phase === "cards" ? "Step 2 of 2 · cards built on a corrected fact are held back" : "Step 1 of 2 · false facts get corrected"}
			</p>
		</div>
	);
}

export function FactRecheckResult({ result, onDismiss }: { result: NonNullable<Status["last"]>; onDismiss: () => void }) {
	return (
		<div role="status" className="w-80 max-w-full rounded-xl border bg-card/95 p-3 text-xs shadow-lg backdrop-blur" data-testid="graph-recheck-result">
			<div className="flex items-start gap-2">
				<p className="min-w-0 flex-1 text-muted-foreground">
					{result.error
						? `Recheck stopped: ${result.error}`
						: result.checked === 0
							? "Facts were already checked in the last hour; review cards were rechecked."
							: result.corrected.length
								? `Checked ${result.checked} facts; corrected ${result.corrected.length}. Review cards were rechecked too.`
								: `Checked ${result.checked} facts; all hold. Review cards were rechecked too.`}
				</p>
				<button type="button" onClick={onDismiss} aria-label="Dismiss" className="shrink-0 text-muted-foreground hover:text-foreground">
					<XIcon className="size-3.5" />
				</button>
			</div>
			{result.corrected.length > 0 && (
				<ul className="mt-2 flex max-h-60 flex-col gap-2 overflow-y-auto">
					{result.corrected.map((c, i) => (
						<li key={i}>
							<div className="font-medium text-foreground">{c.name}</div>
							<div className="text-muted-foreground">{c.statement}</div>
							{c.reason && <div className="mt-0.5 italic text-muted-foreground/80">{c.reason}</div>}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
