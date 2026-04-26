/** Standard mesh renderable — builds Renderables from Mesh + StandardMaterial.
 *
 *  `buildSingleStandardRenderable` is the canonical per-mesh path. The batch
 *  `buildStandardMeshRenderables` does shared setup (stashes `_stdCtx` on the
 *  scene + collects shadow lights), then loops single. Material-swap rebuilds
 *  reuse `buildSingleStandardRenderable` directly via `_rebuildSingle`. */

import type { EngineContextInternal } from "../../engine/engine.js";
import type { SceneContext, SceneContextInternal } from "../../scene/scene.js";
import { getOrBuildMeshRenderable } from "../../scene/scene.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { MeshInternal } from "../../mesh/mesh.js";
import type { Renderable } from "../../render/renderable.js";
import type { LightBase } from "../../light/types.js";
import { collectStdBoundTextures } from "./standard-material.js";
import type { StandardMaterialProps } from "./standard-material.js";
import { acquireTexture, releaseTexture, clearSamplerCache } from "../../resource/gpu-pool.js";
import { createUniformBuffer } from "../../resource/gpu-buffers.js";
import {
    computeFeatures,
    getOrCreateStandardBindings,
    getOrCreateStandardPipeline,
    createStandardMeshBindGroup,
    writeLightsUBO,
    refreshLightsUBO,
    releaseStandardBindings,
    clearStandardPipelineCache,
    LIGHTS_UBO_SIZE,
    NEEDS_UV,
    NEEDS_UV2,
    RECEIVE_SHADOWS,
    THIN_INSTANCES,
    THIN_INSTANCE_COLOR,
    HAS_OPACITY_TEXTURE,
    _getStdExts,
    writeStdMaterialData,
} from "./standard-pipeline.js";
import { computeLightsVersion } from "../../render/lights-ubo.js";
import type { ShaderFragment } from "../../shader/fragment-types.js";
import type { ShadowGenerator } from "../../shadow/shadow-generator.js";

/** Scratch buffer for material UBO writes (24 floats = 96 bytes). Reused across
 *  every Standard renderable since `updateUBOs()` is single-threaded per frame. */
const _stdMatScratch = new Float32Array(24);

/** Thin instance GPU sync callback type — loaded dynamically only when needed. */
type ThinInstanceSync = (engine: EngineContextInternal, ti: any, pass: GPURenderPassEncoder | GPURenderBundleEncoder, slot: number, hasColor: boolean) => number;

/** Fragment factories passed from the async group builder. */
export interface StdFragmentFactories {
    tiSync?: ThinInstanceSync;
    tiFragment?: (hasColor: boolean) => ShaderFragment;
    shadowFragment?: (shadowLights: import("./fragments/std-shadow-fragment.js").ShadowLightSlot[]) => ShaderFragment;
}

/** Per-scene Standard build context — populated by `buildStandardMeshRenderables`,
 *  read by `buildSingleStandardRenderable` for material-swap rebuilds. Module-private
 *  so it doesn't pollute the public SceneContext type. */
interface StdBuildCtx {
    factories: StdFragmentFactories;
    shadowLights: { lightIndex: number; shadowType: "esm" | "pcf"; gen: ShadowGenerator }[];
    shadowBGCache: Map<GPUBindGroupLayout, GPUBindGroup>;
    lightsUBOByMask: GPUBuffer[];
    lightsForMask: LightBase[][];
}
const _stdCtxByScene = new WeakMap<SceneContext, StdBuildCtx>();

/** Build one Renderable for a single Standard-material mesh. Requires the scene
 *  to have been initialised by `buildStandardMeshRenderables` (which is also the
 *  only path that wires `_rebuildSingle`). When `materialOverride` is provided,
 *  that material is used instead of `mesh.material` (per-pass material). */
