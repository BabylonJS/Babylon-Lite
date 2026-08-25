import { describe, expect, it, vi } from "vitest";

import { _enableDeviceLostRecovery, markNextDeviceLossForRecovery } from "../../../packages/babylon-lite/src/engine/device-lost-recovery.js";
import type { DeviceLostRecoveryState } from "../../../packages/babylon-lite/src/engine/device-lost-recovery.js";
import { runDeviceLostRecovery } from "../../../packages/babylon-lite/src/engine/device-lost-recovery-run.js";
import { enableDeviceLostSceneRecovery } from "../../../packages/babylon-lite/src/engine/device-lost-scene-recovery.js";
import { enableDeviceLostSpriteRecovery } from "../../../packages/babylon-lite/src/engine/device-lost-sprite-recovery.js";
import { enableDeviceLostTextRecovery } from "../../../packages/babylon-lite/src/engine/device-lost-text-recovery.js";
import type { EngineContext, RenderingContext } from "../../../packages/babylon-lite/src/engine/engine.js";
import type { SurfaceContext } from "../../../packages/babylon-lite/src/engine/surface.js";
import { buildSampledPbrTextures } from "../../../packages/babylon-lite/src/loader-gltf/gltf-sampler-desc.js";
import { makeSamplerFor } from "../../../packages/babylon-lite/src/loader-gltf/gltf-sampler-desc.js";
import type { GltfMaterialData } from "../../../packages/babylon-lite/src/loader-gltf/gltf-material.js";
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

    it("preserves non-default glTF sampler settings through recovery", async () => {
        const samplerDescriptors: GPUSamplerDescriptor[] = [];
        const device = {
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
        } as unknown as GPUDevice;
        const engine = { _device: device } as unknown as EngineContext;
        const defaultSampler = {} as GPUSampler;
        const bitmap = {} as ImageBitmap;
        const texture = {
            texture: {} as GPUTexture,
            view: {} as GPUTextureView,
            sampler: defaultSampler,
            width: 1,
            height: 1,
        } as Texture2D;
        const textureInfo = { index: 0 };
        const material = {
            _rawMatDef: {
                pbrMetallicRoughness: {
                    baseColorTexture: textureInfo,
                    metallicRoughnessTexture: textureInfo,
                },
            },
            _baseColorImage: bitmap,
            _baseColorFactor: [1, 1, 1, 1],
            _metallicRoughnessImage: bitmap,
            _occlusionImage: bitmap,
            _normalImage: null,
            _emissiveImage: null,
            _roughnessFactor: 1,
            _metallicFactor: 1,
        } as unknown as GltfMaterialData;
        const recovery = enableDeviceLostSceneRecovery(engine);
        engine._dlr!.b(texture, null, true, true, new Uint8Array([255, 255, 255, 255]));
        const samplerFor = makeSamplerFor(
            engine,
            {
                textures: [{ sampler: 0 }],
                samplers: [{ wrapS: 33071, wrapT: 33648, magFilter: 9728, minFilter: 9728 }],
            },
            defaultSampler
        );
        const textures = buildSampledPbrTextures(engine, material, defaultSampler, vi.fn(), samplerFor, () => texture);

        samplerDescriptors.length = 0;
        await rebuildTexture2D(engine, textures.baseColorTexture);

        expect(samplerDescriptors).toContainEqual({
            addressModeU: "clamp-to-edge",
            addressModeV: "mirror-repeat",
            minFilter: "nearest",
            magFilter: "nearest",
            mipmapFilter: "linear",
            lodMaxClamp: 0,
            maxAnisotropy: 1,
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

describe("device-lost recovery unrecoverable context guard", () => {
    function recoverableEngine(...contexts: RenderingContext[]): EngineContext {
        const engine = engineWith(...contexts);
        Object.assign(engine, { _animFrameId: 0, _renderFn: null, _retirements: null });
        return engine;
    }

    const state = { _requiredFeatures: [] as GPUFeatureName[] } as unknown as DeviceLostRecoveryState;

    it("refuses to recover, without touching the GPU, when a registered context kind has no strategy", async () => {
        // Recovering around it would swap in a replacement device, report success, and leave the
        // text renderer drawing with buffers owned by the dead device — a use-after-free that kills
        // the whole browser renderer process a frame later instead of failing cleanly here.
        const engine = recoverableEngine(context("scene"), context("text-renderer"));
        const requestAdapter = vi.fn();
        vi.stubGlobal("navigator", { gpu: { requestAdapter } });

        await expect(runDeviceLostRecovery(engine, state, [{ _kind: "scene", _recover: vi.fn() }])).rejects.toThrow(/text-renderer/);

        expect(requestAdapter).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it("reports every abandoned kind, deduplicated and in a stable order", async () => {
        // Several contexts of the same abandoned kind are one problem, not many, and the order the
        // surfaces happen to be walked in must not change the message.
        const engine = recoverableEngine(context("sprite-renderer"), context("effect-renderer"), context("sprite-renderer"));
        vi.stubGlobal("navigator", { gpu: { requestAdapter: vi.fn() } });

        await expect(runDeviceLostRecovery(engine, state, [{ _kind: "text-renderer", _recover: vi.fn() }])).rejects.toThrow(/kind: effect-renderer, sprite-renderer\./);

        vi.unstubAllGlobals();
    });

    it("proceeds to reacquire a device once every registered context kind is covered", async () => {
        const engine = recoverableEngine(context("scene"), context("text-renderer"));
        const requestAdapter = vi.fn(async () => null);
        vi.stubGlobal("navigator", { gpu: { requestAdapter } });

        const registrations = [
            { _kind: "scene", _recover: vi.fn() },
            { _kind: "text-renderer", _recover: vi.fn() },
        ];
        await expect(runDeviceLostRecovery(engine, state, registrations)).rejects.toThrow(/adapter not available/);

        expect(requestAdapter).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();
    });
});

describe("device-lost recovery unreferenced texture rebuild", () => {
    function device(): GPUDevice {
        return {
            features: new Set<GPUFeatureName>(),
            lost: new Promise<GPUDeviceLostInfo>(() => undefined),
            createTexture: vi.fn(() => ({ createView: vi.fn(() => ({})) })),
            createSampler: vi.fn(() => ({})),
            queue: { writeTexture: vi.fn() },
        } as unknown as GPUDevice;
    }

    function trackingEngine(): EngineContext {
        return {
            _device: device(),
            surfaces: [],
            _animFrameId: 0,
            _renderFn: null,
            _retirements: null,
        } as unknown as EngineContext;
    }

    function pixelsTexture(): Texture2D {
        return { texture: {} as GPUTexture, view: {} as GPUTextureView, sampler: {} as GPUSampler, width: 1, height: 1 } as Texture2D;
    }

    it("tracks captured textures weakly so tracking never keeps an app texture alive", () => {
        const engine = trackingEngine();
        const recovery = enableDeviceLostSpriteRecovery(engine);
        const texture = pixelsTexture();

        engine._dlr!.p(texture, new Uint8Array([1, 2, 3, 4]), {});

        const tracked = Array.from(engine._deviceLostRecovery!._textures);
        expect(tracked).toHaveLength(1);
        expect(tracked[0]).toBeInstanceOf(WeakRef);
        expect(tracked[0]!.deref()).toBe(texture);
        recovery.disable();
    });

    it("rebuilds a recoverable texture that no registered rendering context references", async () => {
        // A sprite atlas page the app owns but has not drawn from yet is reachable from nothing the
        // per-kind recovery walks visit. Leaving it on the lost device turns the next writeTexture
        // into a use-after-free that kills the browser renderer process long after recovery
        // "succeeded", so recovery rebuilds every captured texture regardless of reachability.
        const engine = trackingEngine();
        const recovery = enableDeviceLostSpriteRecovery(engine);
        const texture = pixelsTexture();
        engine._dlr!.p(texture, new Uint8Array([1, 2, 3, 4]), {});
        const lost = texture.texture;

        const replacement = device();
        vi.stubGlobal("navigator", { gpu: { requestAdapter: vi.fn(async () => ({ features: new Set<GPUFeatureName>(), requestDevice: vi.fn(async () => replacement) })) } });

        const order: string[] = [];
        const registrations = [
            {
                _kind: "sprite-renderer",
                _recover: vi.fn(() => {
                    order.push(`recover:${texture.texture === lost ? "stale" : "rebuilt"}`);
                }),
            },
        ];
        await runDeviceLostRecovery(engine, engine._deviceLostRecovery!, registrations);

        expect(texture.texture).not.toBe(lost);
        expect(replacement.createTexture).toHaveBeenCalledTimes(1);
        // Textures are valid before any context handler runs, so handlers can bind them directly.
        expect(order).toEqual(["recover:rebuilt"]);
        vi.unstubAllGlobals();
        recovery.disable();
    });

    it("restores bytes appended after creation and keeps the wrapper identity the app holds", async () => {
        // LineLayout's shape: an atlas page is populated in bitmap mode, goes idle when the app
        // switches to outline (no Sprite2DLayer references it any more), survives a device loss,
        // and is bound again when the app switches back — so nothing referenced it at loss time
        // and reachability never found it. The app still holds the same wrapper and the same
        // frame indices into it, so the rebuild has to restore the appended glyph bytes into that
        // same object rather than hand back a replacement.
        const engine = trackingEngine();
        const recovery = enableDeviceLostSpriteRecovery(engine);
        const atlas = pixelsTexture();
        atlas.width = 2;
        atlas.height = 1;
        engine._dlr!.p(atlas, new Uint8Array([1, 1, 1, 1, 0, 0, 0, 0]), {});
        // A glyph appended after creation only ever reaches the CPU shadow through `w`.
        engine._dlr!.w(atlas, new Uint8Array([9, 9, 9, 9]), 1, 0, 1, 1);
        const lost = atlas.texture;

        const replacement = device();
        vi.stubGlobal("navigator", { gpu: { requestAdapter: vi.fn(async () => ({ features: new Set<GPUFeatureName>(), requestDevice: vi.fn(async () => replacement) })) } });
        await runDeviceLostRecovery(engine, engine._deviceLostRecovery!, [{ _kind: "sprite-renderer", _recover: vi.fn() }]);

        expect(atlas.texture).not.toBe(lost);
        const upload = vi.mocked(replacement.queue.writeTexture).mock.calls[0];
        expect(Array.from(upload![1] as Uint8Array)).toEqual([1, 1, 1, 1, 9, 9, 9, 9]);
        vi.unstubAllGlobals();
        recovery.disable();
    });

    it("rebuilds each texture once per device even when a handler walks it again", async () => {
        const engine = trackingEngine();
        const recovery = enableDeviceLostSpriteRecovery(engine);
        const texture = pixelsTexture();
        engine._dlr!.p(texture, new Uint8Array([1, 2, 3, 4]), {});

        const replacement = device();
        vi.stubGlobal("navigator", { gpu: { requestAdapter: vi.fn(async () => ({ features: new Set<GPUFeatureName>(), requestDevice: vi.fn(async () => replacement) })) } });
        await runDeviceLostRecovery(engine, engine._deviceLostRecovery!, [{ _kind: "sprite-renderer", _recover: vi.fn() }]);

        const rebuilt = texture.texture;
        await rebuildTexture2D(engine, texture);

        expect(texture.texture).toBe(rebuilt);
        expect(replacement.createTexture).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();
        recovery.disable();
    });
});
