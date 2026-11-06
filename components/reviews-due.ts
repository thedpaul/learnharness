"use client";

/**
 * The spaced-review due count for the badges (sidebar row, home chip):
 * fetched on mount, on every reviews-changed event (an answer, a card
 * check, a sync), when the window comes back, and every few minutes (cards
 * fall due as time passes).
 */
import { useCallback, useEffect, useState } from "react";
import { useServerEvent } from "@/components/server-events";

const POLL_MS = 5 * 60_000;

export function useReviewsDue(): number {
	const [due, setDue] = useState(0);
	const refresh = useCallback(() => {
		fetch("/api/reviews?count=1", { cache: "no-store" })
			.then((r) => r.json())
			.then((j: { due?: number }) => setDue(j.due ?? 0))
			.catch(() => {});
	}, []);
	useEffect(() => {
		refresh();
		const timer = setInterval(refresh, POLL_MS);
		const onVisible = () => {
			if (document.visibilityState === "visible") refresh();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [refresh]);
	useServerEvent("reviews-changed", refresh);
	return due;
}
