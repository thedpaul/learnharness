"use client";

/**
 * Settings → Graph → "Recheck everything" (src/server/fact-check.ts, full
 * run): every graph fact and every review card checked again from scratch,
 * whatever their last check said. The everyday recheck skips what nothing
 * new bears on; this is the hard one. A confirm step shows what it covers;
 * progress shows on the graph view like any recheck.
 */
import { useCallback, useEffect, useState } from "react";
import { useServerEvent } from "@/components/server-events";
import { recheckSummary } from "@/components/fact-recheck";

const buttonClass = "rounded-sm border border-border px-2.5 py-1 font-ui text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50";

type Status = {
	running: boolean;
	phase: "facts" | "cards" | null;
	done: number;
	total: number;
	last: Parameters<typeof recheckSummary>[0] | null;
};

export function RecheckEverything() {
	const [status, setStatus] = useState<Status | null>(null);
	const [scope, setScope] = useState<{ facts: number; cards: number } | null>(null);
	const [started, setStarted] = useState(false);
	const read = useCallback(() => {
		fetch("/api/graph/recheck", { cache: "no-store" })
			.then((r) => r.json() as Promise<Status>)
			.then(setStatus)
			.catch(() => {});
	}, []);
	useEffect(() => read(), [read]);
	useServerEvent("recheck-changed", read);

	const confirm = () => {
		fetch("/api/graph/recheck?scope=1", { cache: "no-store" })
			.then((r) => r.json() as Promise<{ facts: number; cards: number }>)
			.then(setScope)
			.catch(() => setScope({ facts: 0, cards: 0 }));
	};
	const start = () => {
		setScope(null);
		setStarted(true);
		setStatus((s) => s && { ...s, running: true, phase: "facts", done: 0, total: 0 });
		void fetch("/api/graph/recheck", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ full: true }),
		}).then(read, () => {});
	};

	if (status?.running) {
		const what = status.phase === "cards" ? "Review cards" : "Facts";
		return (
			<span className="text-xs text-muted-foreground" role="status" data-testid="recheck-all-running">
				{what} {status.total ? `${status.done}/${status.total}` : "…"}
			</span>
		);
	}
	if (scope) {
		return (
			<div className="flex flex-wrap items-center justify-end gap-2" data-testid="recheck-all-confirm">
				<span className="text-xs text-muted-foreground">
					{scope.facts} facts and {scope.cards} cards
				</span>
				<button type="button" className={buttonClass} onClick={() => setScope(null)}>
					Cancel
				</button>
				<button type="button" className={buttonClass} onClick={start} data-testid="recheck-all-start">
					Recheck
				</button>
			</div>
		);
	}
	const last = started && status?.last?.full ? status.last : null;
	return (
		<div className="flex flex-col items-end gap-1">
			<button type="button" className={buttonClass} onClick={confirm} data-testid="recheck-all">
				Recheck everything…
			</button>
			{last && (
				<span className="max-w-64 text-right text-xs text-muted-foreground" data-testid="recheck-all-result">
					{last.error ? `Stopped: ${last.error}` : recheckSummary(last)}
				</span>
			)}
		</div>
	);
}
