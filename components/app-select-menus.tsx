"use client";

/**
 * Every native <select> opens the app's own dropdown instead of the system
 * picker (Android's full-screen list, the desktop's OS popup). The select
 * stays the control — its value, change events, focus and keyboard stepping
 * are untouched — only the popup is replaced: the press that would open it
 * is cancelled and a MenuShell card of its options opens under it, in the
 * same look as the pill dropdowns. Picking an option sets the select's value
 * and fires a bubbling change event, so React's onChange runs as before.
 *
 * Multi-selects, list boxes (size > 1), disabled selects and any select
 * marked data-native-select keep the native behavior.
 */
import { useEffect, useRef, useState } from "react";
import { MenuShell } from "@/components/menu-shell";
import { cn } from "@/lib/utils";

type Option = { value: string; label: string; disabled: boolean };

const eligible = (t: EventTarget | null): HTMLSelectElement | null =>
	t instanceof HTMLSelectElement && !t.multiple && t.size <= 1 && !t.disabled && !t.hasAttribute("data-native-select") ? t : null;

/** Keys that open a closed select's popup (Chromium: Space, Enter, Alt+arrows, F4). */
const opensPopup = (e: KeyboardEvent) =>
	e.key === " " || e.key === "Enter" || e.key === "F4" || (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp"));

/** Set a select's value the way a user pick does (React sees the change event). */
export function pickSelectValue(select: HTMLSelectElement, value: string): void {
	if (select.value === value) return;
	const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
	if (setter) setter.call(select, value);
	else select.value = value;
	select.dispatchEvent(new Event("input", { bubbles: true }));
	select.dispatchEvent(new Event("change", { bubbles: true }));
}

export function AppSelectMenus() {
	const [open, setOpen] = useState<HTMLSelectElement | null>(null);
	const anchorRef = useRef<HTMLElement | null>(null);
	const openRef = useRef<HTMLSelectElement | null>(null);
	openRef.current = open;

	useEffect(() => {
		const show = (s: HTMLSelectElement) => {
			anchorRef.current = s;
			setOpen(s);
		};
		// The press: toggle on pointerdown, and cancel every event the
		// browser could open its own popup from (touch sends compat mouse
		// events after the pointer ones).
		const onPointerDown = (e: PointerEvent) => {
			const s = eligible(e.target);
			if (s) {
				e.preventDefault();
				s.focus({ preventScroll: true });
				if (openRef.current === s) setOpen(null);
				else show(s);
				return;
			}
			const t = e.target as Element | null;
			if (openRef.current && !(t instanceof Element && t.closest("[data-lh-select-menu]"))) setOpen(null);
		};
		const cancel = (e: Event) => {
			if (eligible(e.target)) e.preventDefault();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (openRef.current && e.key === "Escape") {
				e.stopPropagation();
				e.preventDefault();
				const s = openRef.current;
				setOpen(null);
				s.focus({ preventScroll: true });
				return;
			}
			const s = eligible(e.target);
			if (s && opensPopup(e)) {
				e.preventDefault();
				show(s);
			}
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("mousedown", cancel, true);
		document.addEventListener("click", cancel, true);
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("mousedown", cancel, true);
			document.removeEventListener("click", cancel, true);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, []);

	// The select left the page (its section closed): the menu goes with it.
	useEffect(() => {
		if (!open) return;
		const timer = window.setInterval(() => {
			if (!open.isConnected || open.disabled) setOpen(null);
		}, 300);
		return () => window.clearInterval(timer);
	}, [open]);

	if (!open) return null;
	const options: Option[] = Array.from(open.options)
		.filter((o) => !o.hidden)
		.map((o) => ({ value: o.value, label: o.label || o.text, disabled: o.disabled }));
	const current = open.value;
	const label = open.getAttribute("aria-label") ?? undefined;
	const testid = open.dataset.testid;

	return (
		<MenuShell
			anchorRef={anchorRef}
			testid={testid ? `${testid}-menu` : "select-menu"}
			preferredSide="down"
			align="left"
			menuClass="flex w-max max-w-[calc(100vw-1rem)] flex-col gap-0.5 rounded-xl border bg-card p-2 font-ui text-xs shadow-xl"
		>
			<div
				data-lh-select-menu
				role="listbox"
				aria-label={label}
				className="flex flex-col gap-0.5"
				style={{ minWidth: open.offsetWidth }}
				onKeyDown={(e) => {
					if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
					e.preventDefault();
					const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
					const at = items.indexOf(document.activeElement as HTMLButtonElement);
					const from = at < 0 ? items.findIndex((b) => b.getAttribute("aria-selected") === "true") : at;
					items[Math.max(0, Math.min(items.length - 1, from + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
				}}
			>
				{options.map((o) => (
					<button
						key={o.value}
						type="button"
						role="option"
						aria-selected={o.value === current}
						disabled={o.disabled}
						onClick={() => {
							const s = open;
							setOpen(null);
							pickSelectValue(s, o.value);
							s.focus({ preventScroll: true });
						}}
						className={cn(
							"flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-card-foreground transition-colors hover:bg-muted",
							o.value === current && "bg-muted/60",
							o.disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
						)}
					>
						<span className="min-w-0 flex-1 truncate">{o.label}</span>
						<span aria-hidden className={cn("w-3 shrink-0 text-right", o.value !== current && "invisible")}>✓</span>
					</button>
				))}
			</div>
		</MenuShell>
	);
}
