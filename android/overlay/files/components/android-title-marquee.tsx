"use client";

/**
 * Android build only (android/overlay): a session title too long for the
 * phone's header slides through instead of being cut off — scroll to the
 * end, pause, back. Short titles stay still. The distance is measured per
 * title (and on resize) into --lh-marquee-dist. It keeps sliding while the
 * title doesn't fit (a new title restarts it) and pauses while typing. The
 * sidebar's session titles slide the same way while the sidebar is open.
 */
import { useEffect } from "react";

const SELECTOR = "header button.font-title > .lh-title-text, .lh-row-title > .lh-title-text";

const seen = new WeakMap<HTMLElement, string>();

function measure() {
	for (const text of Array.from(document.querySelectorAll<HTMLElement>(SELECTOR))) {
		const box = text.parentElement!;
		const over = text.scrollWidth - box.clientWidth + 12;
		const on = over > 12;
		// A new title replays the passes from the start.
		if (on && seen.get(box) !== text.textContent && box.classList.contains("lh-marquee")) {
			box.classList.remove("lh-marquee");
			void box.offsetWidth;
		}
		seen.set(box, text.textContent ?? "");
		box.classList.toggle("lh-marquee", on);
		if (on) {
			box.style.setProperty("--lh-marquee-dist", `${-over}px`);
			// ~60px/s plus the pauses at both ends.
			box.style.setProperty("--lh-marquee-time", `${Math.max(6, (over / 60) * 2 + 3).toFixed(1)}s`);
		}
	}
}

export function AndroidTitleMarquee() {
	useEffect(() => {
		let raf = 0;
		const schedule = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(measure);
		};
		const mo = new MutationObserver(schedule);
		mo.observe(document.body, { subtree: true, childList: true, characterData: true });
		window.addEventListener("resize", schedule);
		schedule();
		// Typing anywhere pauses the slide (it competes for frames).
		const editing = () => {
			const el = document.activeElement as HTMLElement | null;
			const on = !!el && (el.isContentEditable || el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && (el as HTMLInputElement).type !== "range"));
			document.documentElement.classList.toggle("lh-editing", on);
		};
		document.addEventListener("focusin", editing);
		document.addEventListener("focusout", editing);
		return () => {
			document.removeEventListener("focusin", editing);
			document.removeEventListener("focusout", editing);
			cancelAnimationFrame(raf);
			mo.disconnect();
			window.removeEventListener("resize", schedule);
		};
	}, []);
	return null;
}
