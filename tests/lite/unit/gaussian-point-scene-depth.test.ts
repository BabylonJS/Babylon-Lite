import { expect, it, vi } from "vitest";
import { gpsCreateSceneDepth, gpsHasViewport, gpsRecordSceneDepth, gpsViewport } from "../../../packages/babylon-lite/src/gaussian-point-splatting/gps-scene-depth.js";
import { gpsDefersDraw, gpsPassHasDraws, gpsWithPassDepth, installGpsPasses } from "../../../packages/babylon-lite/src/gaussian-point-splatting/gps-pass.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import type { Renderable } from "../../../packages/babylon-lite/src/render/renderable.js";
import type { Camera } from "../../../packages/babylon-lite/src/camera/camera.js";
import type { RenderTask } from "../../../packages/babylon-lite/src/frame-graph/render-task-base.js";

it("borrows exact native MSAA/stencil depth, including loaded-only overlays, without rebinding or replaying geometry", () => {
    const texture = { createView: vi.fn(() => ({})), destroy: vi.fn() } as unknown as GPUTexture;
    const signature = { _sampleCount: 4, _colorFormat: "bgra8unorm" as const, _depthStencilFormat: "depth24plus-stencil8" as const };
    const opaque = { isTransparent: false, bind: vi.fn() } as unknown as Renderable;
    const transparent = { isTransparent: true, bind: vi.fn() } as unknown as Renderable;
    const rt = { _depthTexture: texture, _eager: false };
    const task = { _targetSignature: signature, _renderables: [opaque, transparent], _config: { rt, depthClear: true, depth: undefined as typeof rt | undefined } };
    const scene = { _frameGraph: { _tasks: [task] }, _renderables: [opaque] } as unknown as SceneContext;
    const engine = {} as EngineContext;
    const state = gpsCreateSceneDepth();
    const context = { targetWidth: 101, targetHeight: 101, _camera: { viewport: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } } as Camera };
    expect(gpsRecordSceneDepth(state, scene, engine, signature, context)).toBe(true);
    expect(state).toMatchObject({ texture, samples: 4, signature, x: 50, y: 0 });
    expect(gpsViewport(context)).toEqual({ x: 50, y: 0, width: 51, height: 51 });
    expect(texture.createView).toHaveBeenCalledExactlyOnceWith({ aspect: "depth-only" });
    expect(opaque.bind).not.toHaveBeenCalled();
    expect(transparent.bind).not.toHaveBeenCalled();
    task._renderables = [transparent];
    expect(gpsRecordSceneDepth(state, scene, engine, signature, context)).toBe(false);
    expect(gpsRecordSceneDepth(state, scene, engine, signature, context, true)).toBe(true);
    task._config.depthClear = false;
    expect(gpsRecordSceneDepth(state, scene, engine, signature, context)).toBe(true);
    task._config.depthClear = true;
    task._config.depth = { _depthTexture: texture, _eager: true };
    expect(gpsRecordSceneDepth(state, scene, engine, signature, context)).toBe(true);
    expect(texture.createView).toHaveBeenCalledTimes(1);
    task._config.depth._eager = false;
    expect(gpsRecordSceneDepth(state, scene, engine, signature, context)).toBe(false);
    for (const invalid of [
        { ...context, _camera: null },
        { ...context, targetWidth: 0 },
        { ...context, targetHeight: NaN },
    ]) {
        expect(gpsHasViewport(invalid)).toBe(false);
        expect(gpsRecordSceneDepth(state, scene, engine, signature, invalid)).toBe(false);
    }
    expect(texture.destroy).not.toHaveBeenCalled();
});

