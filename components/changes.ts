"use client";

/**
 * Changes (src/server/changes.ts) for the client: the sidebar's unseen
 * count, a session's flagged questions, the Changes page's list. Refetched
 * on changes-changed (a new finding, something seen, a sync) and when the
 * window comes back.
 */
import { useCallback, useEffect, useState } from "react";
import { useServerEvent } from "@/components/server-events";

export type Change =
	| {
			id: string;
			kind: "card";
			at: string;
			seen: boolean;
			chatId: string;
			chatTitle: string;
			toolCallId: string;
			questionText: string;
			verdict: "wrong" | "unclear";
			reason?: string;
	  }
	| { id: string; kind: "fact"; at: string; seen: boolean; nodeId: string; name: string; statement: string; was: string; reason?: string };

function useRefetch(refresh: () => void) {
	useEffect(() => {
		refresh();
		const onVisible = () => {
			if (document.visibilityState === "visible") refresh();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [refresh]);
	useServerEvent("changes-changed", refresh);
}

/** The sidebar row: how many changes exist, how many are unseen. */
export function useChangeCounts(): { unseen: number; total: number } {
	const [counts, setCounts] = useState({ unseen: 0, total: 0 });
	const refresh = useCallback(() => {
		fetch("/api/changes?count=1", { cache: "no-store" })
			.then((r) => r.json() as Promise<{ unseen: number; total: number }>)
			.then(setCounts)
			.catch(() => {});
	}, []);
	useRefetch(refresh);
	return counts;
}

/** The full list (or one session's): null while loading. */
export function useChanges(chatId?: string): Change[] | null {
	const [items, setItems] = useState<Change[] | null>(null);
	const refresh = useCallback(() => {
		fetch(chatId ? `/api/changes?chat=${encodeURIComponent(chatId)}` : "/api/changes", { cache: "no-store" })
			.then((r) => r.json() as Promise<{ items: Change[] }>)
			.then((j) => setItems(j.items))
			.catch(() => {});
	}, [chatId]);
	useRefetch(refresh);
	return items;
}

export function markChangesSeen(ids: string[]): void {
	if (ids.length === 0) return;
	void fetch("/api/changes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) }).catch(() => {});
}
