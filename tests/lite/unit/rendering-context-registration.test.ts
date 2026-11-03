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
import { moveRenderingContext } from "../../../packages/babylon-lite/src/engine/rendering-context-order";
import { createEffectRenderer, createEffectWrapper } from "../../../packages/babylon-lite/src/effect/effect-renderer";
import { createFrameGraphContext } from "../../../packages/babylon-lite/src/frame-graph/frame-graph-context";
import { addTaskAtStart } from "../../../packages/babylon-lite/src/frame-graph/frame-graph-actions";
import type { Task } from "../../../packages/babylon-lite/src/frame-graph/task";
import { addToScene, createSceneContext, disposeScene, registerScene, unregisterScene, type SceneContext } from "../../../packages/babylon-lite/src/scene/scene";
import { _installAsyncShaderPipelinePreparation, registerSceneWithShadowSupport } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { Material } from "../../../packages/babylon-lite/src/material/material";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { MeshGroupBuilder, Renderable } from "../../../packages/babylon-lite/src/render/renderable";
import { createUtilityLayer, disposeUtilityLayer, registerUtilityLayer } from "../../../packages/babylon-lite/src/gizmo/utility-layer";
import { createOverlayScene } from "../../../packages/babylon-lite/src/scene/overlay-scene";
import type { RenderTaskBase } from "../../../packages/babylon-lite/src/frame-graph/render-task-base";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUShaderStage" | "GPUBufferUsage" | "GPUTextureUsage"> & {
    GPUShaderStage?: { VERTEX: number; FRAGMENT: number };
    GPUBufferUsage?: { UNIFORM: number; COPY_DST: number };
    GPUTextureUsage?: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number };
};

gpuGlobals.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2 } as unknown as GPUShaderStage;
gpuGlobals.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x8 } as unknown as GPUBufferUsage;
gpuGlobals.GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x4 } as unknown as GPUTextureUsage;

