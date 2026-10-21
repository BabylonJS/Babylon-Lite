import { expect, it, vi } from "vitest";
import { gpsCreateSceneDepth, gpsRecordSceneDepth } from "../../../packages/babylon-lite/src/gaussian-point-splatting/gps-scene-depth.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core.js";
import type { Renderable } from "../../../packages/babylon-lite/src/render/renderable.js";
import type { Camera } from "../../../packages/babylon-lite/src/camera/camera.js";

vi.mock("../../../packages/babylon-lite/src/frame-graph/scene-uniforms-pack.js", () => ({ _packSceneUniforms: vi.fn() }));
vi.mock("../../../packages/babylon-lite/src/render/scene-lights-ubo.js", () => ({ ensureSceneLightState: () => ({ _buffer: {} }) }));

it("renders only visible opaque geometry, flushes its batches, and recreates cropped depth targets on resize", () => {
    const events: string[] = [];
    const device = {
        createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
            const [width, height] = descriptor.size as number[];
            return { width, height, createView: () => ({}), destroy: vi.fn() };
        }),
        createBuffer: vi.fn(() => ({})),
        createBindGroup: vi.fn(() => ({})),
        createBindGroupLayout: vi.fn(() => ({})),
        queue: { writeBuffer: vi.fn() },
    } as unknown as GPUDevice;
    const pass = { setBindGroup: vi.fn(), setPipeline: vi.fn(), end: vi.fn() };
    const engine = {
        _device: device,
        _currentEncoder: {
            beginRenderPass: vi.fn(() => {
                events.push("pass");
                return pass;
            }),
        },
    } as unknown as EngineContext;
    const draw = vi.fn(() => {
        events.push("draw");
        return 1;
    });
    const batch = { reset: () => events.push("reset"), flush: () => events.push("flush"), destroy: vi.fn() };
    const opaque: Renderable = {
        order: 100,
        isTransparent: false,
        mesh: { visible: true } as Renderable["mesh"],
        bind: vi.fn(() => ({ renderable: opaque, pipeline: {} as GPURenderPipeline, update: () => events.push("update"), _updateBatches: [batch], draw })),
    };
    const transparent = { ...opaque, isTransparent: true, bind: vi.fn() };
    const merged: Renderable = {
        ...opaque,
        mesh: undefined,
        bind: vi.fn(() => ({ renderable: merged, pipeline: {} as GPURenderPipeline, draw: vi.fn(() => 1) })),
    };
    const scene = { _renderables: [opaque, transparent, merged], _renderableVersion: 1 } as unknown as SceneContext;
    const state = gpsCreateSceneDepth(device);
    const context = { targetWidth: 800, targetHeight: 600, _camera: { viewport: { x: 0.5, y: 0, width: 0.5, height: 1 } } as Camera };
    const signature = { _sampleCount: 4, _colorFormat: "bgra8unorm" as const };
    const retire = vi.fn();
    expect(gpsRecordSceneDepth(state, scene, engine, signature, context, retire)).toBe(true);
    expect([state.texture.width, state.texture.height]).toEqual([400, 600]);
    expect(events).toEqual(["reset", "update", "flush", "pass", "draw"]);
    expect(transparent.bind).not.toHaveBeenCalled();
    expect(merged.bind).toHaveBeenCalledTimes(1);
    expect(opaque.bind).toHaveBeenCalledWith(engine, expect.objectContaining({ _sampleCount: 1, _depthStencilFormat: "depth32float" }));
    const previous = state.texture;
    context.targetWidth = 1600;
    gpsRecordSceneDepth(state, scene, engine, signature, context, retire);
    expect([state.texture.width, state.texture.height]).toEqual([800, 600]);
    expect(retire).toHaveBeenLastCalledWith(expect.arrayContaining([previous]));
    expect(opaque.bind).toHaveBeenCalledTimes(1);
    const prepassSignature = vi.mocked(opaque.bind).mock.calls[0]![1];
    expect(vi.mocked(merged.bind).mock.calls[0]![1]).toBe(prepassSignature);
    scene._renderableVersion++;
    gpsRecordSceneDepth(state, scene, engine, signature, context, retire);
    expect(vi.mocked(opaque.bind).mock.calls[1]![1]).toBe(prepassSignature);
    expect(vi.mocked(merged.bind).mock.calls[1]![1]).toBe(prepassSignature);
    opaque.mesh!.visible = false;
    expect(gpsRecordSceneDepth(state, scene, engine, signature, context, retire)).toBe(true);
    expect(draw).toHaveBeenCalledTimes(3);
    const allocations = vi.mocked(device.createTexture).mock.calls.length;
    expect(gpsRecordSceneDepth(state, scene, engine, signature, { ...context, _camera: null }, retire)).toBe(false);
    expect(gpsRecordSceneDepth(state, scene, engine, signature, { ...context, targetWidth: 0 }, retire)).toBe(false);
    expect(vi.mocked(device.createTexture).mock.calls.length).toBe(allocations);
    opaque.mesh!.visible = true;
    scene._frameGraph = { _tasks: [{ _targetSignature: signature, _renderables: [transparent] }] } as unknown as SceneContext["_frameGraph"];
    expect(gpsRecordSceneDepth(state, scene, engine, signature, context, retire)).toBe(false);
    expect(draw).toHaveBeenCalledTimes(3);
});