export function buildSingleStandardRenderable(scene: SceneContext, mesh: Mesh, materialOverride?: unknown): Renderable {
    const engine = scene.engine as EngineContextInternal;
    const device = engine.device;
    const ctx = _stdCtxByScene.get(scene)!;
    const { factories, shadowLights, shadowBGCache, lightsUBOByMask, lightsForMask } = ctx;
    const { tiSync, tiFragment, shadowFragment } = factories;
    const hasSomeShadows = shadowLights.length > 0;

    const mat = (materialOverride ?? mesh.material) as StandardMaterialProps;
    let features = computeFeatures(mat, mesh.receiveShadows);
    if (mesh.thinInstances) {
        features |= THIN_INSTANCES;
    }
    if (mesh.thinInstances?.colors) {
        features |= THIN_INSTANCE_COLOR;
    }

    // Build per-feature fragment list for the bindings (deduped via pipeline cache).
    const frags: ShaderFragment[] = [];
    for (const ext of _getStdExts().values()) {
        if (features & ext.feature) {
            const f = ext.frag(features);
            if (f) {
                frags.push(f);
            }
        }
    }
    if (features & RECEIVE_SHADOWS && shadowFragment && hasSomeShadows) {
        const slots = shadowLights.map((sl) => ({ lightIndex: sl.lightIndex, shadowType: sl.shadowType }));
        frags.push(shadowFragment(slots));
    }
    if (features & THIN_INSTANCES && tiFragment) {
        const hasColor = !!(features & THIN_INSTANCE_COLOR);
        const tiFrag = tiFragment(hasColor);
        if (hasColor) {
            // Standard applies instance color to final color (BC), not to baseColor (AT) like PBR.
            const { fragmentSlots: _fragmentSlots, ...rest } = tiFrag;
            frags.push({
                ...rest,
                fragmentSlots: {
                    BC: `color = vec4<f32>(color.rgb * input.vInstanceColor.rgb, color.a * input.vInstanceColor.a);`,
                },
            });
        } else {
            frags.push(tiFrag);
        }
    }
    const bindings = getOrCreateStandardBindings(engine, features, frags);

    // Per-mesh light filtering: bitmask cache (MAX_LIGHTS=4 → at most 16 entries).
    let mask = 0;
    for (let i = 0; i < scene.lights.length; i++) {
        const l = scene.lights[i]!;
        const inc = l.includedOnlyMeshIds;
        if (!mesh.id || (inc?.size ? inc.has(mesh.id) : !l.excludedMeshIds?.has(mesh.id))) {
            mask |= 1 << i;
        }
    }
    if (!lightsUBOByMask[mask]) {
        const filtered = scene.lights.filter((_, i) => (mask >> i) & 1);
        lightsForMask[mask] = filtered;
        lightsUBOByMask[mask] = writeLightsUBO(engine, filtered);
    }
    const lightsBuffer = lightsUBOByMask[mask]!;

    // Per-mesh UBOs.
    const needsUV = (features & NEEDS_UV) !== 0;
    const needsUV2 = (features & NEEDS_UV2) !== 0;
    const hasShadow = (features & RECEIVE_SHADOWS) !== 0;
    const hasOpacityTexture = (features & HAS_OPACITY_TEXTURE) !== 0;
    const hasThinInstances = (features & THIN_INSTANCES) !== 0;
    const hasInstanceColor = (features & THIN_INSTANCE_COLOR) !== 0;

    const meshUBO = createUniformBuffer(engine, mesh.worldMatrix as unknown as Float32Array<ArrayBuffer>);

    const textureLevel = needsUV ? 1.0 : 0;
    const matData = new Float32Array(24);
    writeStdMaterialData(matData, mat, textureLevel);
    const materialUBO = createUniformBuffer(engine, matData);

    let uvUBO: GPUBuffer | null = null;
    if (hasShadow || needsUV) {
        const uvData = new Float32Array(4);
        uvData[0] = mat.uvScale[0];
        uvData[1] = mat.uvScale[1];
        uvUBO = createUniformBuffer(engine, uvData);
    }

    const meshBG = createStandardMeshBindGroup(engine, bindings, meshUBO, materialUBO, uvUBO, lightsBuffer, mat);

    // Shadow bind group (group 2) — shared across receiving meshes via shadowBGCache.
    let shadowBG: GPUBindGroup | null = null;
    const meshShadowGens = mesh.receiveShadows ? shadowLights.map((sl) => sl.gen) : [];
    if (meshShadowGens.length > 0 && bindings.shadowBGL) {
        let cached = shadowBGCache.get(bindings.shadowBGL);
        if (!cached) {
            const entries: GPUBindGroupEntry[] = [];
            let b = 0;
            for (const sg of meshShadowGens) {
                entries.push({ binding: b++, resource: sg.blurredTexture.createView() });
                entries.push({ binding: b++, resource: sg.blurredSampler });
                entries.push({ binding: b++, resource: { buffer: sg.shadowUBO } });
            }
            cached = device.createBindGroup({ layout: bindings.shadowBGL, entries });
            shadowBGCache.set(bindings.shadowBGL, cached);
        }
        shadowBG = cached;
    }

    const boundTextures = collectStdBoundTextures(mat);
    for (const t of boundTextures) {
        acquireTexture(t);
    }
    // Append disposables — multiple Renderables may share a mesh (per-pass overrides).
    const sceneInt = scene as SceneContextInternal;
    let disposables = sceneInt._meshDisposables.get(mesh);
    if (!disposables) {
        disposables = [];
        sceneInt._meshDisposables.set(mesh, disposables);
    }
    disposables.push(
        () => {
            for (const t of boundTextures) {
                releaseTexture(t);
            }
        },
        () => releaseStandardBindings(bindings)
    );

    const isTransparent = hasOpacityTexture || mat.alpha < 1;
    const isMainMat = mat === mesh.material;
    let _lastWorldVersion = mesh.worldMatrixVersion;
    const updateUBOs = (): void => {
        if (mesh.worldMatrixVersion !== _lastWorldVersion) {
            device.queue.writeBuffer(meshUBO, 0, mesh.worldMatrix as unknown as Float32Array<ArrayBuffer>);
            _lastWorldVersion = mesh.worldMatrixVersion;
        }
        const m = mat as any;
        if (m._uboDirty) {
            m._uboDirty = false;
            _stdMatScratch.fill(0);
            writeStdMaterialData(_stdMatScratch, m, textureLevel);
            device.queue.writeBuffer(materialUBO, 0, _stdMatScratch.buffer, 0, 96);
        }
    };

    const r: Renderable = {
        order: mesh.renderOrder ?? (isTransparent ? 200 : 100),
        isTransparent,
        mesh,
        bind(eng, target) {
            const pipeline = getOrCreateStandardPipeline(eng as EngineContextInternal, bindings, target);
            return {
                renderable: r,
                pipeline,
                shadowBG: hasShadow && shadowBG ? shadowBG : undefined,
                updateUBOs,
                draw(pass) {
                    if (isMainMat && mesh.material !== mat) {
                        return 0;
                    }
                    const g = (mesh as MeshInternal)._gpu;
                    let slot = 0;
                    pass.setVertexBuffer(slot++, g.positionBuffer);
                    pass.setVertexBuffer(slot++, g.normalBuffer);
                    if (needsUV) {
                        pass.setVertexBuffer(slot++, g.uvBuffer);
                    }
                    if (needsUV2 && g.uv2Buffer) {
                        pass.setVertexBuffer(slot++, g.uv2Buffer);
                    }

                    const ti = hasThinInstances ? mesh.thinInstances : null;
                    if (ti && tiSync) {
                        slot = tiSync(engine, ti, pass, slot, hasInstanceColor);
                    }

                    pass.setIndexBuffer(g.indexBuffer, g.indexFormat);
                    pass.setBindGroup(1, meshBG);
                    if (ti && ti.count > 0) {
                        pass.drawIndexed(g.indexCount, ti.count);
                    } else {
                        pass.drawIndexed(g.indexCount);
                    }
                    return 1;
                },
            };
        },
    };
    return r;
}