it("splits native pass segments without changing encoder identity, restores dynamic state, and preserves task lifecycle", () => {
    const segments: { descriptor: GPURenderPassDescriptor; pass: GPURenderPassEncoder; calls: string[] }[] = [];
    const encoder = {
        beginRenderPass(descriptor: GPURenderPassDescriptor) {
            expect(this).toBe(encoder);
            const calls: string[] = [];
            const pass = {
                setPipeline() {
                    expect(this).toBe(pass);
                    calls.push("pipeline");
                },
                setBindGroup() {
                    expect(this).toBe(pass);
                    calls.push("group");
                },
                setViewport() {
                    calls.push("viewport");
                },
                setScissorRect() {
                    calls.push("scissor");
                },
                setStencilReference() {
                    calls.push("stencil");
                },
                setBlendConstant() {
                    calls.push("blend");
                },
                executeBundles() {
                    calls.push("bundles");
                },
                draw() {
                    calls.push("draw");
                },
                end() {
                    calls.push("end");
                },
            } as unknown as GPURenderPassEncoder;
            segments.push({ descriptor, pass, calls });
            return pass;
        },
    } as GPUCommandEncoder;
    const originalBegin = encoder.beginRenderPass;
    const engine = { _currentEncoder: encoder } as EngineContext;
    const view = {} as GPUTextureView;
    const signature = { _sampleCount: 4, _depthStencilFormat: "depth24plus-stencil8" as const };
    const descriptor: GPURenderPassDescriptor = {
        colorAttachments: [{ view: {} as GPUTextureView, resolveTarget: {} as GPUTextureView, loadOp: "clear", storeOp: "store" }],
        depthStencilAttachment: { view, depthLoadOp: "clear", depthStoreOp: "store", stencilLoadOp: "clear", stencilStoreOp: "store" },
    };
    const work = vi.fn(() => {
        expect(engine._currentEncoder).toBe(encoder);
        expect(segments.at(-1)!.calls.at(-1)).toBe("end");
    });
    const task = {
        _targetSignature: signature,
        _config: { rt: { _depthView: view } },
        execute() {
            for (let segment = 0; segment < 2; segment++) {
                const pass = encoder.beginRenderPass(descriptor);
                pass.setViewport(2, 3, 4, 5, 0, 1);
                pass.setScissorRect(2, 3, 4, 5);
                pass.setStencilReference(7);
                pass.setBlendConstant([1, 0, 0, 1]);
                pass.setPipeline({} as GPURenderPipeline);
                pass.setBindGroup(0, {} as GPUBindGroup);
                expect(gpsWithPassDepth(pass, work)).toBe(true);
                pass.draw(3);
                pass.end();
            }
            return 2;
        },
    } as unknown as RenderTask;
    const original = task.execute;
    const scene = { surface: { engine }, _beforeRender: [], _frameGraph: { _tasks: [task] } } as unknown as SceneContext;
    const release = installGpsPasses(scene);
    const releaseSecond = installGpsPasses(scene);
    expect(gpsDefersDraw(scene, signature)).toBe(true);
    expect(task.execute!()).toBe(2);
    expect(work).toHaveBeenCalledTimes(2);
    expect(segments).toHaveLength(4);
    for (const resumed of [segments[1]!, segments[3]!]) {
        expect(resumed.calls).toEqual(["viewport", "scissor", "stencil", "blend", "pipeline", "group", "draw", "end"]);
        expect(resumed.descriptor.depthStencilAttachment).toMatchObject({ view, depthLoadOp: "load", stencilLoadOp: "load" });
        expect(Array.from(resumed.descriptor.colorAttachments)[0]).toMatchObject({ loadOp: "load", storeOp: "store" });
    }
    expect(descriptor.depthStencilAttachment?.depthLoadOp).toBe("clear");
    expect(encoder.beginRenderPass).toBe(originalBegin);
    release();
    release();
    expect(task.execute).not.toBe(original);
    releaseSecond();
    expect(task.execute).toBe(original);
    expect(scene._beforeRender).toHaveLength(0);
    expect(gpsDefersDraw(scene, signature)).toBe(false);
    expect(gpsWithPassDepth({} as GPURenderPassEncoder, work)).toBe(false);
});

it("tracks actual preceding native draws across LOAD segments and proves only native empty bundles safe", () => {
    const nativeEmpty = {} as GPURenderBundle;
    const unknown = {} as GPURenderBundle;
    const executeBundles = vi.fn();
    const view = {} as GPUTextureView;
    const encoder = {
        beginRenderPass: () => ({ executeBundles, draw: vi.fn(), drawIndexed: vi.fn(), drawIndirect: vi.fn(), drawIndexedIndirect: vi.fn(), end: vi.fn() }),
    } as unknown as GPUCommandEncoder;
    const engine = { _currentEncoder: encoder } as EngineContext;
    const task = {
        _targetSignature: { _depthStencilFormat: "depth32float" },
        _config: { rt: { _depthView: view } },
        _opaqueBindings: [],
        _ob: [nativeEmpty],
        execute() {
            const begin = (depthLoadOp: GPULoadOp): GPURenderPassEncoder =>
                encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view, depthLoadOp, depthStoreOp: "store" } });
            const pass = begin("clear");
            expect(gpsPassHasDraws(pass)).toBe(false);
            pass.executeBundles([nativeEmpty].values());
            expect(gpsPassHasDraws(pass)).toBe(false);
            pass.executeBundles([unknown].values());
            expect(executeBundles).toHaveBeenLastCalledWith([unknown]);
            expect(gpsPassHasDraws(pass)).toBe(true);
            pass.end();
            const loaded = begin("load");
            expect(gpsPassHasDraws(loaded)).toBe(true);
            loaded.end();
            for (const draw of [
                (next: GPURenderPassEncoder) => next.draw(3),
                (next: GPURenderPassEncoder) => next.drawIndexed(3),
                (next: GPURenderPassEncoder) => next.drawIndirect({} as GPUBuffer, 0),
                (next: GPURenderPassEncoder) => next.drawIndexedIndirect({} as GPUBuffer, 0),
            ]) {
                const next = begin("clear");
                expect(gpsPassHasDraws(next)).toBe(false);
                draw(next);
                expect(gpsPassHasDraws(next)).toBe(true);
                next.end();
            }
            return 1;
        },
    } as unknown as RenderTask;
    const scene = { surface: { engine }, _beforeRender: [], _frameGraph: { _tasks: [task] } } as unknown as SceneContext;
    const release = installGpsPasses(scene);
    task.execute!();
    release();
});

