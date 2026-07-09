/**
 * Compat gizmo interactivity API (issue #328).
 *
 * BJS gizmos expose `isEnabled` on each per-axis sub-gizmo and `xGizmo`/`yGizmo`/`zGizmo`
 * on the composite Position/Rotation/Scale gizmos. Setting `isEnabled = false` makes a
 * gizmo non-interactive (no drag, and — with the Lite dispatcher fix — no GPU hover pick)
 * while keeping it visible and following its node: the public, BJS-shaped replacement for
 * poking a native gizmo's private `_disposePointer()`.
 *
 * These are GPU-free unit tests: the wrappers are built with `Object.create` over a fake
 * Lite gizmo so no engine/device is required. They pin down that `isEnabled` proxies to the
 * Lite `drag.enabled` flag and that the composite sub-gizmo accessors reach the real
 * sub-gizmos with stable identity.
 */
import { describe, expect, it } from "vitest";

import { AxisDragGizmo, PlaneDragGizmo, PlaneRotationGizmo, AxisScaleGizmo, PositionGizmo, RotationGizmo, ScaleGizmo } from "../src/gizmos/gizmos";

type FakeDrag = { drag: { enabled: boolean } };

function fakeLite(): FakeDrag {
    return { drag: { enabled: true } };
}

/** Build a single-axis gizmo wrapper over a fake Lite sub-gizmo (no engine). */
function wrap<T>(ctor: { _fromLite(lite: unknown, layer: unknown): T }, lite: unknown): T {
    return ctor._fromLite(lite, {} as unknown);
}

describe("compat gizmo isEnabled proxy", () => {
    it.each([
        ["AxisDragGizmo", AxisDragGizmo],
        ["PlaneDragGizmo", PlaneDragGizmo],
        ["PlaneRotationGizmo", PlaneRotationGizmo],
        ["AxisScaleGizmo", AxisScaleGizmo],
    ] as const)("%s.isEnabled reads/writes the Lite drag.enabled flag", (_name, ctor) => {
        const lite = fakeLite();
        const g = wrap(ctor as unknown as { _fromLite(l: unknown, y: unknown): { isEnabled: boolean } }, lite);

        expect(g.isEnabled).toBe(true);
        g.isEnabled = false;
        expect(lite.drag.enabled).toBe(false);
        expect(g.isEnabled).toBe(false);
        g.isEnabled = true;
        expect(lite.drag.enabled).toBe(true);
    });
});

describe("compat composite gizmo sub-gizmo accessors", () => {
    function fakeComposite(): { xGizmo: FakeDrag; yGizmo: FakeDrag; zGizmo: FakeDrag } {
        return { xGizmo: fakeLite(), yGizmo: fakeLite(), zGizmo: fakeLite() };
    }

    function makeComposite<T>(Ctor: { prototype: T }, lite: unknown): T {
        const g = Object.create(Ctor.prototype as object) as { _lite: unknown; _layer: unknown };
        g._lite = lite;
        g._layer = {};
        return g as unknown as T;
    }

    it.each([
        ["PositionGizmo", PositionGizmo],
        ["RotationGizmo", RotationGizmo],
        ["ScaleGizmo", ScaleGizmo],
    ] as const)("%s exposes xGizmo/yGizmo/zGizmo that disable the matching Lite sub-drag", (_name, Ctor) => {
        const lite = fakeComposite();
        const g = makeComposite(Ctor as unknown as { prototype: unknown }, lite) as unknown as {
            xGizmo: { isEnabled: boolean };
            yGizmo: { isEnabled: boolean };
            zGizmo: { isEnabled: boolean };
        };

        // Identity is stable (cached wrappers).
        expect(g.xGizmo).toBe(g.xGizmo);

        // Making the whole gizmo display-only disables every axis' Lite drag.
        g.xGizmo.isEnabled = false;
        g.yGizmo.isEnabled = false;
        g.zGizmo.isEnabled = false;
        expect([lite.xGizmo.drag.enabled, lite.yGizmo.drag.enabled, lite.zGizmo.drag.enabled]).toEqual([false, false, false]);
    });
});
