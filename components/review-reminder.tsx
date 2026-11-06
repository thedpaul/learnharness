"use client";

/**
 * Review reminders (Reviews → Schedule): at the scheduled times, tell the
 * learner when cards are ready.
 *   Android: the schedule and the latest count go to the native side
 *   (LHAndroidReminders), which sets an alarm, so the reminder comes even
 *   when the app is closed.
 *   Desktop: a system notification while the app runs, once per slot, when
 *   something is due (the daily limit applied).
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { useServerEvent } from "@/components/server-events";
import { lastReviewTime, remindersPaused, type ReviewSettings } from "@/src/core";

export const REVIEW_SETTINGS_EVENT = "lh:review-settings";

type Counts = { due: number; total: number; settings: ReviewSettings };
type AndroidReminders = { configure(json: string): void };

const REMINDED_KEY = "lh:review-reminded";
/** A slot missed by more than this (computer asleep, app closed) is skipped. */
const LATE_MS = 3 * 60 * 60_000;
const TICK_MS = 30_000;
const POLL_MS = 5 * 60_000;

export function ReviewReminder() {
	const router = useRouter();
	const counts = useRef<Counts | null>(null);

	const tick = useCallback(() => {
		const c = counts.current;
		if (!c?.settings.notify || c.due === 0 || typeof Notification === "undefined" || Notification.permission !== "granted") return;
		const now = new Date();
		if (remindersPaused(c.settings, now)) return;
		const slot = lastReviewTime(c.settings.schedule, now);
		if (!slot || now.getTime() - slot.getTime() > LATE_MS) return;
		const key = slot.toISOString();
		if (window.localStorage.getItem(REMINDED_KEY) === key) return;
		window.localStorage.setItem(REMINDED_KEY, key);
		const n = new Notification("Time for your reviews", {
			body: `${c.due} card${c.due === 1 ? " is" : "s are"} ready.`,
			tag: "lh-reviews",
		});
		n.onclick = () => {
			window.focus();
			router.push("/review");
			n.close();
		};
	}, [router]);

	const refresh = useCallback(() => {
		fetch("/api/reviews?count=1", { cache: "no-store" })
			.then((r) => r.json() as Promise<Counts>)
			.then((c) => {
				if (!c.settings) return;
				counts.current = c;
				const android = (window as unknown as { LHAndroidReminders?: AndroidReminders }).LHAndroidReminders;
				android?.configure(JSON.stringify({ notify: c.settings.notify, days: c.settings.schedule?.days ?? [], time: c.settings.schedule?.time ?? "", due: c.due, pausedUntil: c.settings.pausedUntil ? Date.parse(c.settings.pausedUntil) : 0 }));
				tick();
			})
			.catch(() => {});
	}, [tick]);

	useEffect(() => {
		refresh();
		const poll = setInterval(refresh, POLL_MS);
		const clock = setInterval(tick, TICK_MS);
		window.addEventListener(REVIEW_SETTINGS_EVENT, refresh);
		return () => {
			clearInterval(poll);
			clearInterval(clock);
			window.removeEventListener(REVIEW_SETTINGS_EVENT, refresh);
		};
	}, [refresh, tick]);
	useServerEvent("reviews-changed", refresh);
	return null;
}