it("forwards native passes unchanged while all retained handles are off and resumes for either render mode", () => {
    const nativePass = { end: vi.fn() } as unknown as GPURenderPassEncoder;
    const begin = vi.fn(() => nativePass);
    const encoder = { beginRenderPass: begin } as unknown as GPUCommandEncoder;
    const engine = { _currentEncoder: encoder } as EngineContext;
    const view = {} as GPUTextureView;
    const first = { colorRenderMode: true, depthRenderMode: false };
    const second = { colorRenderMode: false, depthRenderMode: false };
    let expectedActive = true;
    const task = {
        _targetSignature: { _sampleCount: 4, _depthStencilFormat: "depth32float" },
        _config: { rt: { _depthView: view } },
        execute() {
            expect(encoder.beginRenderPass === begin).toBe(!expectedActive);
            const pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view, depthLoadOp: "load", depthStoreOp: "store" } });
            expect(pass === nativePass).toBe(!expectedActive);
            expect(gpsPassHasDraws(pass)).toBe(expectedActive ? false : undefined);
            pass.end();
            return 1;
        },
    } as unknown as RenderTask;
    const scene = { surface: { engine }, _beforeRender: [], _frameGraph: { _tasks: [task] } } as unknown as SceneContext;
    const releaseFirst = installGpsPasses(scene, () => first.colorRenderMode || first.depthRenderMode);
    const releaseSecond = installGpsPasses(scene, () => second.colorRenderMode || second.depthRenderMode);
    task.execute!();
    first.colorRenderMode = false;
    expectedActive = false;
    task.execute!();
    second.depthRenderMode = true;
    expectedActive = true;
    task.execute!();
    releaseSecond();
    expectedActive = false;
    task.execute!();
    first.colorRenderMode = true;
    expectedActive = true;
    task.execute!();
    releaseFirst();
    expectedActive = false;
    task.execute!();
    expect(encoder.beginRenderPass).toBe(begin);
});

it("deactivates wrappers captured by a later feature across scan, disposal and re-enabling", () => {
    const observed: boolean[] = [];
    const view = {} as GPUTextureView;
    const encoder = { beginRenderPass: vi.fn(() => ({ end: vi.fn() })) } as unknown as GPUCommandEncoder;
    const engine = { _currentEncoder: encoder } as EngineContext;
    const task = {
        _targetSignature: { _sampleCount: 4, _depthStencilFormat: "depth32float" },
        _config: { rt: { _depthView: view } },
        execute() {
            const pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view, depthLoadOp: "load", depthStoreOp: "store" } });
            observed.push(gpsWithPassDepth(pass, vi.fn()));
            pass.end();
            return 1;
        },
    } as unknown as RenderTask;
    const scene = { surface: { engine }, _beforeRender: [], _frameGraph: { _tasks: [task] } } as unknown as SceneContext;
    const release = installGpsPasses(scene);
    const captured = task.execute!;
    const foreign = () => captured.call(task);
    task.execute = foreign;
    scene._beforeRender.forEach((hook) => hook(0));
    task.execute!();
    release();
    expect(task.execute).toBe(foreign);
    task.execute!();
    const releaseNext = installGpsPasses(scene);
    task.execute!();
    releaseNext();
    task.execute!();
    expect(observed).toEqual([true, false, true, false]);
});

it("discovers late/replaced tasks, preserves later instrumentation and restores methods after errors", () => {
    const encoder = { beginRenderPass: vi.fn() } as unknown as GPUCommandEncoder;
    const begin = encoder.beginRenderPass;
    const engine = { _currentEncoder: encoder } as EngineContext;
    const scene = { surface: { engine }, _beforeRender: [], _frameGraph: { _tasks: [] } } as unknown as SceneContext;
    const release = installGpsPasses(scene);
    const task = {
        _targetSignature: { _depthStencilFormat: "depth32float" },
        execute: vi.fn(() => {
            throw new Error("test failure");
        }),
    } as unknown as RenderTask;
    scene._frameGraph._tasks.push(task);
    scene._beforeRender.forEach((hook) => hook(0));
    expect(() => task.execute!()).toThrow("test failure");
    expect(encoder.beginRenderPass).toBe(begin);
    const replacement = vi.fn(() => 7);
    task.execute = replacement;
    scene._beforeRender.forEach((hook) => hook(0));
    expect(task.execute!()).toBe(7);
    scene._frameGraph._tasks.length = 0;
    scene._beforeRender.forEach((hook) => hook(0));
    expect(task.execute).toBe(replacement);
    release();
});
