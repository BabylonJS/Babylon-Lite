import { describe, expect, it } from "vitest";

import type { Bounds2D, Vec2 } from "../../../packages/babylon-lite/src/math/types";
import type { Sprite2DView } from "../../../packages/babylon-lite/src/sprite/sprite-2d";
import {
    centerSprite2DView,
    getSprite2DVisibleBoundsToRef,
    sprite2DScreenToWorldToRef,
    sprite2DWorldToScreenToRef,
} from "../../../packages/babylon-lite/src/sprite/sprite-2d-view";

const point = (): Vec2 => ({ x: 0, y: 0 });
const bounds = (): Bounds2D => ({ minX: 0, minY: 0, maxX: 0, maxY: 0 });

describe("Sprite2D view utilities", () => {
    it("preserves coordinates through an identity view", () => {
        const view: Sprite2DView = { positionPx: [0, 0], zoom: 1, rotation: 0 };

        expect(sprite2DWorldToScreenToRef(view, -12, 34, point())).toEqual({ x: -12, y: 34 });
        expect(sprite2DScreenToWorldToRef(view, -12, 34, point())).toEqual({ x: -12, y: 34 });
    });

    it("matches the renderer's world-to-screen transform", () => {
        const view: Sprite2DView = { positionPx: [10, 20], zoom: 2, rotation: Math.PI / 2 };
        const result = point();

        expect(sprite2DWorldToScreenToRef(view, 20, 40, result)).toBe(result);
        expect(result.x).toBeCloseTo(-40, 10);
        expect(result.y).toBeCloseTo(20, 10);
    });

    it("round-trips points through translated, scaled, and rotated views", () => {
        const view: Sprite2DView = { positionPx: [-73, 42], zoom: 1.75, rotation: -0.63 };
        const screen = point();
        const world = point();

        sprite2DWorldToScreenToRef(view, 151.25, -92.5, screen);
        expect(sprite2DScreenToWorldToRef(view, screen.x, screen.y, world)).toBe(world);
        expect(world.x).toBeCloseTo(151.25, 10);
        expect(world.y).toBeCloseTo(-92.5, 10);
    });

    it("unprojects framebuffer coordinates remapped from a camera sub-viewport", () => {
        const view: Sprite2DView = { positionPx: [0, 0], zoom: 1, rotation: 0 };
        const targetWidth = 800;
        const targetHeight = 600;
        const viewport = { x: 200, y: 150, width: 400, height: 300 };
        const framebufferX = 300;
        const framebufferY = 225;
        const screenX = ((framebufferX - viewport.x) * targetWidth) / viewport.width;
        const screenY = ((framebufferY - viewport.y) * targetHeight) / viewport.height;

        expect(sprite2DScreenToWorldToRef(view, screenX, screenY, point())).toEqual({ x: 200, y: 150 });
        const projected = sprite2DWorldToScreenToRef(view, 200, 150, point());
        expect(viewport.x + (projected.x * viewport.width) / targetWidth).toBe(framebufferX);
        expect(viewport.y + (projected.y * viewport.height) / targetHeight).toBe(framebufferY);
    });

    it("supports negative zoom", () => {
        const view: Sprite2DView = { positionPx: [5, 7], zoom: -2, rotation: 0 };
        const screen = sprite2DWorldToScreenToRef(view, 8, 11, point());

        expect(screen).toEqual({ x: -6, y: -8 });
        expect(sprite2DScreenToWorldToRef(view, screen.x, screen.y, point())).toEqual({ x: 8, y: 11 });
    });

    it("computes a conservative AABB for a rotated viewport", () => {
        const view: Sprite2DView = { positionPx: [10, 20], zoom: 2, rotation: Math.PI / 2 };
        const result = bounds();

        expect(getSprite2DVisibleBoundsToRef(view, 200, 100, result)).toBe(result);
        expect(result.minX).toBeCloseTo(10, 10);
        expect(result.minY).toBeCloseTo(-80, 10);
        expect(result.maxX).toBeCloseTo(60, 10);
        expect(result.maxY).toBeCloseTo(20, 10);
    });

    it("contains every inverse-projected corner at a non-axis-aligned rotation", () => {
        const view: Sprite2DView = { positionPx: [-30, 45], zoom: 1.25, rotation: 0.37 };
        const result = getSprite2DVisibleBoundsToRef(view, 320, 180, bounds());

        for (const [screenX, screenY] of [
            [0, 0],
            [320, 0],
            [0, 180],
            [320, 180],
        ] as const) {
            const world = sprite2DScreenToWorldToRef(view, screenX, screenY, point());
            expect(world.x).toBeGreaterThanOrEqual(result.minX);
            expect(world.x).toBeLessThanOrEqual(result.maxX);
            expect(world.y).toBeGreaterThanOrEqual(result.minY);
            expect(world.y).toBeLessThanOrEqual(result.maxY);
        }
    });

    it("collapses zero-size viewport bounds to the view origin", () => {
        const view: Sprite2DView = { positionPx: [10, 20], zoom: 2, rotation: 0.75 };

        expect(getSprite2DVisibleBoundsToRef(view, 0, 0, bounds())).toEqual({ minX: 10, minY: 20, maxX: 10, maxY: 20 });
    });

    it("centers a world point without changing zoom or rotation", () => {
        const view: Sprite2DView = { positionPx: [0, 0], zoom: 2, rotation: Math.PI / 2 };

        expect(centerSprite2DView(view, 300, 400, 200, 100)).toBe(view);
        expect(view.zoom).toBe(2);
        expect(view.rotation).toBe(Math.PI / 2);
        const screen = sprite2DWorldToScreenToRef(view, 300, 400, point());
        expect(screen.x).toBeCloseTo(100, 10);
        expect(screen.y).toBeCloseTo(50, 10);
    });

    it("centers a world point in an unrotated view", () => {
        const view: Sprite2DView = { positionPx: [0, 0], zoom: 2, rotation: 0 };

        centerSprite2DView(view, 300, 400, 200, 100);
        expect(view.positionPx).toEqual([250, 375]);
        expect(sprite2DWorldToScreenToRef(view, 300, 400, point())).toEqual({ x: 100, y: 50 });
    });

    it("rejects inverse operations for a non-invertible zero zoom", () => {
        const view: Sprite2DView = { positionPx: [0, 0], zoom: 0, rotation: 0 };

        expect(() => sprite2DScreenToWorldToRef(view, 0, 0, point())).toThrow(RangeError);
        expect(() => getSprite2DVisibleBoundsToRef(view, 100, 100, bounds())).toThrow(RangeError);
        expect(() => centerSprite2DView(view, 0, 0, 100, 100)).toThrow(RangeError);
        expect(sprite2DWorldToScreenToRef(view, 10, 20, point())).toEqual({ x: 0, y: 0 });
    });
});
