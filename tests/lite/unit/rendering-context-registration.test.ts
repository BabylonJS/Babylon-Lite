import { describe, it, expect, vi } from "vitest";

import {
    getRenderingContextKind,
    getRenderingContexts,
    isRenderingContextRegistered,
    registerRenderingContext,
    unregisterRenderingContext,
    type EngineContext,
    type RenderingContext,
} from "../../../packages/babylon-lite/src/engine/engine";
import { createEffectRenderer, createEffectWrapper } from "../../../packages/babylon-lite/src/effect/effect-renderer";
import { createFrameGraphContext } from "../../../packages/babylon-lite/src/frame-graph/frame-graph-context";
import { addTaskAtStart } from "../../../packages/babylon-lite/src/frame-graph/frame-graph-actions";
import type { Task } from "../../../packages/babylon-lite/src/frame-graph/task";
import { addToScene, createSceneContext, disposeScene, registerScene, unregisterScene, type SceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import { _installAsyncShaderPipelinePreparation } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { Material } from "../../../packages/babylon-lite/src/material/material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { MeshGroupBuilder, Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import { createUtilityLayer } from "../../../packages/babylon-lite/src/gizmo/utility-layer";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUShaderStage" | "GPUBufferUsage" | "GPUTextureUsage"> & {
    GPUShaderStage?: { VERTEX: number; FRAGMENT: number };
    GPUBufferUsage?: { UNIFORM: number; COPY_DST: number };
    GPUTextureUsage?: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
};

gpuGlobals.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2 } as unknown as GPUShaderStage;
gpuGlobals.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8 } as unknown as GPUBufferUsage;
gpuGlobals.GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x4 } as unknown as GPUTextureUsage;

function makeMockEngine(): EngineContext {
    const device = {
        createBindGroupLayout: (descriptor: GPUBindGroupLayoutDescriptor) => descriptor as unknown as GPUBindGroupLayout,
        createBuffer: (descriptor: GPUBufferDescriptor) => ({ descriptor, destroy: () => undefined }) as unknown as GPUBuffer,
        createBindGroup: (descriptor: GPUBindGroupDescriptor) => descriptor as unknown as GPUBindGroup,
        createTexture: (descriptor: GPUTextureDescriptor) =>
            ({
                descriptor,
                createView: () => ({}) as GPUTextureView,
                destroy: () => undefined,
            }) as unknown as GPUTexture,
        queue: {
            writeBuffer: () => undefined,
        },
    } as unknown as GPUDevice;

    const eng = {
        canvas: {} as HTMLCanvasElement,
        msaaSamples: 4,
        drawCallCount: 0,
        useHighPrecisionMatrix: false,
        useFloatingOrigin: false,
        maxDevicePixelRatio: Infinity,
        _device: device,
        _context: {} as GPUCanvasContext,
        format: "bgra8unorm",
        _alphaMode: "opaque",
        _animFrameId: 0,
        _renderFn: null,
        _renderingContexts: [],
        _currentEncoder: {} as GPUCommandEncoder,
        scRT: {
            _colorView: {},
            _colorTexture: {},
            _depthTexture: null,
            _depthView: null,
            _descriptor: { format: "bgra8unorm", samples: 1, size: { width: 800, height: 600 } },
            _width: 0,
            _height: 0,
            _eager: true,
        } as unknown as import("../../../packages/babylon-lite/src/engine/render-target").RenderTarget,
        _currentDelta: 0,
        _cbs: [],
    } as unknown as EngineContext;
    const _surfaces = [eng];
    Object.assign(eng, { engine: eng, surfaces: _surfaces, _surfaces });
    return eng;
}

function makeRenderingContext(): RenderingContext {
    return {
        _kind: "test",
        _drawCallsPre: 0,
        clearColor: { r: 0, g: 0, b: 0, a: 1 },
        _update(): void {
            return;
        },
        _record(): number {
            return 0;
        },
    };
}

