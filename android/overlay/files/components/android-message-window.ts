"use client";

/**
 * Android build only (android/overlay): opening a long session rendered
 * the whole transcript at once — markdown, math, code highlighting — which
 * pinned a phone's main thread for seconds before the session appeared.
 * A teaching turn is ONE message with many parts, so the window counts
 * parts across messages: the latest parts render first (or from a graph
 * link's target message), the older history above fills in afterwards —
 * on demand, when the learner scrolls near the top of what's rendered or
 * jumps to an unrendered message. (An idle-time backfill re-rendered the
 * whole view per slice — seconds of jank after the session opened.)
 */
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { messageIdFromHash } from "@/src/core";

const FIRST = 12; // parts rendered on open
const STEP = 8; // parts added per scroll-up batch
const NEAR_TOP_PX = 3000;

type Msg = { id: string; parts: readonly unknown[] };

export type MessageWindow = {
	showMessage(mi: number): boolean;
	showPart(mi: number, pi: number): boolean;
};

function startFor(messages: readonly Msg[], offsets: number[], total: number): number {
	const target = typeof window === "undefined" ? null : messageIdFromHash(window.location.hash);
	if (target) {
		const at = messages.findIndex((m) => m.id === target);
		return at >= 0 ? offsets[at]! : 0;
	}
	return Math.max(0, total - FIRST);
}

export function useAndroidMessageWindow(chatId: string, messages: readonly Msg[]): MessageWindow {
	const isAndroid = typeof navigator !== "undefined" && navigator.userAgent.includes("LearnHarnessAndroid");
	const { offsets, total } = useMemo(() => {
		const offsets: number[] = [];
		let total = 0;
		for (const m of messages) {
			offsets.push(total);
			total += Math.max(1, m.parts.length);
		}
		return { offsets, total };
	}, [messages]);
	// Chosen the first render that has messages, per session.
	const [state, setState] = useState<{ chatId: string; start: number } | null>(null);
	let start = 0;
	if (isAndroid && messages.length > 0) {
		if (!state || state.chatId !== chatId) {
			start = startFor(messages, offsets, total);
			setState({ chatId, start });
		} else start = state.start;
	}
	const startRef = useRef(start);
	startRef.current = start;
	const pending = isAndroid && !!state && state.chatId === chatId && state.start > 0;

	useEffect(() => {
		if (!pending) return;
		// A transition: React renders the batch in interruptible slices, so a
		// scroll in progress keeps its frames.
		const grow = (by: number) =>
			startTransition(() => setState((s) => (s && s.start > 0 ? { ...s, start: Math.max(0, s.start - by) } : s)));
		const scroller = document.querySelector<HTMLElement>("[role=log] > *");
		// One batch per render: scroll events keep firing while the last
		// batch is still rendering.
		let grownFrom = -1;
		const more = (when: (el: HTMLElement) => boolean) => () => {
			const from = startRef.current;
			if (!scroller || from === 0 || from === grownFrom || !when(scroller)) return;
			grownFrom = from;
			grow(STEP);
		};
		const nearTop = more((el) => el.scrollTop < NEAR_TOP_PX);
		const onScroll = nearTop;
		// Also on a timer: resting at the very top (or too little rendered to
		// scroll) fires no scroll event, and older history would never load.
		// Bounded — it stops once NEAR_TOP_PX of history sits above.
		const check = window.setInterval(nearTop, 500);
		scroller?.addEventListener("scroll", onScroll, { passive: true });
		// A link to a message not rendered yet: render everything; the
		// session navigation's retry loop then finds the anchor.
		const onHash = () => setState((s) => (s ? { ...s, start: 0 } : s));
		window.addEventListener("hashchange", onHash);
		return () => {
			window.clearInterval(check);
			scroller?.removeEventListener("scroll", onScroll);
			window.removeEventListener("hashchange", onHash);
		};
	}, [pending, chatId]);

	return {
		showMessage: (mi) => start === 0 || (offsets[mi] ?? 0) + Math.max(1, messages[mi]?.parts.length ?? 0) > start,
		showPart: (mi, pi) => start === 0 || (offsets[mi] ?? 0) + pi >= start,
	};
}
