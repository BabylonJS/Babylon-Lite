/** Standard mesh renderable — builds Renderables from Mesh + StandardMaterial.
 *
 *  `buildStandardMeshRenderables` does shared per-scene setup (registers a
 *  `_stdCtxByScene` ctx + builds the unified scene-uniform updater), then
 *  delegates per-mesh work to `buildSingleStandardRenderable`. The same
 *  single-mesh function is reused by the material-swap path. */

import type { EngineContext } from "../../engine/engine.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { SceneContext, SceneContextInternal } from "../../scene/scene.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { MeshInternal } from "../../mesh/mesh.js";
import type { Renderable, SceneUniformUpdater, MeshGroupBuildResult } from "../../render/renderable.js";
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
    clearStandardPipelineCache,
    getLightsUboSize,
    writeStdMaterialData,
} from "./standard-pipeline.js";
import { NEEDS_UV, NEEDS_UV2, RECEIVE_SHADOWS, THIN_INSTANCES, THIN_INSTANCE_COLOR, HAS_OPACITY_TEXTURE, _getStdExts } from "./standard-flags.js";
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

/** Build Renderable(s) + a SceneUniformUpdater for a set of standard meshes.
 *  The `rebuildSingle` closure is reused later (via `_rebuildSingle` on the group
 *  builder) for material swaps + per-pass material overrides. */
