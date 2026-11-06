"use client";

/**
 * Android build only (android/overlay): a session title too long for the
 * phone's header slides through instead of being cut off — scroll to the
 * end, pause, back. Short titles stay still. The distance is measured per
 * title (and on resize) into --lh-marquee-dist.
 */
import { useEffect } from "react";

const SELECTOR = "header button.font-title > .lh-title-text";

function measure() {
	for (const text of Array.from(document.querySelectorAll<HTMLElement>(SELECTOR))) {
		const box = text.parentElement!;
		const over = text.scrollWidth - box.clientWidth + 12;
		const on = over > 12;
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
		return () => {
			cancelAnimationFrame(raf);
			mo.disconnect();
			window.removeEventListener("resize", schedule);
		};
	}, []);
	return null;
}