function makeMockEngine(msaaSamples = 4): EngineContext {
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
        msaaSamples,
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

/** Ordinary-scene removal is reconciled by a lazily imported module; wait for it to apply. */
async function settleOverlayReconciliation(): Promise<void> {
    await import("../../../packages/babylon-lite/src/scene/auto-overlay-reconcile");
    await new Promise((resolve) => setTimeout(resolve, 0));
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
        const utility = createUtilityLayer(scene, { addDefaultLight: false });
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

    it.each([1, 4])("does not reconfigure a scene when registrations overlap at MSAA %i", async (samples) => {
        const engine = makeMockEngine(samples);
        const first = createSceneContext(engine);
        const second = createSceneContext(engine);
        await registerScene(first);
        let finish!: () => void;
        const pending = new Promise<void>((resolve) => (finish = resolve));
        second._frameGraph._tasks[0]!._preload = () => pending;

        const registrations = [registerScene(second), registerScene(second)];
        finish();
        await Promise.all(registrations);

        expect(getRenderingContexts(engine)).toEqual([first, second]);
        expect(second._beforeRender).toHaveLength(samples > 1 ? 1 : 0);
        second._update();
        expect((second._frameGraph._tasks[0] as RenderTaskBase)._config.clr).toBe(false);
    });

    it.each([1, 4])("places an ordinary scene after the latest scene and before non-scene contexts at MSAA %i", async (samples) => {
        const engine = makeMockEngine(samples);
        const first = createSceneContext(engine);
        const second = createSceneContext(engine);
        const third = createSceneContext(engine);
        const text = { ...makeRenderingContext(), _kind: "text-renderer" };
        const unrelated = { ...makeRenderingContext(), _kind: "frame-graph-context", _frameGraph: { _tasks: [] } };

        await registerScene(first);
        await registerScene(second);
        const secondTask = second._frameGraph._tasks[0] as RenderTaskBase;
        const secondView = {} as GPUTextureView;
        secondTask._colorAttachment.view = secondView;
        registerRenderingContext(engine, text);
        registerRenderingContext(engine, unrelated);
        await registerScene(third);

        expect(getRenderingContexts(engine)).toEqual([first, second, third, text, unrelated]);
        third._update();
        const thirdTask = third._frameGraph._tasks[0] as RenderTaskBase;
        expect(thirdTask._config.clr).toBe(false);
        if (samples > 1) {
            expect(thirdTask._colorAttachment.view).toBe(secondView);
        }
    });

    it.each([1, 4])("does not use a non-scene frame graph as the first scene's base at MSAA %i", async (samples) => {
        const engine = makeMockEngine(samples);
        const unrelated = { ...makeRenderingContext(), _kind: "frame-graph-context", _frameGraph: { _tasks: [] } };
        const scene = createSceneContext(engine);
        registerRenderingContext(engine, unrelated);

        await registerScene(scene);
        scene._update();

        expect(getRenderingContexts(engine)).toEqual([unrelated, scene]);
        expect((scene._frameGraph._tasks[0] as RenderTaskBase)._config.clr).toBe(true);
        expect(scene._beforeRender).toHaveLength(0);
    });

    it.each([1, 4])("keeps inferred overlay ordering and retargeting on each scene's own surface at MSAA %i", async (samples) => {
        const engine = makeMockEngine(samples);
        const secondary = makeMockEngine(samples);
        Object.assign(secondary, { engine });
        const first = createSceneContext(engine);
        const overlay = createSceneContext(engine);
        const secondaryFirst = createSceneContext(secondary);
        const secondaryOverlay = createSceneContext(secondary);
        const text = { ...makeRenderingContext(), _kind: "text-renderer" };
        const secondaryText = { ...makeRenderingContext(), _kind: "text-renderer" };

        await registerScene(first);
        registerRenderingContext(engine, text);
        await registerScene(secondaryFirst);
        registerRenderingContext(secondary, secondaryText);
        await registerScene(overlay);
        await registerScene(secondaryOverlay);
        expect(getRenderingContexts(engine)).toEqual([first, overlay, text]);
        expect(getRenderingContexts(secondary)).toEqual([secondaryFirst, secondaryOverlay, secondaryText]);

        unregisterScene(first);
        await settleOverlayReconciliation();
        secondaryOverlay._update();
        expect((overlay._frameGraph._tasks[0] as RenderTaskBase)._config.clr).toBe(true);
        const secondaryTask = secondaryOverlay._frameGraph._tasks[0] as RenderTaskBase;
        expect(secondaryTask._config.clr).toBe(false);
        if (samples > 1) {
            expect(secondaryTask._colorAttachment.view).toBe((secondaryFirst._frameGraph._tasks[0] as RenderTaskBase)._colorAttachment.view);
        }
    });

    it.each([1, 4])("reorders a generic overlay when re-registered after a non-scene context at MSAA %i", async (samples) => {
        const engine = makeMockEngine(samples);
        const first = createSceneContext(engine);
        const second = createSceneContext(engine);
        const text = { ...makeRenderingContext(), _kind: "text-renderer" };
        await registerScene(first);
        await registerScene(second);
        second._update();
        const task = second._frameGraph._tasks[0] as RenderTaskBase;
        const callbackCount = second._beforeRender.length;
        expect(task._config.clr).toBe(false);
        registerRenderingContext(engine, text);

        unregisterScene(second);
        await registerScene(second);
        second._update();

        expect(getRenderingContexts(engine)).toEqual([first, second, text]);
        expect(task._config.clr).toBe(false);
        expect(second._beforeRender).toHaveLength(callbackCount);
    });

    it.each([1, 4])("restores a former ordinary overlay when no earlier scene remains at MSAA %i", async (samples) => {
        const engine = makeMockEngine(samples);
        const first = createSceneContext(engine);
        const overlay = createSceneContext(engine);
        const text = { ...makeRenderingContext(), _kind: "text-renderer" };
        const task = overlay._frameGraph._tasks[0] as RenderTaskBase;

        await registerScene(first);
        await registerScene(overlay);
        overlay._update();
        expect(task._config.clr).toBe(false);
        unregisterScene(overlay);
        unregisterScene(first);
        registerRenderingContext(engine, text);
        await registerScene(overlay);
        expect(getRenderingContexts(engine)).toEqual([text, overlay]);
        expect(task._config.clr).toBe(true);
        expect(overlay._beforeRender).toHaveLength(0);

        unregisterScene(overlay);
        unregisterRenderingContext(engine, text);
        await registerScene(first);
        await registerScene(overlay);
        unregisterScene(overlay);
        unregisterScene(first);
        await registerScene(overlay);
        expect(getRenderingContexts(engine)).toEqual([overlay]);
        expect(task._config.clr).toBe(true);
        expect(overlay._beforeRender).toHaveLength(0);
    });

    it.each([1, 4])("retargets ordinary overlays when a base is removed and re-registered at MSAA %i", async (samples) => {
        const engine = makeMockEngine(samples);
        const first = createSceneContext(engine);
        const middle = createSceneContext(engine);
        const last = createSceneContext(engine);
        const text = { ...makeRenderingContext(), _kind: "text-renderer" };

        await registerScene(first);
        await registerScene(middle);
        await registerScene(last);
        registerRenderingContext(engine, text);
        middle._update();
        last._update();

        const middleTask = middle._frameGraph._tasks[0] as RenderTaskBase;
        const lastTask = last._frameGraph._tasks[0] as RenderTaskBase;
        unregisterScene(middle);
        await settleOverlayReconciliation();
        last._update();
        expect(getRenderingContexts(engine)).toEqual([first, last, text]);
        expect(lastTask._config.clr).toBe(false);
        expect(middleTask._config.clr).toBe(true);
        expect(middle._beforeRender).toHaveLength(0);
        if (samples > 1) {
            expect(lastTask._colorAttachment.view).toBe((first._frameGraph._tasks[0] as RenderTaskBase)._colorAttachment.view);
            expect(middleTask._colorAttachment.view).toBe(middleTask._config.rt._colorView);
        }

        await registerScene(middle);
        last._update();
        middle._update();
        expect(getRenderingContexts(engine)).toEqual([first, last, middle, text]);
        expect(middleTask._config.clr).toBe(false);
        expect(lastTask._config.clr).toBe(false);
        if (samples > 1) {
            expect(middleTask._colorAttachment.view).toBe(lastTask._colorAttachment.view);
            expect(middle._beforeRender).toHaveLength(1);
            expect(last._beforeRender).toHaveLength(1);
        }
    });

    it.each([1, 4])("restores an ordinary scene when its base is unregistered or disposed at MSAA %i", async (samples) => {
        const engine = makeMockEngine(samples);
        const first = createSceneContext(engine);
        const middle = createSceneContext(engine);
        const last = createSceneContext(engine);
        await registerScene(first);
        await registerScene(middle);
        await registerScene(last);
        middle._update();
        last._update();

        const middleTask = middle._frameGraph._tasks[0] as RenderTaskBase;
        const lastTask = last._frameGraph._tasks[0] as RenderTaskBase;
        const replacementView = {} as GPUTextureView;
        if (samples > 1) {
            middleTask._config.rt._colorView = replacementView;
        }
        unregisterScene(first);
        await settleOverlayReconciliation();
        expect(middleTask._config.clr).toBe(true);
        expect(middle._beforeRender).toHaveLength(0);
        if (samples > 1) {
            expect(middleTask._colorAttachment.view).toBe(replacementView);
        }
        last._update();
        expect(lastTask._config.clr).toBe(false);
        if (samples > 1) {
            expect(lastTask._colorAttachment.view).toBe(middleTask._colorAttachment.view);
        }

        disposeScene(middle);
        await settleOverlayReconciliation();
        expect(getRenderingContexts(engine)).toEqual([last]);
        expect(lastTask._config.clr).toBe(true);
        expect(last._beforeRender).toHaveLength(0);
        if (samples > 1) {
            expect(lastTask._colorAttachment.view).toBe(lastTask._config.rt._colorView);
        }
    });

    it.each([1, 4])("retargets past an explicit overlay whose base is removed at MSAA %i", async (samples) => {
        const engine = makeMockEngine(samples);
        const first = createSceneContext(engine);
        const middle = createSceneContext(engine);
        const child = createOverlayScene(middle);
        const last = createSceneContext(engine);
        const text = { ...makeRenderingContext(), _kind: "text-renderer" };

        await registerScene(first);
        await registerScene(middle);
        await registerScene(child);
        await registerScene(last);
        registerRenderingContext(engine, text);
        middle._update();
        child._update();
        last._update();

        const lastTask = last._frameGraph._tasks[0] as RenderTaskBase;
        unregisterScene(middle);
        await settleOverlayReconciliation();
        last._update();
        expect(getRenderingContexts(engine)).toEqual([first, last, child, text]);
        expect(child._record()).toBe(0);
        expect(lastTask._config.clr).toBe(false);
        if (samples > 1) {
            expect(lastTask._colorAttachment.view).toBe((first._frameGraph._tasks[0] as RenderTaskBase)._colorAttachment.view);
        }

        await registerScene(middle);
        last._update();
        middle._update();
        child._update();
        expect(getRenderingContexts(engine)).toEqual([first, last, middle, child, text]);
        if (samples > 1) {
            expect((middle._frameGraph._tasks[0] as RenderTaskBase)._colorAttachment.view).toBe(lastTask._colorAttachment.view);
        }
    });

    it.each([1, 4])("recomposites an ordinary scene when an earlier explicit overlay becomes active again at MSAA %i", async (samples) => {
        const engine = makeMockEngine(samples);
        const main = createSceneContext(engine);
        const child = createOverlayScene(main);
        const ordinary = createSceneContext(engine);
        const text = { ...makeRenderingContext(), _kind: "text-renderer" };
        await registerScene(main);
        await registerScene(child);
        await registerScene(ordinary);
        registerRenderingContext(engine, text);
        child._update();
        ordinary._update();

        const task = ordinary._frameGraph._tasks[0] as RenderTaskBase;
        unregisterScene(main);
        await settleOverlayReconciliation();
        expect(task._config.clr).toBe(true);
        expect(ordinary._beforeRender).toHaveLength(0);
        expect(child._record()).toBe(0);

        await registerScene(main);
        await settleOverlayReconciliation();
        child._update();
        ordinary._update();
        expect(getRenderingContexts(engine)).toEqual([main, child, ordinary, text]);
        expect(task._config.clr).toBe(false);
        if (samples > 1) {
            expect(task._colorAttachment.view).toBe((child._frameGraph._tasks[0] as RenderTaskBase)._colorAttachment.view);
        }
    });

    it.each([1, 4])("retargets an ordinary scene when an explicit overlay is inserted before it at MSAA %i", async (samples) => {
        const engine = makeMockEngine(samples);
        const main = createSceneContext(engine);
        const ordinary = createSceneContext(engine);
        await registerScene(main);
        await registerScene(ordinary);
        const child = createOverlayScene(main);
        await registerScene(child);
        await settleOverlayReconciliation();
        expect(getRenderingContexts(engine)).toEqual([main, child, ordinary]);
        expect((ordinary._frameGraph._tasks[0] as RenderTaskBase)._config.clr).toBe(samples === 1 ? false : true);

        if (samples > 1) {
            const childTask = child._frameGraph._tasks[0] as RenderTaskBase;
            const currentView = {} as GPUTextureView;
            childTask._colorAttachment.view = currentView;
            ordinary._update();
            expect((ordinary._frameGraph._tasks[0] as RenderTaskBase)._colorAttachment.view).toBe(currentView);
        }
    });

    it.each([1, 4])("ignores an inactive explicit overlay when inferring an ordinary scene's base at MSAA %i", async (samples) => {
        const engine = makeMockEngine(samples);
        const main = createSceneContext(engine);
        const absentBase = createSceneContext(engine);
        const inactive = createOverlayScene(absentBase);
        const ordinary = createSceneContext(engine);
        const text = { ...makeRenderingContext(), _kind: "text-renderer" };

        await registerScene(main);
        await registerScene(inactive);
        registerRenderingContext(engine, text);
        await registerScene(ordinary);

        expect(getRenderingContexts(engine)).toEqual([main, ordinary, inactive, text]);
        ordinary._update();
        const task = ordinary._frameGraph._tasks[0] as RenderTaskBase;
        expect(task._config.clr).toBe(false);
        if (samples > 1) {
            expect(task._colorAttachment.view).toBe((main._frameGraph._tasks[0] as RenderTaskBase)._colorAttachment.view);
        }
    });

    it.each([1, 4])("finds the previous scene before a text-separated child-first overlay at MSAA %i", async (samples) => {
        const engine = makeMockEngine(samples);
        const previous = createSceneContext(engine);
        const main = createSceneContext(engine);
        const child = createOverlayScene(main);
        const text = { ...makeRenderingContext(), _kind: "text-renderer" };

        await registerScene(previous);
        registerRenderingContext(engine, text);
        await registerScene(child);
        await registerScene(main);

        expect(getRenderingContexts(engine)).toEqual([previous, main, child, text]);
        main._update();
        const task = main._frameGraph._tasks[0] as RenderTaskBase;
        expect(task._config.clr).toBe(false);
        if (samples > 1) {
            expect(task._colorAttachment.view).toBe((previous._frameGraph._tasks[0] as RenderTaskBase)._colorAttachment.view);
        }
    });

    it("orders an ordinary scene registered with shadow support before intervening text", async () => {
        const engine = makeMockEngine();
        const main = createSceneContext(engine);
        const overlay = createSceneContext(engine);
        const text = { ...makeRenderingContext(), _kind: "text-renderer" };
        const shadow = {
            name: "shadow",
            engine,
            _passes: [],
            record: vi.fn(),
            execute: vi.fn(() => 0),
            dispose: vi.fn(),
        } as unknown as Task;
        addTaskAtStart(overlay, shadow);
        await registerScene(main);
        registerRenderingContext(engine, text);

        await registerSceneWithShadowSupport(overlay);
        overlay._update();
        const task = overlay._frameGraph._tasks[1] as RenderTaskBase;
        expect(getRenderingContexts(engine)).toEqual([main, overlay, text]);
        expect(task._config.clr).toBe(false);
        expect(task._colorAttachment.view).toBe((main._frameGraph._tasks[0] as RenderTaskBase)._colorAttachment.view);
    });

    it("replaces a generic MSAA overlay callback when re-registering", async () => {
        const engine = makeMockEngine();
        const first = createSceneContext(engine);
        const second = createSceneContext(engine);
        await registerScene(first);
        await registerScene(second);
        for (let i = 0; i < 3; i++) {
            unregisterScene(second);
            await registerScene(second);
            expect(second._beforeRender).toHaveLength(1);
        }
    });

    it("never shares an unregistered base's MSAA attachment before removal is reconciled", async () => {
        const engine = makeMockEngine(4);
        const first = createSceneContext(engine);
        const second = createSceneContext(engine);
        await registerScene(first);
        await registerScene(second);
        const task = second._frameGraph._tasks[0] as RenderTaskBase;
        second._update();
        expect(task._colorAttachment.view).toBe((first._frameGraph._tasks[0] as RenderTaskBase)._colorAttachment.view);

        disposeScene(first);
        second._update();
        expect(task.enabled).toBe(false);
        await settleOverlayReconciliation();
        second._update();
        expect(task.enabled).not.toBe(false);
        expect(task._config.clr).toBe(true);
        expect(task._colorAttachment.view).toBe(task._config.rt._colorView);
    });

    it.each([1, 4])("releases generic overlay bookkeeping on disposal at MSAA %i", async (samples) => {
        const engine = makeMockEngine(samples);
        const first = createSceneContext(engine);
        const second = createSceneContext(engine);
        await registerScene(first);
        await registerScene(second);
        const cleanupCount = second._disposables.length;
        for (let i = 0; i < 3; i++) {
            unregisterScene(second);
            await registerScene(second);
            expect(second._disposables).toHaveLength(cleanupCount);
        }

        expect(second._swapchainOverlay?._base).toBe(first);
        disposeScene(second);
        await settleOverlayReconciliation();
        expect(second._swapchainOverlay).toBeUndefined();
        expect(second._disposables).toHaveLength(0);
        expect(second._beforeRender).toHaveLength(0);
        disposeScene(first);
    });

    describe("utility layer registration", () => {
        function defaultTask(scene: SceneContext): RenderTaskBase {
            return scene._frameGraph._tasks[0] as RenderTaskBase;
        }

        it("moves a registered context to a clamped index", () => {
            const engine = makeMockEngine();
            const [a, b, c] = [makeRenderingContext(), makeRenderingContext(), makeRenderingContext()];
            const unregistered = makeRenderingContext();
            for (const context of [a, b, c]) {
                registerRenderingContext(engine, context);
            }

            expect(moveRenderingContext(engine, c, 1)).toBe(true);
            expect(getRenderingContexts(engine)).toEqual([a, c, b]);
            expect(moveRenderingContext(engine, a, 99)).toBe(true);
            expect(getRenderingContexts(engine)).toEqual([c, b, a]);
            expect(moveRenderingContext(engine, a, -5)).toBe(true);
            expect(getRenderingContexts(engine)).toEqual([a, c, b]);
            expect(moveRenderingContext(engine, unregistered, 0)).toBe(false);
            expect(getRenderingContexts(engine)).toEqual([a, c, b]);
            for (const index of [NaN, Infinity, -Infinity, 1.5]) {
                expect(() => moveRenderingContext(engine, a, index)).toThrow(RangeError);
                expect(getRenderingContexts(engine)).toEqual([a, c, b]);
            }
        });

        it.each([1, 4])("orders multiple layers after their main scene and before text at MSAA %i", async (samples) => {
            const engine = makeMockEngine(samples);
            const main = createSceneContext(engine);
            const first = createUtilityLayer(main, { addDefaultLight: false });
            const second = createUtilityLayer(main, { addDefaultLight: false });
            const text = { ...makeRenderingContext(), _kind: "text-renderer" };
            await registerScene(main);
            registerRenderingContext(engine, text);
            await registerUtilityLayer(first);
            await registerUtilityLayer(second);
            await registerUtilityLayer(first);

            expect(getRenderingContexts(engine)).toEqual([main, first.scene, second.scene, text]);
            for (const utility of [first, second]) {
                utility.scene._update();
                expect(defaultTask(utility.scene)._config.clr).toBe(false);
                if (samples > 1) {
                    expect(defaultTask(utility.scene)._colorAttachment.view).toBe(defaultTask(main)._colorAttachment.view);
                }
            }
            expect(defaultTask(main)._config.clr).toBe(true);

            moveRenderingContext(engine, second.scene, 3);
            expect(getRenderingContexts(engine)).toEqual([main, first.scene, text, second.scene]);
            await registerUtilityLayer(second);
            expect(getRenderingContexts(engine)).toEqual([main, first.scene, second.scene, text]);

            unregisterScene(first.scene);
            await registerUtilityLayer(first);
            expect(getRenderingContexts(engine)).toEqual([main, second.scene, first.scene, text]);
        });

        it("groups layers with their own main scenes and preserves sibling order", async () => {
            const engine = makeMockEngine();
            const a = createSceneContext(engine);
            const b = createSceneContext(engine);
            const a1 = createUtilityLayer(a, { addDefaultLight: false });
            const a2 = createUtilityLayer(a, { addDefaultLight: false });
            const b1 = createUtilityLayer(b, { addDefaultLight: false });
            const text = { ...makeRenderingContext(), _kind: "text-renderer" };
            await registerScene(a);
            await registerScene(b);
            registerRenderingContext(engine, text);
            await registerUtilityLayer(a1);
            await registerUtilityLayer(b1);
            await registerUtilityLayer(a2);
            expect(getRenderingContexts(engine)).toEqual([a, a1.scene, a2.scene, b, b1.scene, text]);

            unregisterScene(a);
            await registerScene(a);
            expect(getRenderingContexts(engine)).toEqual([a, a1.scene, a2.scene, b, b1.scene, text]);
            expect(defaultTask(a)._config.clr).toBe(true);

            disposeUtilityLayer(a1);
            expect(getRenderingContexts(engine)).toEqual([a, a2.scene, b, b1.scene, text]);
            a2.scene._update();
            expect(defaultTask(a2.scene)._config.clr).toBe(false);
        });

        it.each([1, 4])("keeps nested layers with their parent and suspends the entire absent-main chain at MSAA %i", async (samples) => {
            const engine = makeMockEngine(samples);
            const main = createSceneContext(engine);
            const parent = createUtilityLayer(main, { addDefaultLight: false });
            const nested = createUtilityLayer(parent.scene, { addDefaultLight: false });
            const sibling = createUtilityLayer(main, { addDefaultLight: false });
            const text = { ...makeRenderingContext(), _kind: "text-renderer" };
            const callback = vi.fn();
            const execute = vi.spyOn(nested.scene._frameGraph, "execute").mockReturnValue(3);
            nested.scene._beforeRender.push(callback);
            const contexts = [main, parent.scene, nested.scene, sibling.scene, text];
            const order = (): number[] => getRenderingContexts(engine).map((context) => contexts.indexOf(context));

            await registerScene(main);
            await registerUtilityLayer(parent);
            await registerUtilityLayer(nested);
            registerRenderingContext(engine, text);
            await registerUtilityLayer(sibling);
            expect(order()).toEqual([0, 1, 2, 3, 4]);

            unregisterScene(main);
            nested.scene._update();
            expect(nested.scene._record()).toBe(0);
            expect(callback).not.toHaveBeenCalled();
            expect(execute).not.toHaveBeenCalled();

            await registerScene(main);
            expect(order()).toEqual([0, 1, 2, 3, 4]);
            nested.scene._update();
            expect(nested.scene._record()).toBe(3);
            expect(callback).toHaveBeenCalledOnce();

            unregisterScene(parent.scene);
            nested.scene._update();
            expect(nested.scene._record()).toBe(0);
            expect(callback).toHaveBeenCalledOnce();
            await registerUtilityLayer(parent);
            expect(order()).toEqual([0, 3, 1, 2, 4]);
        });

        it.each([1, 4])("restores child-first registration without using a descendant as the root base at MSAA %i", async (samples) => {
            const engine = makeMockEngine(samples);
            const main = createSceneContext(engine);
            const parent = createUtilityLayer(main, { addDefaultLight: false });
            const nested = createUtilityLayer(parent.scene, { addDefaultLight: false });
            const sibling = createUtilityLayer(main, { addDefaultLight: false });
            const text = { ...makeRenderingContext(), _kind: "text-renderer" };
            const contexts = [main, sibling.scene, parent.scene, nested.scene, text];

            await registerUtilityLayer(nested);
            await registerUtilityLayer(sibling);
            registerRenderingContext(engine, text);
            await registerUtilityLayer(parent);
            expect(nested.scene._record()).toBe(0);

            await registerScene(main);
            expect(getRenderingContexts(engine).map((context) => contexts.indexOf(context))).toEqual([0, 1, 2, 3, 4]);
            expect(defaultTask(main)._config.clr).toBe(true);
            expect(main._beforeRender).toHaveLength(0);
        });

        it.each([1, 4])("groups ordinary-registered overlay scenes after their base and before text at MSAA %i", async (samples) => {
            const engine = makeMockEngine(samples);
            const main = createSceneContext(engine);
            const camera = { kind: "test-camera" } as unknown as SceneContext["camera"];
            main.camera = camera;
            const first = createOverlayScene(main);
            const second = createOverlayScene(main);
            const utility = createUtilityLayer(first, { addDefaultLight: false });
            const text = { ...makeRenderingContext(), _kind: "text-renderer" };

            expect(first.surface).toBe(engine);
            expect(first.clearColor).toEqual({ r: 0, g: 0, b: 0, a: 0 });
            expect(first.camera).not.toBe(camera);

            await registerScene(second);
            registerRenderingContext(engine, text);
            expect(second._record()).toBe(0);
            await registerScene(main);
            await registerScene(first);
            await registerUtilityLayer(utility);
            expect(getRenderingContexts(engine)).toEqual([main, second, first, utility.scene, text]);
            for (const overlay of [first, second]) {
                overlay._update();
                expect(defaultTask(overlay)._config.clr).toBe(false);
                if (samples > 1) {
                    expect(defaultTask(overlay)._colorAttachment.view).toBe(defaultTask(main)._colorAttachment.view);
                }
            }
            expect(defaultTask(main)._config.clr).toBe(true);
            expect(first.camera).not.toBe(camera);

            unregisterScene(main);
            expect(first._record()).toBe(0);
            expect(utility.scene._record()).toBe(0);
            await registerScene(main);
            expect(getRenderingContexts(engine)).toEqual([main, second, first, utility.scene, text]);
        });

        it.each([1, 4])("does not accumulate overlay callbacks when a layer is re-registered at MSAA %i", async (samples) => {
            const engine = makeMockEngine(samples);
            const main = createSceneContext(engine);
            const utility = createUtilityLayer(main, { addDefaultLight: false });
            await registerScene(main);
            await registerUtilityLayer(utility);
            const callbackCount = utility.scene._beforeRender.length;

            for (let i = 0; i < 3; i++) {
                unregisterScene(utility.scene);
                await registerUtilityLayer(utility);
                expect(utility.scene._beforeRender).toHaveLength(callbackCount);
            }

            utility.scene._update();
            expect(defaultTask(utility.scene)._config.clr).toBe(false);
        });

        it("restores an overlay disabled while its MSAA attachment was unavailable", async () => {
            const engine = makeMockEngine();
            const main = createSceneContext(engine);
            const utility = createUtilityLayer(main, { addDefaultLight: false });
            await registerScene(main);
            await registerUtilityLayer(utility);
            const task = defaultTask(main);
            const resolveTarget = task._config.rst;
            task._config.rst = undefined;
            utility.scene._update();
            expect(defaultTask(utility.scene).enabled).toBe(false);

            unregisterScene(utility.scene);
            await registerUtilityLayer(utility);
            task._config.rst = resolveTarget;
            utility.scene._update();
            expect(defaultTask(utility.scene).enabled).not.toBe(false);
            expect(defaultTask(utility.scene)._config.clr).toBe(false);
        });

        it.each([1, 4])("restores a main scene configured as an overlay before utility creation at MSAA %i", async (samples) => {
            const engine = makeMockEngine(samples);
            const first = createSceneContext(engine);
            const main = createSceneContext(engine);
            await registerScene(first);
            await registerScene(main);
            main._update();
            expect(defaultTask(main)._config.clr).toBe(false);

            const utility = createUtilityLayer(main, { addDefaultLight: false });
            await registerUtilityLayer(utility);
            unregisterScene(main);
            unregisterScene(first);
            await settleOverlayReconciliation();
            await registerScene(main);

            expect(getRenderingContexts(engine)).toEqual([main, utility.scene]);
            expect(defaultTask(main)._config.clr).toBe(true);
            main._update();
            utility.scene._update();
            expect(defaultTask(utility.scene)._config.clr).toBe(false);
            if (samples > 1) {
                expect(defaultTask(utility.scene)._colorAttachment.view).toBe(defaultTask(main)._colorAttachment.view);
            }

            unregisterScene(main);
            unregisterScene(utility.scene);
            await registerScene(first);
            await registerScene(main);
            main._update();
            expect(defaultTask(main)._config.clr).toBe(false);
            unregisterScene(main);
            unregisterScene(first);
            await registerScene(main);
            expect(getRenderingContexts(engine)).toEqual([main]);
            expect(defaultTask(main)._config.clr).toBe(true);
        });

        it("orders the layer on its main scene's surface", async () => {
            const engine = makeMockEngine();
            const surface = makeMockEngine();
            Object.assign(surface, { engine });
            const main = createSceneContext(surface);
            const utility = createUtilityLayer(main, { addDefaultLight: false });
            const text = { ...makeRenderingContext(), _kind: "text-renderer" };
            await registerScene(main);
            registerRenderingContext(surface, text);
            await registerUtilityLayer(utility);

            expect(utility.scene.surface).toBe(surface);
            expect(getRenderingContexts(surface)).toEqual([main, utility.scene, text]);
            expect(getRenderingContexts(engine)).toEqual([]);
        });

        it.each([1, 4])("stays inert while its main scene is not registered at MSAA %i", async (samples) => {
            const engine = makeMockEngine(samples);
            const main = createSceneContext(engine);
            const utility = createUtilityLayer(main, { addDefaultLight: false });
            const callback = vi.fn();
            const execute = vi.spyOn(utility.scene._frameGraph, "execute").mockReturnValue(3);
            utility.scene._beforeRender.push(callback);
            await registerUtilityLayer(utility);
            utility.scene._drawCallsPre = 12;

            utility.scene._update();
            expect(utility.scene._record()).toBe(0);
            expect(utility.scene._drawCallsPre).toBe(0);
            expect(callback).not.toHaveBeenCalled();
            expect(execute).not.toHaveBeenCalled();
            expect(isRenderingContextRegistered(engine, utility.scene)).toBe(true);

            await registerScene(main);
            expect(getRenderingContexts(engine)).toEqual([main, utility.scene]);
            expect(defaultTask(main)._config.clr).toBe(true);
            utility.scene._update();
            expect(utility.scene._record()).toBe(3);
            expect(callback).toHaveBeenCalledOnce();
            expect(defaultTask(utility.scene)._config.clr).toBe(false);

            const text = { ...makeRenderingContext(), _kind: "text-renderer" };
            registerRenderingContext(engine, text);
            unregisterScene(main);
            utility.scene._update();
            expect(utility.scene._record()).toBe(0);
            expect(callback).toHaveBeenCalledOnce();
            await registerScene(main);
            expect(getRenderingContexts(engine)).toEqual([main, utility.scene, text]);
            utility.scene._update();
            expect(utility.scene._record()).toBe(3);
            expect(callback).toHaveBeenCalledTimes(2);

            disposeScene(main);
            expect(getRenderingContexts(engine)).toEqual([utility.scene, text]);
            utility.scene._update();
            expect(utility.scene._record()).toBe(0);
            expect(callback).toHaveBeenCalledTimes(2);
            expect(execute).toHaveBeenCalledTimes(2);

            disposeUtilityLayer(utility);
            disposeUtilityLayer(utility);
            unregisterRenderingContext(engine, text);
            expect(getRenderingContexts(engine)).toEqual([]);
        });

        it("restores overlay ordering when a main scene registers with shadow support", async () => {
            const engine = makeMockEngine();
            const main = createSceneContext(engine);
            const utility = createUtilityLayer(main, { addDefaultLight: false });
            const shadow = {
                name: "shadow",
                engine,
                _passes: [],
                record: vi.fn(),
                execute: vi.fn(() => 0),
                dispose: vi.fn(),
            } as unknown as Task;
            addTaskAtStart(main, shadow);
            await registerUtilityLayer(utility);
            await registerSceneWithShadowSupport(main);
            expect(getRenderingContexts(engine)).toEqual([main, utility.scene]);
        });

        it("does not revive a layer disposed during asynchronous registration", async () => {
            const engine = makeMockEngine();
            const main = createSceneContext(engine);
            const utility = createUtilityLayer(main, { addDefaultLight: false });
            await registerScene(main);
            let finish!: () => void;
            const pending = new Promise<void>((resolve) => (finish = resolve));
            defaultTask(utility.scene)._preload = () => pending;
            const registration = registerUtilityLayer(utility);
            disposeUtilityLayer(utility);
            finish();
            await registration;
            expect(getRenderingContexts(engine)).toEqual([main]);
            expect(utility.scene._beforeRender).toHaveLength(0);
        });

        it.each([false, true])("does not duplicate callbacks when layer registrations overlap, utility-first=%s", async (utilityFirst) => {
            const engine = makeMockEngine();
            const main = createSceneContext(engine);
            const utility = createUtilityLayer(main, { addDefaultLight: false });
            if (!utilityFirst) {
                await registerScene(main);
            }
            let finish!: () => void;
            const pending = new Promise<void>((resolve) => (finish = resolve));
            defaultTask(utility.scene)._preload = () => pending;

            const first = registerUtilityLayer(utility);
            const second = registerUtilityLayer(utility);
            finish();
            await Promise.all([first, second]);

            expect(getRenderingContexts(engine)).toEqual(utilityFirst ? [utility.scene] : [main, utility.scene]);
            expect(utility.scene._beforeRender).toHaveLength(2);
            if (utilityFirst) {
                await registerScene(main);
                expect(getRenderingContexts(engine)).toEqual([main, utility.scene]);
            }
        });
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
