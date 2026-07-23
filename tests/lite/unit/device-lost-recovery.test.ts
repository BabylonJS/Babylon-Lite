import { describe, expect, it, vi } from "vitest";

import { _enableDeviceLostRecovery, markNextDeviceLossForRecovery } from "../../../packages/babylon-lite/src/engine/device-lost-recovery.js";
import { enableDeviceLostSceneRecovery } from "../../../packages/babylon-lite/src/engine/device-lost-scene-recovery.js";
import { enableDeviceLostSpriteRecovery } from "../../../packages/babylon-lite/src/engine/device-lost-sprite-recovery.js";
import { enableDeviceLostTextRecovery } from "../../../packages/babylon-lite/src/engine/device-lost-text-recovery.js";
import type { EngineContext, RenderingContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { SurfaceContext } from "../../../packages/babylon-lite/src/engine/surface.js";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh.js";
import type { Texture2D, Texture2DOptions } from "../../../packages/babylon-lite/src/texture/texture-2d.js";
import { rebuildTexture2D } from "../../../packages/babylon-lite/src/texture/texture-recovery.js";

function context(kind: string): RenderingContext {
    return {
        _kind: kind,
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

function engineWith(...contexts: RenderingContext[]): EngineContext {
    return {
        surfaces: [{ _renderingContexts: contexts } as unknown as SurfaceContext],
    } as unknown as EngineContext;
}

describe("device-lost recovery context dispatch", () => {
    it("keeps a context recovery strategy enabled until every registration is disabled", () => {
        const enable = vi.fn();
        const disable = vi.fn();
        const engine = {
            _device: {
                features: new Set<GPUFeatureName>(),
                lost: new Promise<GPUDeviceLostInfo>(() => undefined),
            },
        } as unknown as EngineContext;
        const registration = {
            _kind: "scene",
            _recover: vi.fn(),
            _enable: enable,
            _disable: disable,
        };

        const first = _enableDeviceLostRecovery(engine, registration);
        const second = _enableDeviceLostRecovery(engine, registration);
        expect(enable).toHaveBeenCalledTimes(1);
        expect(markNextDeviceLossForRecovery(engine)).toBe(true);

        first.disable();
        expect(disable).not.toHaveBeenCalled();
        expect(markNextDeviceLossForRecovery(engine)).toBe(true);

        second.disable();
        expect(disable).toHaveBeenCalledTimes(1);
        expect(markNextDeviceLossForRecovery(engine)).toBe(false);
    });

    it("registers only requested handlers when unrelated context kinds are active", () => {
        const engine = engineWith(context("scene"), context("sprite-renderer"));
        Object.assign(engine, {
            _device: {
                features: new Set<GPUFeatureName>(),
                lost: new Promise<GPUDeviceLostInfo>(() => undefined),
            },
        });
        const scene = enableDeviceLostSceneRecovery(engine);

        expect(engine._deviceLostRecovery?._registrations.map((registration) => registration._kind)).toEqual(["scene"]);
        scene.disable();
    });

    it("does not remove another registration when its own entry is already absent", () => {
        const engine = {
            _device: {
                features: new Set<GPUFeatureName>(),
                lost: new Promise<GPUDeviceLostInfo>(() => undefined),
            },
        } as unknown as EngineContext;
        const sceneRegistration = { _kind: "scene", _recover: vi.fn() };
        const spriteRegistration = { _kind: "sprite-renderer", _recover: vi.fn() };
        const scene = _enableDeviceLostRecovery(engine, sceneRegistration);
        _enableDeviceLostRecovery(engine, spriteRegistration);
        engine._deviceLostRecovery!._registrations.splice(0, 1);

        scene.disable();

        expect(engine._deviceLostRecovery!._registrations).toEqual([spriteRegistration]);
    });

    it("keeps shared texture capture alive across repeated and cross-kind handles", () => {
        const engine = {
            _device: {
                features: new Set<GPUFeatureName>(),
                lost: new Promise<GPUDeviceLostInfo>(() => undefined),
            },
        } as unknown as EngineContext;

        const scene = enableDeviceLostSceneRecovery(engine);
        const sprite1 = enableDeviceLostSpriteRecovery(engine);
        const sprite2 = enableDeviceLostSpriteRecovery(engine);
        const text = enableDeviceLostTextRecovery(engine);
        expect(engine._dlr).toBeDefined();
        expect(engine._deviceLostRecovery?._registrations.map((registration) => registration._kind)).toEqual(["scene", "sprite-renderer", "sprite-renderer", "text-renderer"]);

        sprite1.disable();
        scene.disable();
        expect(engine._dlr).toBeDefined();

        sprite2.disable();
        expect(engine._dlr).toBeUndefined();
        text.disable();
        text.disable();
        expect(markNextDeviceLossForRecovery(engine)).toBe(false);
    });

    it("retains mesh geometry only while Scene recovery is enabled", () => {
        const engine = {
            _device: {
                features: new Set<GPUFeatureName>(),
                lost: new Promise<GPUDeviceLostInfo>(() => undefined),
            },
        } as unknown as EngineContext;
        const mesh = {} as Mesh;
        const indices = new Uint16Array([0, 1, 2]);
        const sprite = enableDeviceLostSpriteRecovery(engine);

        engine._dlr!.m(mesh, null, null, null, indices, "uint16");
        expect(mesh._cpuGpuIndices).toBeUndefined();

        const scene = enableDeviceLostSceneRecovery(engine);
        engine._dlr!.m(mesh, null, null, null, indices, "uint16");
        expect(mesh._cpuGpuIndices).toBe(indices);

        scene.disable();
        const replacement = new Uint16Array([2, 1, 0]);
        engine._dlr!.m(mesh, null, null, null, replacement, "uint16");
        expect(mesh._cpuGpuIndices).toBe(indices);
        sprite.disable();
    });

    it("captures URL texture options by value", () => {
        const engine = {
            _device: {
                features: new Set<GPUFeatureName>(),
                lost: new Promise<GPUDeviceLostInfo>(() => undefined),
            },
        } as unknown as EngineContext;
        const options: Texture2DOptions = { mipMaps: false };
        const texture = {} as Texture2D;
        const recovery = enableDeviceLostSceneRecovery(engine);

        engine._dlr!.u(texture, "texture.png", options);
        options.mipMaps = true;

        expect(texture._recoverySource).toEqual({ kind: "url", url: "texture.png", opts: { mipMaps: false } });
        recovery.disable();
    });

    it("restores the glTF sampler settings used before device loss", async () => {
        const samplerDescriptors: GPUSamplerDescriptor[] = [];
        const engine = {
            _device: {
                features: new Set<GPUFeatureName>(),
                lost: new Promise<GPUDeviceLostInfo>(() => undefined),
                createTexture: vi.fn(() => ({
                    createView: vi.fn(() => ({})),
                })),
                createSampler: vi.fn((descriptor: GPUSamplerDescriptor) => {
                    samplerDescriptors.push(descriptor);
                    return {};
                }),
                queue: {
                    writeTexture: vi.fn(),
                },
            },
        } as unknown as EngineContext;
        const texture = {} as Texture2D;
        const recovery = enableDeviceLostSceneRecovery(engine);

        engine._dlr!.b(texture, null, true, true, new Uint8Array([255, 255, 255, 255]));
        await rebuildTexture2D(engine, texture);

        expect(samplerDescriptors).toContainEqual({
            addressModeU: "repeat",
            addressModeV: "repeat",
            minFilter: "linear",
            magFilter: "linear",
            mipmapFilter: "linear",
            maxAnisotropy: 4,
        });
        recovery.disable();
    });

    it("captures raw pixels and their options by value", () => {
        const engine = {
            _device: {
                features: new Set<GPUFeatureName>(),
                lost: new Promise<GPUDeviceLostInfo>(() => undefined),
            },
        } as unknown as EngineContext;
        const texture = { width: 1, height: 1 } as Texture2D;
        const data = new Uint8Array([1, 2, 3, 4]);
        const options = { srgb: true, minFilter: "nearest" as GPUFilterMode };
        const recovery = enableDeviceLostSpriteRecovery(engine);

        engine._dlr!.p(texture, data, options);
        data[0] = 9;
        options.minFilter = "linear";

        expect(texture._recoverySource).toMatchObject({
            kind: "pixels",
            data: new Uint8Array([1, 2, 3, 4]),
            options: { srgb: true, minFilter: "nearest" },
        });
        recovery.disable();
    });
});
