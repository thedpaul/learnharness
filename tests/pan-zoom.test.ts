/**
 * Pure tests for the shared pan/zoom viewport math (components/pan-zoom.ts),
 * harvested from the plan popup so the mermaid focus overlay runs the same
 * fit-floor geometry: fully zoomed out IS the fit, panning locks at the
 * floor (and re-centers), wheel zooms to the cursor, ceiling 4×. Pure
 * function coverage — no DOM, no rendering (the overlays' live pointer
 * wiring is exercised in the browser; these tests pin the math it runs).
 */

import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { FIT_ZOOM_MAX, PinchTracker, ZOOM_MAX, fitGraphView, fitZoomFor, pinchedGraphView, zoomedGraphView } from "../components/pan-zoom.ts";

describe("fitZoomFor", () => {
	it("binds on the axis that runs out of room (wide box → width)", () => {
		assert.equal(fitZoomFor({ w: 800, h: 400 }, { w: 400, h: 300 }), 384 / 800);
	});

	it("binds on height for a tall box", () => {
		assert.equal(fitZoomFor({ w: 400, h: 800 }, { w: 400, h: 300 }), 284 / 800);
	});

	it("caps the fit at FIT_ZOOM_MAX — a tiny box must not blow up", () => {
		assert.equal(fitZoomFor({ w: 50, h: 50 }, { w: 1000, h: 1000 }), FIT_ZOOM_MAX);
	});

	it("degenerate viewport (zero-sized) renders at 1×", () => {
		assert.equal(fitZoomFor({ w: 400, h: 300 }, { w: 0, h: 0 }), 1);
	});
});

describe("fitGraphView", () => {
	it("centers the box at the given zoom", () => {
		assert.deepEqual(fitGraphView({ w: 800, h: 400 }, { w: 400, h: 300 }, 0.5), {
			x: (400 - 400) / 2,
			y: (300 - 200) / 2,
			zoom: 0.5,
		});
	});
});

describe("zoomedGraphView", () => {
	const box = { w: 800, h: 400 };
	const viewport = { w: 400, h: 300 };
	const floor = fitZoomFor(box, viewport);

	it("zooms to the focus point: the focus stays visually fixed", () => {
		const out = zoomedGraphView({ x: 0, y: 0, zoom: 1 }, 1.25, floor, { x: 200, y: 150 }, box, viewport);
		assert.equal(out.zoom, 1.25);
		// focus.x - x_out = (focus.x - x_in) * k → the cursor anchors.
		assert.equal(200 - out.x, 200 * 1.25);
		assert.equal(150 - out.y, 150 * 1.25);
	});

	it("clamps at the floor and re-fits + RE-CENTERS (the fit is the floor)", () => {
		const nearFloor = { x: -100, y: 40, zoom: floor * 1.1 };
		const out = zoomedGraphView(nearFloor, 0.5, floor, { x: 200, y: 150 }, box, viewport);
		assert.deepEqual(out, fitGraphView(box, viewport, floor));
	});

	it("clamps at ZOOM_MAX", () => {
		const atMax = { x: 0, y: 0, zoom: ZOOM_MAX };
		const out = zoomedGraphView(atMax, 2, floor, { x: 200, y: 150 }, box, viewport);
		assert.deepEqual(out, atMax);
	});

	it("no-ops when the factor lands exactly on the current zoom", () => {
		const view = { x: -37, y: 12, zoom: 1 };
		const out = zoomedGraphView(view, 1, floor, { x: 0, y: 0 }, box, viewport);
		assert.equal(out, view);
	});
});

test("pinch: spreading two fingers zooms in about their midpoint; one finger never pinches", () => {
	const t = new PinchTracker();
	assert.equal(t.down({ pointerId: 1, clientX: 100, clientY: 100 }), false);
	assert.equal(t.move({ pointerId: 1, clientX: 110, clientY: 100 }), null);
	assert.equal(t.down({ pointerId: 2, clientX: 210, clientY: 100 }), true);
	const step = t.move({ pointerId: 2, clientX: 310, clientY: 100 })!;
	assert.ok(Math.abs(step.factor - 2) < 1e-9);
	assert.deepEqual(step.mid, { x: 210, y: 100 });
	assert.equal(step.dx, 50);
	t.up({ pointerId: 2, clientX: 310, clientY: 100 });
	assert.equal(t.pinching, false);
	assert.equal(t.move({ pointerId: 1, clientX: 120, clientY: 100 }), null);
});

test("pinch view: zooms about the midpoint and pans with it; pinching below the fit re-fits", () => {
	const box = { w: 1000, h: 1000 };
	const viewport = { w: 400, h: 400 };
	const floor = 0.384;
	const view = { zoom: 1, x: 0, y: 0 };
	const zoomed = pinchedGraphView(view, { factor: 2, mid: { x: 110, y: 120 }, dx: 0, dy: 0 }, floor, { left: 10, top: 20 }, box, viewport);
	assert.deepEqual(zoomed, { zoom: 2, x: -100, y: -100 }); // focus (100,100) stays put
	const panned = pinchedGraphView(view, { factor: 1.0000001, mid: { x: 10, y: 20 }, dx: 30, dy: -5 }, floor, { left: 10, top: 20 }, box, viewport);
	assert.ok(Math.abs(panned.x - 30) < 1e-3 && Math.abs(panned.y + 5) < 1e-3);
	const out = pinchedGraphView(view, { factor: 0.1, mid: { x: 200, y: 200 }, dx: 40, dy: 40 }, floor, { left: 0, top: 0 }, box, viewport);
	assert.deepEqual(out, fitGraphView(box, viewport, floor));
});
