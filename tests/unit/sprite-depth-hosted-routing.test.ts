/**
 * Sprite depth-hosted routing tests (PR 3).
 *
 * Verifies that adding a `Sprite2DLayer` with `depth: "test"` or
 * `"test-write"` to a `SceneContext` via `addToScene`:
 *   - registers a deferred builder (no eager GPU work),
 *   - lands the produced `Renderable` in the right bucket
 *     (`_transparentRenderables` for `"test"`, `_opaqueRenderables` for
 *     `"test-write"`),
 *   - registers a disposable that runs on `disposeScene`.
 *
 * Also verifies that `depth: "none"` layers throw with a message that
 * names the depth-mode requirement (`SpriteRenderer` is the correct path
 * for HUD overlays).
 */
import { describe, it, expect, vi } from "vitest";

// Stub WebGPU bit-flag enums the renderable / pipeline modules read at module-call time.
const G = globalThis as unknown as Record<string, unknown>;
G.GPUBufferUsage ??= { VERTEX: 32, INDEX: 16, UNIFORM: 64, COPY_DST: 8, MAP_WRITE: 1 };
G.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
G.GPUColorWrite ??= { ALL: 0xf };

import { createSprite2DLayer } from "../../packages/babylon-lite/src/sprite/sprite-2d";
import { addToScene, createSceneContext, disposeScene } from "../../packages/babylon-lite/src/scene/scene";
import { registerScene } from "../../packages/babylon-lite/src/scene/scene-core";
import type { SceneContextInternal } from "../../packages/babylon-lite/src/scene/scene-core";
import type { SpriteAtlas } from "../../packages/babylon-lite/src/sprite/shared/sprite-atlas";
import type { Texture2D } from "../../packages/babylon-lite/src/texture/texture-2d";
import type { EngineContext, EngineContextInternal } from "../../packages/babylon-lite/src/engine/engine";

interface MockBuffer {
    destroy: ReturnType<typeof vi.fn>;
    getMappedRange: ReturnType<typeof vi.fn>;
    unmap: ReturnType<typeof vi.fn>;
}

function mockBuffer(): MockBuffer {
    return {
        destroy: vi.fn(),
        getMappedRange: vi.fn(() => new ArrayBuffer(64)),
        unmap: vi.fn(),
    };
}

function makeMockEngine(): EngineContext {
    const queue = { writeBuffer: vi.fn() };
    const device = {
        createBuffer: vi.fn(() => mockBuffer()),
        createShaderModule: vi.fn(() => ({ _kind: "shader" })),
        createBindGroupLayout: vi.fn(() => ({ _kind: "bgl" })),
        createPipelineLayout: vi.fn(() => ({ _kind: "pl" })),
        createRenderPipeline: vi.fn(() => ({ _kind: "pipeline" })),
        createBindGroup: vi.fn(() => ({ _kind: "bg" })),
        queue,
    } as unknown as GPUDevice;

    return {
        canvas: { width: 800, height: 600 } as HTMLCanvasElement,
        msaaSamples: 4,
        drawCallCount: 0,
        device,
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

function makeMockAtlas(): SpriteAtlas {
    const texture = {
        texture: {} as GPUTexture,
        view: {} as GPUTextureView,
        sampler: {} as GPUSampler,
        width: 128,
        height: 128,
    } satisfies Texture2D;
    return {
        texture,
        textureSizePx: [128, 128],
        frames: [{ uvMin: [0, 0], uvMax: [0.25, 0.25], sourceSizePx: [32, 32], pivot: [0.5, 0.5] }],
        premultipliedAlpha: true,
    };
}

describe("addToScene with Sprite2DLayer", () => {
    it("registers a deferred builder for depth: 'none' that rejects when registerScene runs", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "none" });
        // addToScene is a cheap dispatch — the depth check lives in the dynamically
        // imported renderable module, so the throw surfaces at registerScene time.
        addToScene(scene, layer);
        await expect(registerScene(engine, scene)).rejects.toThrow(/depth/);
    });

    it("registers a deferred builder for depth: 'test' (no eager GPU work)", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        const layer = createSprite2DLayer(makeMockAtlas(), { depth: "test" });
        addToScene(scene, layer);
        expect(scene._deferredBuilders.length).toBe(1);
        // No buffers/pipelines created until registerScene runs the builder.
        const device = engine.device as unknown as { createBuffer: ReturnType<typeof vi.fn> };
        expect(device.createBuffer).not.toHaveBeenCalled();
    });

    it("routes depth: 'test' into _transparentRenderables after registerScene", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        addToScene(scene, createSprite2DLayer(makeMockAtlas(), { depth: "test" }));
        await registerScene(engine, scene);
        expect(scene._transparentRenderables.length).toBe(1);
        expect(scene._opaqueRenderables.length).toBe(0);
        expect(scene._transparentRenderables[0]!.isTransparent).toBe(true);
    });

    it("routes depth: 'test-write' into _opaqueRenderables after registerScene", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        addToScene(scene, createSprite2DLayer(makeMockAtlas(), { depth: "test-write" }));
        await registerScene(engine, scene);
        expect(scene._opaqueRenderables.length).toBe(1);
        expect(scene._transparentRenderables.length).toBe(0);
        expect(scene._opaqueRenderables[0]!.isTransparent).toBe(false);
    });

    it("disposeScene runs the depth-hosted sprite disposable", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine) as SceneContextInternal;
        addToScene(scene, createSprite2DLayer(makeMockAtlas(), { depth: "test-write" }));
        await registerScene(engine, scene);
        const device = engine.device as unknown as { createBuffer: ReturnType<typeof vi.fn> };
        const buffersBefore = device.createBuffer.mock.results.length;
        // Each created buffer is a MockBuffer with a tracked `destroy` spy.
        const allDestroySpies = device.createBuffer.mock.results.map((r) => (r.value as MockBuffer).destroy);
        expect(allDestroySpies.length).toBe(buffersBefore);
        disposeScene(scene);
        // The renderable owns 3 buffers (instance + UBO + index) → at least 3 destroys fire.
        const destroyed = allDestroySpies.filter((spy) => spy.mock.calls.length > 0).length;
        expect(destroyed).toBeGreaterThanOrEqual(3);
    });
});
