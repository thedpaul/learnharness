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
	const [shownAt, setShownAt] = useState<string | null>(null);
	const wasRunning = useRef(false);
	const read = useCallback(() => {
		fetch("/api/graph/recheck", { cache: "no-store" })
			.then((r) => r.json() as Promise<Status>)
			.then((s) => {
				if (wasRunning.current && !s.running) {
					onFinished();
					setShownAt(s.last?.at ?? null);
				}
				wasRunning.current = s.running;
				setStatus(s);
			})
			.catch(() => {});
	}, [onFinished]);
	useEffect(() => read(), [read]);
	useServerEvent("recheck-changed", read);
	const start = () => {
		wasRunning.current = true;
		setStatus((s) => s && { ...s, running: true, phase: "facts", done: 0, total: 0 });
		void fetch("/api/graph/recheck", { method: "POST" }).then(read, () => {});
	};
	const result = status?.last && status.last.at === shownAt ? status.last : null;
	return { status, start, result, dismiss: () => setShownAt(null) };
}

export function FactRecheckButton({ status, onStart }: { status: Status | null; onStart: () => void }) {
	const running = !!status?.running;
	const label = !running
		? "Recheck facts"
		: status.phase === "cards"
			? "Checking cards…"
			: status.total
				? `Checking ${status.done}/${status.total}`
				: "Checking…";
	return (
		<div className="graph-chrome-fade-in shrink-0 rounded-xl border bg-card/85 px-1 py-[3px] shadow-lg backdrop-blur">
			<Hint label="Re-verify every graph fact and review card, fixing false ones (cheap model)" side="bottom">
				<button
					type="button"
					onClick={onStart}
					disabled={running}
					data-testid="graph-recheck"
					className="flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent disabled:hover:bg-transparent"
				>
					{running ? <Loader2Icon className="size-3 animate-spin" /> : <ShieldCheckIcon className="size-3" />}
					<span className="max-sm:hidden">{label}</span>
					{running && <span className="sm:hidden">{status.total ? `${status.done}/${status.total}` : "…"}</span>}
				</button>
			</Hint>
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