describe("rendering context registration helpers", () => {
    it("returns a stable live view with public context kinds and scene names", () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const utility = createUtilityLayer(engine, scene, { addDefaultLight: false });
        const frameGraph = createFrameGraphContext(engine);
        const effect = createEffectRenderer(
            engine,
            createEffectWrapper(engine, {
                fragmentWGSL: "@fragment fn main()->@location(0) vec4<f32>{return vec4<f32>(1);}",
            })
        );
        const contexts = getRenderingContexts(engine);

        expect(contexts).toBe(getRenderingContexts(engine));
        expect(contexts).toHaveLength(0);

        registerRenderingContext(engine, scene);
        registerRenderingContext(engine, utility.scene);
        registerRenderingContext(engine, frameGraph);
        registerRenderingContext(engine, effect);

        expect(contexts.map(getRenderingContextKind)).toEqual(["scene", "scene", "frame-graph-context", "effect-renderer"]);
        expect(utility.scene.name).toBe("UtilityLayer");

        unregisterRenderingContext(engine, utility.scene);
        expect(contexts.map(getRenderingContextKind)).toEqual(["scene", "frame-graph-context", "effect-renderer"]);
    });

    it("rejects a public structural object without an internal discriminator", () => {
        const context = { clearColor: { r: 0, g: 0, b: 0, a: 1 } } as RenderingContext;

        expect(() => getRenderingContextKind(context)).toThrow(new TypeError("Invalid RenderingContext: missing internal kind discriminator"));
    });

    it("registers and unregisters idempotently", () => {
        const engine = makeMockEngine();
        const context = makeRenderingContext();
        const list = engine._renderingContexts;

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
        const list = engine._renderingContexts;

        await registerScene(scene);
        await registerScene(scene);

        expect(list).toEqual([scene]);

        unregisterScene(scene);

        expect(list).toEqual([]);
    });

    it("unregisters the scene when disposing", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const list = engine._renderingContexts;

        await registerScene(scene);
        disposeScene(scene);

        expect(list).toEqual([]);
    });

    it("releases material group mesh references when disposing", () => {
        const scene = createSceneContext(makeMockEngine());
        const builder = vi.fn() as unknown as MeshGroupBuilder;
        const mesh = { material: { _buildGroup: builder }, children: [] } as unknown as Mesh;
        scene._groups.set(builder, [mesh]);

        disposeScene(scene);

        expect(scene._groups.size).toBe(0);
    });

    it("does not register resources that finish building after scene disposal", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const lateDispose = vi.fn();
        const destroy = vi.fn();
        let startBuild!: () => void;
        let finishBuild!: () => void;
        const started = new Promise<void>((resolve) => (startBuild = resolve));
        const finish = new Promise<void>((resolve) => (finishBuild = resolve));
        const builder = (async (ctx: SceneContext, meshes: Mesh[]) => {
            startBuild();
            await finish;
            const rebuild = (_target: typeof ctx, mesh: Mesh): Renderable => ({ mesh, order: 100, isTransparent: false }) as Renderable;
            for (const mesh of meshes) {
                ctx._meshDisposables.set(mesh, [lateDispose]);
            }
            return { renderables: meshes.map((mesh) => rebuild(ctx, mesh)), rebuildSingle: rebuild };
        }) as MeshGroupBuilder;
        const material = { _buildGroup: builder } as Material;
        const mesh = {
            _gpu: {
                positionBuffer: { destroy },
                normalBuffer: { destroy },
                uvBuffer: { destroy },
                indexBuffer: { destroy },
                tangentBuffer: null,
                uv2Buffer: null,
                colorBuffer: null,
            },
            material,
            children: [],
        } as unknown as Mesh;
        addToScene(scene, mesh);

        const registration = registerScene(scene);
        await started;
        disposeScene(scene);
        finishBuild();
        await registration;

        expect(isRenderingContextRegistered(engine, scene)).toBe(false);
        expect(scene._renderables).toHaveLength(0);
        expect(lateDispose).toHaveBeenCalledOnce();
    });

    it("records frame-graph tasks added before scene registration", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        let recorded = false;
        const task: Task = {
            name: "pre-scene-task",
            engine,
            scene,
            _passes: [],
            record(): void {
                recorded = true;
            },
            dispose(): void {
                return;
            },
        };

        addTaskAtStart(scene, task);
        await registerScene(scene);

        expect(recorded).toBe(true);
    });

    it("awaits async shader preparation after task preloads and before frame-graph build", async () => {
        const engine = makeMockEngine();
        const scene = createSceneContext(engine);
        const order: string[] = [];
        const task = scene._frameGraph._tasks[0]!;
        task._preload = async () => {
            order.push("preload");
        };
        _installAsyncShaderPipelinePreparation(async () => {
            order.push("prepare");
        });
        vi.spyOn(scene._frameGraph, "build").mockImplementation(() => {
            order.push("build");
        });

        await registerScene(scene);

        expect(order).toEqual(["preload", "prepare", "build"]);
    });
});
