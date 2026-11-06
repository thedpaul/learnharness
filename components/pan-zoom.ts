/**
 * Shared pan/zoom viewport math — the "fit floor" semantics harvested from
 * the plan popup (plan-graph rounds 2–4) so the session overlays (the plan
 * focus, the mermaid focus) run the SAME geometry: fully zoomed out IS the
 * fit (whichever axis binds), panning locks at the floor (nothing to move),
 * wheel zooms to the cursor. Pure on purpose: the overlays are render-tested
 * in static markup (no live pointer events), so the math lives here where
 * tests can pin it (tests/pan-zoom.test.ts).
 */

/** Zoom ceiling for every surface that uses this math (raised 2×→4× for
 *  reading node titles closely, owner, plan-graph round 3). */
export const ZOOM_MAX = 4;
/** Viewport breathing room subtracted by the fit. */
export const FIT_PAD = 16;
/** The fit never zooms IN past this — a tiny diagram must not blow up. */
export const FIT_ZOOM_MAX = 1.5;

/** A pan/zoom viewport state (translate + scale; origin top-left). */
export interface Viewport {
	zoom: number;
	x: number;
	y: number;
}

/** The fit zoom for a box in a viewport: never below a true fit (the old
 *  0.15 floor could sit ABOVE the fit for wide graphs — the epsilon only
 *  guards degenerate viewports), never above FIT_ZOOM_MAX. Pure. */
export function fitZoomFor(box: { w: number; h: number }, viewport: { w: number; h: number }): number {
	if (!viewport.w || !viewport.h || box.w === 0) return 1;
	return Math.max(0.02, Math.min((viewport.w - FIT_PAD) / box.w, (viewport.h - FIT_PAD) / box.h, FIT_ZOOM_MAX));
}

/** Centers a box (at the given zoom) in the viewport. Pure. */
export function fitGraphView(box: { w: number; h: number }, viewport: { w: number; h: number }, zoom: number): Viewport {
	return { zoom, x: (viewport.w - box.w * zoom) / 2, y: (viewport.h - box.h * zoom) / 2 };
}

/** Zoom by `factor` keeping `focus` (viewport coordinates) visually fixed,
 *  clamped to [floor, ZOOM_MAX]. At the floor the view re-fits + RE-CENTERS
 *  (the fit IS the floor — a locked view there has nothing to move). Pure. */
export function zoomedGraphView(
	view: Viewport,
	factor: number,
	floor: number,
	focus: { x: number; y: number },
	box: { w: number; h: number },
	viewport: { w: number; h: number },
): Viewport {
	const zoom = Math.min(Math.max(view.zoom * factor, floor), ZOOM_MAX);
	if (zoom === view.zoom) return view;
	if (zoom <= floor) return fitGraphView(box, viewport, floor);
	const k = zoom / view.zoom;
	return { zoom, x: focus.x - (focus.x - view.x) * k, y: focus.y - (focus.y - view.y) * k };
}

/** One frame of a two-finger pinch: the scale change since the last frame,
 *  the fingers' midpoint (client coordinates), and how far it moved. */
export interface PinchStep {
	factor: number;
	mid: { x: number; y: number };
	dx: number;
	dy: number;
}

type PointerLike = { pointerId: number; clientX: number; clientY: number };

/**
 * Two-finger pinch on a pan/zoom viewport (touch screens). Pointer-based,
 * so it rides the viewports' existing pointer handlers: feed it every
 * down/move/up; while it reports a pinch, the one-finger drag stands down.
 */
export class PinchTracker {
	private points = new Map<number, { x: number; y: number }>();
	private last: { dist: number; mid: { x: number; y: number } } | null = null;

	get pinching(): boolean {
		return this.last !== null;
	}

	/** Returns true when this pointer starts (or joins) a pinch. */
	down(e: PointerLike): boolean {
		this.points.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (this.points.size < 2) return false;
		this.last = this.measure();
		return true;
	}

	/** The pinch step for this move, or null when not pinching. */
	move(e: PointerLike): PinchStep | null {
		if (!this.points.has(e.pointerId)) return null;
		this.points.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (!this.last) return null;
		const now = this.measure();
		const step: PinchStep = {
			factor: this.last.dist > 0 ? now.dist / this.last.dist : 1,
			mid: now.mid,
			dx: now.mid.x - this.last.mid.x,
			dy: now.mid.y - this.last.mid.y,
		};
		this.last = now;
		return step;
	}

	up(e: PointerLike): void {
		this.points.delete(e.pointerId);
		this.last = this.points.size >= 2 ? this.measure() : null;
	}

	private measure(): { dist: number; mid: { x: number; y: number } } {
		const [a, b] = [...this.points.values()];
		return { dist: Math.hypot(b!.x - a!.x, b!.y - a!.y), mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 } };
	}
}

/** Apply a pinch step: zoom about the fingers' midpoint and pan with it
 *  (at the fit floor the view stays fitted — nothing to pan). Pure. */
export function pinchedGraphView(
	view: Viewport,
	step: PinchStep,
	floor: number,
	origin: { left: number; top: number },
	box: { w: number; h: number },
	viewport: { w: number; h: number },
): Viewport {
	const next = zoomedGraphView(view, step.factor, floor, { x: step.mid.x - origin.left, y: step.mid.y - origin.top }, box, viewport);
	return next.zoom <= floor + 1e-9 ? next : { ...next, x: next.x + step.dx, y: next.y + step.dy };
}
