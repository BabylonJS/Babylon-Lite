import { describe, expect, it, vi } from "vitest";

import { rebuildRenderables } from "../../../packages/babylon-lite/src/engine/recovery-rebuild.js";
import type { Renderable } from "../../../packages/babylon-lite/src/render/renderable.js";

function makeRenderable(order: number, rebuild?: Renderable["_rebuild"]): Renderable {
    return { order, isTransparent: false, bind: vi.fn(), _rebuild: rebuild } as unknown as Renderable;
}

describe("rebuildRenderables", () => {
    it("builds nothing when no renderable opted into rebuilding", async () => {
        await expect(rebuildRenderables([])).resolves.toEqual([]);
    });

    it("returns each thunk's renderable in the order it was discovered", async () => {
        const first = makeRenderable(0);
        const second = makeRenderable(200);

        await expect(rebuildRenderables([() => first, () => second])).resolves.toEqual([first, second]);
    });

    it("awaits async builders, so a refetching background cannot be pushed out of order", async () => {
        // The ground and DDS-skybox builders are async because they refetch their texture. A
        // concurrent replay would resolve them in completion order rather than scene order.
        const slow = makeRenderable(0);
        const fast = makeRenderable(200);

        const rebuilt = await rebuildRenderables([() => new Promise<Renderable>((resolve) => setTimeout(() => resolve(slow), 10)), () => fast]);

        expect(rebuilt).toEqual([slow, fast]);
    });

    it("runs each thunk exactly once", async () => {
        const rebuild = vi.fn(() => makeRenderable(0));

        await rebuildRenderables([rebuild]);

        expect(rebuild).toHaveBeenCalledOnce();
    });

    it("propagates a builder failure so recovery reports it rather than rendering a partial scene", async () => {
        const boom = new Error("texture fetch failed");

        await expect(rebuildRenderables([() => makeRenderable(0), () => Promise.reject(boom)])).rejects.toThrow(boom);
    });

    it("carries the rebuild thunk onto the replacement, so a second device loss still recovers", async () => {
        // Builders stamp `_rebuild` on every renderable they produce, including the ones they
        // produce during recovery. Losing that on the first rebuild would silently break the
        // second loss, which no single-loss test would catch.
        const build = (): Renderable => {
            const r = makeRenderable(0);
            r._rebuild = build;
            return r;
        };

        const [afterFirstLoss] = await rebuildRenderables([build]);
        expect(afterFirstLoss?._rebuild).toBeTypeOf("function");

        const [afterSecondLoss] = await rebuildRenderables([afterFirstLoss!._rebuild!]);
        expect(afterSecondLoss?._rebuild).toBeTypeOf("function");
    });
});
