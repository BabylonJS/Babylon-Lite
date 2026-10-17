import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { Texture2D } from "../../../packages/babylon-lite/src/texture/texture-2d.js";

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

function engineFixture() {
    const device = {
        createTexture: vi.fn(() => ({ createView: vi.fn(() => ({})), destroy: vi.fn() })),
        createSampler: vi.fn(() => ({})),
        pushErrorScope: vi.fn(),
        popErrorScope: vi.fn(async () => null),
        queue: { writeTexture: vi.fn() },
    };
    const engine = { _device: device, _renderingContexts: [] } as unknown as EngineContext;
    Object.assign(engine, { engine });
    return { engine, device };
}

describe("fresh-runtime area emission opt-in", () => {
    it("rejects an ordinary emission image before a first preprocessing call without fetching, allocating, or publishing a solid fallback", async () => {
        const [{ createSceneContext, disposeScene }, { createRectAreaLight }, { createSolidTexture2D }, { enableRectAreaLights }, { releaseTexture }] = await Promise.all([
            import("../../../packages/babylon-lite/src/scene/scene.js"),
            import("../../../packages/babylon-lite/src/light/rect-area-light.js"),
            import("../../../packages/babylon-lite/src/texture/solid-texture.js"),
            import("../../../packages/babylon-lite/src/light/enable-rect-area-lights.js"),
            import("../../../packages/babylon-lite/src/resource/texture-release.js"),
        ]);
        const f = engineFixture();
        const scene = createSceneContext(f.engine, { defaultRenderTask: false });
        const light = createRectAreaLight([0, 0, 1], 2, 2);
        const ordinary = createSolidTexture2D(f.engine, 1, 1, 1, 1);
        light.emissionTexture = ordinary;
        scene.lights.push(light);
        const initialDisposers = scene._disposables.length;
        f.device.createTexture.mockClear();
        const fetcher = vi.fn();
        vi.stubGlobal("fetch", fetcher);
        await expect(enableRectAreaLights(scene)).rejects.toThrow(/processAreaLightTexture/);
        expect(fetcher).not.toHaveBeenCalled();
        expect(f.device.createTexture).not.toHaveBeenCalled();
        expect(scene._disposables).toHaveLength(initialDisposers);
        expect(scene._lighting).toBeUndefined();
        releaseTexture(ordinary);
        disposeScene(scene);
    });

    it("enables solid lights without importing emission setup or allocating emitter arrays", async () => {
        const [{ createSceneContext, disposeScene }, { createRectAreaLight }, { enableRectAreaLights }] = await Promise.all([
            import("../../../packages/babylon-lite/src/scene/scene.js"),
            import("../../../packages/babylon-lite/src/light/rect-area-light.js"),
            import("../../../packages/babylon-lite/src/light/enable-rect-area-lights.js"),
        ]);
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(new ArrayBuffer(65536)))
        );
        const f = engineFixture();
        const scene = createSceneContext(f.engine, { defaultRenderTask: false });
        scene.lights.push(createRectAreaLight([0, 0, 1], 2, 2));
        await enableRectAreaLights(scene);
        expect(f.device.createTexture).toHaveBeenCalledTimes(2);
        expect(scene._lighting?._bindingId).toBeUndefined();
        expect(scene._lighting!._single!("rectArea")!.getSingleLightBlock()).not.toContain("roughness,lightIndex");
        disposeScene(scene);
    });

    it.each([undefined, false, 1, "image"])("rejects malformed assignment %s without bumping dirty state", async (value) => {
        const { createRectAreaLight } = await import("../../../packages/babylon-lite/src/light/rect-area-light.js");
        const light = createRectAreaLight([0, 0, 1], 2, 2);
        const version = light._lightVersion;
        expect(() => {
            light.emissionTexture = value as unknown as Texture2D;
        }).toThrow(/Texture2D or null/);
        expect(light.emissionTexture).toBeNull();
        expect(light._lightVersion).toBe(version);
    });
});
