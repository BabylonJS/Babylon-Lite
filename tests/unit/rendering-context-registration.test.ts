import { describe, it, expect } from "vitest";

import {
    isRenderingContextRegistered,
    registerRenderingContext,
    unregisterRenderingContext,
    type EngineContext,
    type EngineContextInternal,
    type RenderingContext,
} from "../../packages/babylon-lite/src/engine/engine";
import { createSceneContext, disposeScene, registerScene, unregisterScene } from "../../packages/babylon-lite/src/scene/scene";

function makeMockEngine(): EngineContext {
    return {
        canvas: {} as HTMLCanvasElement,
        msaaSamples: 4,
        drawCallCount: 0,
        device: {} as GPUDevice,
        context: {} as GPUCanvasContext,
        format: "bgra8unorm",
        _targets: {
            msaaTexture: {} as GPUTexture,
            msaaView: {} as GPUTextureView,
            depthTexture: {} as GPUTexture,
            depthView: {} as GPUTextureView,
            width: 800,
            height: 600,
        } as EngineContextInternal["_targets"],
        _animFrameId: 0,
        _renderFn: null,
        _renderingContexts: [],
    } as EngineContextInternal;
}

function makeRenderingContext(): RenderingContext {
    return {
        _drawCallsPre: 0,
        clearColor: { r: 0, g: 0, b: 0, a: 1 },
        _update(encoder: GPUCommandEncoder): GPUCommandEncoder {
            return encoder;
        },
        _record(): number {
            return 0;
        },
    };
}

describe("rendering context registration helpers", () => {
    it("registers and unregisters idempotently", () => {
        const engine = makeMockEngine();
        const context = makeRenderingContext();
        const list = (engine as EngineContextInternal)._renderingContexts;

        expect(isRenderingContextRegistered(engine, context)).toBe(false);
        expect(registerRenderingContext(engine, context)).toBe(true);
        expect(registerRenderingContext(engine, context)).toBe(false);
        expect(isRenderingContextRegistered(engine, context)).toBe(true);
        expect(list).toEqual([context]);

        expect(unregisterRenderingContext(engine, context)).toBe(true);
        expect(unregisterRenderingContext(engine, context)).toBe(false);
        expect(isRenderingContextRegistered(engine, context)).toBe(false);
        expect(list).toEqual([]);
    });
});

describe("registerScene / unregisterScene", () => {
    it("does not duplicate a scene rendering context", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const list = (engine as EngineContextInternal)._renderingContexts;

        await registerScene(engine, scene);
        await registerScene(engine, scene);

        expect(list).toEqual([scene]);

        unregisterScene(engine, scene);

        expect(list).toEqual([]);
    });

    it("unregisters the scene when disposing", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const list = (engine as EngineContextInternal)._renderingContexts;

        await registerScene(engine, scene);
        disposeScene(scene);

        expect(list).toEqual([]);
    });
});
