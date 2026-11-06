"use client";

/**
 * A select in the app's own dropdown look: the composer's model/thinking
 * pill as the trigger, a MenuShell card of options with a check on the
 * current one. Same contract as the model picker: a click outside or an Esc
 * closes it (the Esc is claimed so nothing behind it also reacts).
 */
import { useEffect, useRef, useState } from "react";
import { MenuShell } from "@/components/menu-shell";
import { cn } from "@/lib/utils";

export type PillOption = { value: string; label: string; hint?: string };

export function PillSelect({
	value,
	options,
	onChange,
	ariaLabel,
	testid,
	className,
	menuWidth = "w-64",
}: {
	value: string;
	options: PillOption[];
	onChange: (next: string) => void;
	ariaLabel: string;
	testid?: string;
	/** Extra trigger classes (width, e.g. "w-full"). */
	className?: string;
	menuWidth?: string;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const current = options.find((o) => o.value === value);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			const t = e.target as Element;
			if (t instanceof Element && t.closest("[data-lh-menu]")) return;
			if (ref.current && !ref.current.contains(t)) setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	return (
		<div ref={ref} className={cn("relative min-w-0", className)}>
			<button
				type="button"
				aria-label={ariaLabel}
				aria-haspopup="listbox"
				aria-expanded={open}
				data-testid={testid}
				onClick={() => setOpen((o) => !o)}
				className="flex w-full min-w-0 items-center gap-1.5 rounded-full border bg-card/85 px-3 py-1 font-ui text-sm shadow-lg backdrop-blur transition-colors hover:border-border hover:bg-muted"
			>
				<span className="min-w-0 flex-1 truncate text-left text-card-foreground">{current?.label ?? "—"}</span>
				{current?.hint && <span className="shrink-0 text-xs text-muted-foreground">{current.hint}</span>}
				<span aria-hidden className="shrink-0 text-xs text-muted-foreground">▾</span>
			</button>
			{open && (
				<MenuShell
					anchorRef={ref}
					testid={testid ? `${testid}-menu` : "pill-select-menu"}
					preferredSide="down"
					align="left"
					menuClass={cn("flex max-w-[calc(100vw-1rem)] flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl", menuWidth)}
				>
					{options.map((o) => (
						<button
							key={o.value}
							type="button"
							role="option"
							aria-selected={o.value === value}
							onClick={() => {
								setOpen(false);
								if (o.value !== value) onChange(o.value);
							}}
							className={cn(
								"flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-card-foreground transition-colors hover:bg-muted",
								o.value === value && "bg-muted/60",
							)}
						>
							<span className="min-w-0 flex-1 truncate">{o.label}</span>
							{o.hint && <span className="shrink-0 text-muted-foreground">{o.hint}</span>}
							<span aria-hidden className={cn("w-3 shrink-0 text-right", o.value !== value && "invisible")}>✓</span>
						</button>
					))}
				</MenuShell>
			)}
		</div>
	);
}
