"use client";

/**
 * Android build only (android/overlay): on a phone the question/practice
 * dock covers most of the screen and scrolls on its own, separate from the
 * session history behind it — so a swipe that reaches the dock's top or
 * bottom went nowhere. Here it carries on into the history: past the
 * dock's top it scrolls to earlier messages, past its bottom to later
 * ones, with a fling's momentum.
 */
import { useEffect } from "react";

function historyScroller(): HTMLElement | null {
	const log = document.querySelector<HTMLElement>('[role="log"]');
	if (!log) return null;
	for (const el of Array.from(log.children) as HTMLElement[]) {
		if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
	}
	return null;
}

export function AndroidDockScroll() {
	useEffect(() => {
		let dock: HTMLElement | null = null;
		let history: HTMLElement | null = null;
		let lastY = 0;
		let lastT = 0;
		let velocity = 0; // px per ms, positive = towards later messages
		let chaining = false;
		let fling = 0;

		const stopFling = () => {
			if (fling) cancelAnimationFrame(fling);
			fling = 0;
		};
		const onStart = (e: TouchEvent) => {
			stopFling();
			const target = e.target instanceof Element ? e.target : null;
			dock = target?.closest<HTMLElement>("[data-dock-scroll-area]") ?? null;
			history = dock ? historyScroller() : null;
			lastY = e.touches[0]?.clientY ?? 0;
			lastT = e.timeStamp;
			velocity = 0;
			chaining = false;
		};
		const onMove = (e: TouchEvent) => {
			if (!dock || !history || e.touches.length !== 1) return;
			const y = e.touches[0]!.clientY;
			const dy = lastY - y; // > 0: finger moving up = scroll towards later
			const dt = Math.max(1, e.timeStamp - lastT);
			lastY = y;
			lastT = e.timeStamp;
			const atTop = dock.scrollTop <= 0;
			const atBottom = dock.scrollTop + dock.clientHeight >= dock.scrollHeight - 1;
			if ((dy < 0 && atTop) || (dy > 0 && atBottom)) {
				if (e.cancelable) e.preventDefault();
				history.scrollTop += dy;
				velocity = 0.8 * (dy / dt) + 0.2 * velocity;
				chaining = true;
			} else {
				chaining = false;
			}
		};
		const onEnd = () => {
			const el = history;
			if (!chaining || !el || Math.abs(velocity) < 0.05) return;
			let v = velocity;
			let prev = performance.now();
			const step = (now: number) => {
				const dt = now - prev;
				prev = now;
				el.scrollTop += v * dt;
				v *= Math.pow(0.995, dt);
				fling = Math.abs(v) > 0.02 ? requestAnimationFrame(step) : 0;
			};
			fling = requestAnimationFrame(step);
		};

		const capture = { capture: true } as const;
		document.addEventListener("touchstart", onStart, { passive: true, capture: true });
		document.addEventListener("touchmove", onMove, { passive: false, capture: true });
		document.addEventListener("touchend", onEnd, capture);
		document.addEventListener("touchcancel", onEnd, capture);
		return () => {
			stopFling();
			document.removeEventListener("touchstart", onStart, capture);
			document.removeEventListener("touchmove", onMove, capture);
			document.removeEventListener("touchend", onEnd, capture);
			document.removeEventListener("touchcancel", onEnd, capture);
		};
	}, []);
	return null;
}