/** Build Renderable(s) + per-frame update callback for a set of standard meshes.
 *  Initialises shared `_stdCtx` on the scene, then delegates per-mesh work to
 *  `buildSingleStandardRenderable`. */
export function buildStandardMeshRenderables(scene: SceneContext, meshes: Mesh[], factories: StdFragmentFactories): { renderables: Renderable[]; update: () => void } {
    const engine = scene.engine as EngineContextInternal;

    const shadowLights: { lightIndex: number; shadowType: "esm" | "pcf"; gen: ShadowGenerator }[] = [];
    for (let i = 0; i < scene.lights.length; i++) {
        const sg = scene.lights[i]!.shadowGenerator;
        if (sg) {
            shadowLights.push({ lightIndex: i, shadowType: sg.shadowType, gen: sg });
        }
    }

    // All receiving meshes in one build share the same shadowLights array,
    // so keying the shadow BG by `shadowBGL` alone is correct here.
    const ctx: StdBuildCtx = {
        factories,
        shadowLights,
        shadowBGCache: new Map<GPUBindGroupLayout, GPUBindGroup>(),
        lightsUBOByMask: [],
        lightsForMask: [],
    };
    _stdCtxByScene.set(scene, ctx);

    const renderables = meshes.map((m) => getOrBuildMeshRenderable(scene, m, m.material!, buildSingleStandardRenderable));

    const lightsScratch = new Float32Array(LIGHTS_UBO_SIZE / 4);
    const lightsVersions: number[] = [];
    const update = (): void => {
        for (let m = 0; m < ctx.lightsUBOByMask.length; m++) {
            const buf = ctx.lightsUBOByMask[m];
            const lights = ctx.lightsForMask[m];
            if (buf && lights) {
                const ver = computeLightsVersion(lights);
                if (ver !== lightsVersions[m]) {
                    lightsVersions[m] = ver;
                    refreshLightsUBO(engine, buf, lights, lightsScratch);
                }
            }
        }
    };

    (scene as SceneContextInternal)._disposables.push(
        () => clearStandardPipelineCache(),
        () => clearSamplerCache(engine),
        () => _stdCtxByScene.delete(scene)
    );

    return { renderables, update };
}