export function buildStandardMeshRenderables(scene: SceneContext, meshes: Mesh[], factories: StdFragmentFactories): MeshGroupBuildResult {
    const engine = scene.engine as EngineContextInternal;
    const device = engine.device;
    const { tiSync, tiFragment, shadowFragment } = factories;

    // Collect per-light shadow info.
    const shadowLights: { lightIndex: number; shadowType: "esm" | "pcf"; gen: ShadowGenerator }[] = [];
    for (let i = 0; i < scene.lights.length; i++) {
        const sg = scene.lights[i]!.shadowGenerator;
        if (sg) {
            shadowLights.push({ lightIndex: i, shadowType: sg.shadowType, gen: sg });
        }
    }
    const hasSomeShadows = shadowLights.length > 0;

    // All receiving meshes in this build share the same shadow generators,
    // so keying the shadow BG by `bindings.shadowBGL` alone is correct.
    const shadowBGCache = new Map<GPUBindGroupLayout, GPUBindGroup>();
    /** Indexed by light bitmask (≤ 16 entries for MAX_LIGHTS=4). */
    const lightsUBOByMask: GPUBuffer[] = [];
    /** Parallel to lightsUBOByMask — lights present in each bitmask. */
    const lightsForMask: LightBase[][] = [];

    // Closure used both for the initial per-mesh build below AND for later
    // material-swap / per-pass-override rebuilds (set on standardGroupBuilder._rebuildSingle).
    const rebuildSingle = (s: SceneContext, mesh: Mesh, materialOverride?: unknown): Renderable => {
        const mat = (materialOverride ?? mesh.material) as StandardMaterialProps;
        const isOverride = materialOverride != null;
        let features = computeFeatures(mat, mesh.receiveShadows);
        if (mesh.thinInstances) {
            features |= THIN_INSTANCES;
        }
        if (mesh.thinInstances?.colors) {
            features |= THIN_INSTANCE_COLOR;
        }

        // Build per-feature fragment list (deduped via pipeline cache).
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
        for (let i = 0; i < s.lights.length; i++) {
            const l = s.lights[i]!;
            const inc = l.includedOnlyMeshIds;
            if (!mesh.id || (inc?.size ? inc.has(mesh.id) : !l.excludedMeshIds?.has(mesh.id))) {
                mask |= 1 << i;
            }
        }
        if (!lightsUBOByMask[mask]) {
            const filtered = s.lights.filter((_, i) => (mask >> i) & 1);
            lightsForMask[mask] = filtered;
            lightsUBOByMask[mask] = writeLightsUBO(engine, filtered);
        }
        const lightsBuffer = lightsUBOByMask[mask]!;

        const meshShadowGens = mesh.receiveShadows ? shadowLights.map((sl) => sl.gen) : [];

        const meshUBO = createUniformBuffer(engine, mesh.worldMatrix);
        const textureLevel = (features & NEEDS_UV) !== 0 ? 1.0 : 0;
        const matData = new Float32Array(24);
        writeStdMaterialData(matData, mat, textureLevel);
        const materialUBO = createUniformBuffer(engine, matData);
        const meshBindGroup = createStandardMeshBindGroup(engine, bindings, meshUBO, materialUBO, lightsBuffer, mat);

        // Shadow bind group (group 2) — shared across receiving meshes via shadowBGCache.
        let shadowBindGroup: GPUBindGroup | null = null;
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
            shadowBindGroup = cached;
        }

        const needsUV = (features & NEEDS_UV) !== 0;
        const needsUV2 = (features & NEEDS_UV2) !== 0;
        const hasShadow = (features & RECEIVE_SHADOWS) !== 0;
        const hasOpacityTexture = (features & HAS_OPACITY_TEXTURE) !== 0;
        const hasThinInstances = (features & THIN_INSTANCES) !== 0;
        const hasInstanceColor = (features & THIN_INSTANCE_COLOR) !== 0;
        const isTransparent = hasOpacityTexture || mat.alpha < 1;

        const boundTextures = collectStdBoundTextures(mat);
        for (const t of boundTextures) {
            acquireTexture(t);
        }
        (s as SceneContextInternal)._meshDisposables.set(mesh, [
            () => {
                for (const t of boundTextures) {
                    releaseTexture(t);
                }
            },
        ]);

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
                writeStdMaterialData(_stdMatScratch, mat, textureLevel);
                device.queue.writeBuffer(materialUBO, 0, _stdMatScratch.buffer, 0, 96);
            }
        };

        const draw = (pass: GPURenderPassEncoder | GPURenderBundleEncoder): number => {
            // For per-pass material overrides, skip the mesh.material === mat guard
            // because the override material is intentionally not the mesh's current one.
            if (!isOverride && mesh.material !== mat) {
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
            pass.setBindGroup(1, meshBindGroup);
            if (hasShadow && shadowBindGroup) {
                pass.setBindGroup(2, shadowBindGroup);
            }
            if (ti && ti.count > 0) {
                pass.drawIndexed(g.indexCount, ti.count);
            } else {
                pass.drawIndexed(g.indexCount);
            }
            return 1;
        };

        const r: Renderable = {
            order: mesh.renderOrder ?? (isTransparent ? 200 : 100),
            isTransparent,
            mesh,
            bind(eng, sig) {
                return {
                    renderable: r,
                    pipeline: getOrCreateStandardPipeline(eng as EngineContextInternal, sig, bindings),
                    updateUBOs,
                    draw,
                };
            },
        };
        return r;
    };

    const renderables = meshes.map((m) => rebuildSingle(scene, m));

    // Pre-allocated scratch buffer for light UBO refresh.
    const lightsScratch = new Float32Array(getLightsUboSize() / 4);
    const lightsVersions: number[] = [];

    // Per-frame light UBO refresh — scene UBO is now written by the active
    // RenderPassTask via writePassSceneUBO.
    const updater: SceneUniformUpdater = {
        update(eng: EngineContext) {
            for (let m = 0; m < lightsUBOByMask.length; m++) {
                const buf = lightsUBOByMask[m];
                if (buf && lightsForMask[m]) {
                    const ver = computeLightsVersion(lightsForMask[m]!);
                    if (ver !== lightsVersions[m]) {
                        lightsVersions[m] = ver;
                        refreshLightsUBO(eng as EngineContextInternal, buf, lightsForMask[m]!, lightsScratch);
                    }
                }
            }
        },
    };

    (scene as SceneContextInternal)._disposables.push(
        () => clearStandardPipelineCache(),
        () => clearSamplerCache(engine)
    );

    return { renderables, updater, rebuildSingle };
}
