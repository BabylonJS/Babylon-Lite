import { describe, expect, it, vi } from "vitest";

import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine";
import type { MorphTargetData } from "../../../packages/babylon-lite/src/animation/types";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import * as cacheModule from "../../../packages/babylon-lite/src/shadow/csm-shadow-cache";
import { enableCsmStaticCache } from "../../../packages/babylon-lite/src/shadow/enable-csm-static-cache";
import { enableMorphTargetShadows } from "../../../packages/babylon-lite/src/shadow/enable-morph-target-shadows";
import type { ShadowGenerator, ShadowTaskInternalState } from "../../../packages/babylon-lite/src/shadow/shadow-generator";

const gpuGlobals = globalThis as Omit<typeof globalThis, "GPUTextureUsage"> & {
    GPUTextureUsage?: { RENDER_ATTACHMENT: number; TEXTURE_BINDING: number; COPY_DST: number };
};
gpuGlobals.GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x4, COPY_DST: 0x2 } as unknown as GPUTextureUsage;

function makeGenerator(type: ShadowGenerator["_shadowType"] = "csm") {
    const oldTexture = { destroy: vi.fn() };
    const generator = {
        _shadowType: type,
        _depthTexture: oldTexture,
        _config: { _mapSize: 512 },
        _csmCascadeCount: 3,
        _preloadShadowTask: vi.fn(async () => {}),
        _ensureShadowTaskState: vi.fn(),
        _renderShadowMap: vi.fn(),
    } as unknown as ShadowGenerator;
    return { generator, oldTexture };
}

function morphCaster(): Mesh {
    return {
        _cpuPositions: new Float32Array([-1, 0, 0, 1, 0, 0]),
        boundMin: [-1, 0, 0],
        boundMax: [1, 0, 0],
        worldMatrixVersion: 0,
        morphTargets: {
            count: 1,
            weights: new Float32Array([1]),
            weightsBuffer: {} as GPUBuffer,
            targets: [{ positions: new Float32Array([2, 0, 0, 2, 0, 0]), normals: null }],
        } as unknown as MorphTargetData,
    } as unknown as Mesh;
}

describe("enableCsmStaticCache", () => {
    it("loads the cache and replaces the live map with a copy destination", async () => {
        const { generator, oldTexture } = makeGenerator();
        const texture = { destroy: vi.fn() };
        const createTexture = vi.fn(() => texture);
        const engine = { _device: { createTexture }, surfaces: [{ _renderingContexts: [] }] } as unknown as EngineContext;

        const enabled = enableCsmStaticCache(engine, generator, { refitAngle: 0.05, refitMaxIntervalMs: 250 });

        expect(createTexture).toHaveBeenCalledWith({
            size: { width: 512, height: 512, depthOrArrayLayers: 3 },
            format: "depth32float",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        expect(generator._depthTexture).toBe(texture);
        expect(oldTexture.destroy).toHaveBeenCalledOnce();

        await enabled;
        expect(generator._csmCache).toMatchObject({ _refitAngle: 0.05, _refitMaxIntervalMs: 250, _loaded: true });
    });

    it("rejects invalid generators, angles, and late activation", async () => {
        const engine = { _device: { createTexture: vi.fn() }, surfaces: [{ _renderingContexts: [] }] } as unknown as EngineContext;
        await expect(enableCsmStaticCache(engine, makeGenerator("pcf").generator, { refitAngle: 0.05 })).rejects.toThrow("requires a CSM");
        await expect(enableCsmStaticCache(engine, makeGenerator().generator, { refitAngle: 0 })).rejects.toThrow("positive finite");

        const late = makeGenerator().generator;
        late._shadowTaskState = {} as ShadowGenerator["_shadowTaskState"];
        await expect(enableCsmStaticCache(engine, late, { refitAngle: 0.05 })).rejects.toThrow("before scene registration");

        const registered = makeGenerator().generator;
        const registeredEngine = { _device: { createTexture: vi.fn() }, surfaces: [{ _renderingContexts: [{}] }] } as unknown as EngineContext;
        await expect(enableCsmStaticCache(registeredEngine, registered, { refitAngle: 0.05 })).rejects.toThrow("before scene registration");
    });

    it.each(["deformation-first", "cache-first"] as const)("composes with deformable shadows when enabled %s", async (order) => {
        const { generator } = makeGenerator();
        const engine = { _device: { createTexture: vi.fn(() => ({ destroy: vi.fn() })) }, surfaces: [{ _renderingContexts: [] }] } as unknown as EngineContext;
        const caster = morphCaster();
        const casters = [caster];
        const taskState = {
            _casterMeshes: casters,
            _task: { record: vi.fn(), dispose: vi.fn() },
        } as unknown as ShadowTaskInternalState;
        let ensuredCasters: readonly Mesh[] | undefined;
        vi.spyOn(cacheModule, "ensureCsmShadowCacheState").mockImplementation((_engine, _scene, _generator, _config, casterMeshes) => {
            ensuredCasters = casterMeshes;
            taskState._casterMeshes = casterMeshes;
            return taskState as never;
        });
        let renderedCasters: readonly Mesh[] | undefined;
        vi.spyOn(cacheModule, "renderCsmShadowMapCached").mockImplementation((_engine, _generator, state) => {
            renderedCasters = state._casterMeshes;
            return 1;
        });

        if (order === "deformation-first") {
            enableMorphTargetShadows(generator);
        }
        await enableCsmStaticCache(engine, generator, { refitAngle: 0.05 });
        if (order === "cache-first") {
            enableMorphTargetShadows(generator);
        }

        await generator._preloadShadowTask!(casters);
        const state = generator._ensureShadowTaskState!(engine, {} as SceneContext, casters);
        generator._renderShadowMap!(engine, state);

        const shadowCasters = ensuredCasters!;
        expect(shadowCasters[0]).not.toBe(caster);
        expect(shadowCasters[0]!.boundMin).toEqual([1, 0, 0]);
        expect(shadowCasters[0]!.boundMax).toEqual([3, 0, 0]);
        expect(renderedCasters).toBe(shadowCasters);
        expect(state._casterMeshes).toBe(casters);
    });
});
