/** Standard mesh renderable — builds Renderables from Mesh + StandardMaterial.
 *
 *  `buildStandardMeshRenderables` does shared per-scene setup, then delegates
 *  per-mesh work to `buildSingleStandardRenderable`. The same single-mesh
 *  function is reused by the material-swap path. */

import type { EngineContext } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { Renderable, MeshGroupBuildResult } from "../../render/renderable.js";
import { collectStdBoundTextures } from "./collect-std-bound-textures.js";
import type { StandardMaterialProps } from "./standard-material.js";
import { _computeStandardMaterialFeatures, _standardShaderVariantKey } from "./standard-material.js";
import { acquireTexture, releaseTexture, clearSamplerCache } from "../../resource/gpu-pool.js";
import { createUniformBuffer } from "../../resource/gpu-buffers.js";
import { getOrCreateStandardBindings, getOrCreateStandardPipeline, createStandardMeshBindGroup, clearStandardPipelineCache, writeStdMaterialData } from "./standard-pipeline.js";
import { ESM_SHADOW_OUTPUT, NO_COLOR_OUTPUT, NEEDS_UV, NEEDS_UV2, HAS_OPACITY_TEXTURE, _getStdExts } from "./standard-flags.js";
import type { ShaderFragment } from "../../shader/fragment-types.js";
import type { ShadowGenerator } from "../../shadow/shadow-generator.js";
import { writeMeshLightSelection } from "../../render/lights-ubo.js";
import type { Material, MaterialRenderFeatures } from "../material.js";
import { _computeMeshFeatures, MSH_HAS_INSTANCE_COLOR, MSH_HAS_THIN_INSTANCES, MSH_RECEIVE_SHADOWS } from "../mesh-features.js";

/** Scratch buffer for material UBO writes (24 floats = 96 bytes). Reused across
 *  every Standard renderable since binding updates are single-threaded per frame. */
const _stdMatScratch = new Float32Array(24);

/** Thin instance GPU sync callback type — loaded dynamically only when needed. */
type ThinInstanceSync = (engine: EngineContext, ti: any, pass: GPURenderPassEncoder | GPURenderBundleEncoder, slot: number, hasColor: boolean) => number;

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
    const engine = scene.engine;
    const device = engine._device;
    const { tiSync, tiFragment, shadowFragment } = factories;

    // Collect per-light shadow info.
    const shadowLights: { lightIndex: number; shadowType: "esm" | "pcf"; gen: ShadowGenerator }[] = [];
    for (let i = 0; i < scene.lights.length; i++) {
        const sg = scene.lights[i]!.shadowGenerator;
        if (sg) {
            shadowLights.push({ lightIndex: i, shadowType: sg._shadowType, gen: sg });
        }
    }
    const hasSomeShadows = shadowLights.length > 0;

    // All receiving meshes in this build share the same shadow generators,
    // so keying the shadow BG by `bindings._shadowBGL` alone is correct.
    const shadowBGCache = new Map<GPUBindGroupLayout, GPUBindGroup>();
    // Closure used both for the initial per-mesh build below AND for later
    // material-swap / per-pass-override rebuilds (set on standardGroupBuilder._rebuildSingle).
    const rebuildSingle = (s: SceneContext, mesh: Mesh, materialOverride?: Material): Renderable => {
        const mat = (materialOverride ?? mesh.material) as StandardMaterialProps;
        const renderFeatures = (mat._renderFeatures ??= { features: _computeStandardMaterialFeatures(mat) }) as MaterialRenderFeatures;
        const isOverride = materialOverride != null;
        const features = renderFeatures.features;
        const shadowOutput = (features & (NO_COLOR_OUTPUT | ESM_SHADOW_OUTPUT)) !== 0;
        const receiveShadows = !shadowOutput && mesh.receiveShadows && hasSomeShadows;
        const meshFeatures = _computeMeshFeatures(mesh, receiveShadows);
        // Build per-feature fragment list (deduped via pipeline cache).
        const frags: ShaderFragment[] = [];
        for (const ext of _getStdExts().values()) {
            if (features & ext._feature) {
                const f = ext._frag(features);
                if (f) {
                    frags.push(f);
                }
            }
        }
        let shaderKey = "";
        if (meshFeatures & MSH_RECEIVE_SHADOWS && shadowFragment) {
            const slots = shadowLights.map((sl) => ({ lightIndex: sl.lightIndex, shadowType: sl.shadowType }));
            shaderKey = _standardShaderVariantKey(slots);
            frags.push(shadowFragment(slots));
        }
        if (meshFeatures & MSH_HAS_THIN_INSTANCES && tiFragment) {
            const hasColor = !!(meshFeatures & MSH_HAS_INSTANCE_COLOR);
            const tiFrag = tiFragment(hasColor);
            if (hasColor) {
                // Standard applies instance color to final color (BC), not to baseColor (AT) like PBR.
                const { _fragmentSlots: _fragmentSlots, ...rest } = tiFrag;
                frags.push({
                    ...rest,
                    _fragmentSlots: {
                        BC: `color = vec4<f32>(color.rgb * input.vInstanceColor.rgb, color.a * input.vInstanceColor.a);`,
                    },
                });
            } else {
                frags.push(tiFrag);
            }
        }
        const esmShadowDepthCode = (features & ESM_SHADOW_OUTPUT) !== 0 ? (mat as StandardMaterialProps & { readonly _esmShadowDepthCode: string })._esmShadowDepthCode : "";
        const bindings = getOrCreateStandardBindings(engine, features, meshFeatures, frags, shaderKey, esmShadowDepthCode);

        const meshShadowGens = receiveShadows ? shadowLights.map((sl) => sl.gen) : [];

        const meshUboData = new Float32Array(bindings._composed._meshUboSpec._totalBytes / 4);
        meshUboData.set(mesh.worldMatrix, 0);
        writeMeshLightSelection(mesh, s.lights, meshUboData);
        const meshUBO = createUniformBuffer(engine, meshUboData);
        const textureLevel = (features & NEEDS_UV) !== 0 ? 1.0 : 0;
        const matData = new Float32Array(24);
        writeStdMaterialData(matData, mat, textureLevel);
        const materialUBO = createUniformBuffer(engine, matData);
        const meshBindGroup = createStandardMeshBindGroup(engine, bindings, meshUBO, materialUBO, mat);

        // Shadow bind group (group 2) — shared across receiving meshes via shadowBGCache.
        let shadowBindGroup: GPUBindGroup | null = null;
        if (meshShadowGens.length > 0 && bindings._shadowBGL) {
            let cached = shadowBGCache.get(bindings._shadowBGL);
            if (!cached) {
                const entries: GPUBindGroupEntry[] = [];
                let b = 0;
                for (const sg of meshShadowGens) {
                    entries.push({ binding: b++, resource: sg._depthTexture.createView() });
                    entries.push({ binding: b++, resource: sg._depthSampler });
                    entries.push({ binding: b++, resource: { buffer: sg._shadowUBO } });
                }
                cached = device.createBindGroup({ layout: bindings._shadowBGL, entries });
                shadowBGCache.set(bindings._shadowBGL, cached);
            }
            shadowBindGroup = cached;
        }

        const needsUV = (features & NEEDS_UV) !== 0;
        const needsUV2 = (features & NEEDS_UV2) !== 0;
        const hasThinInstances = (meshFeatures & MSH_HAS_THIN_INSTANCES) !== 0;
        const hasInstanceColor = (meshFeatures & MSH_HAS_INSTANCE_COLOR) !== 0;
        const isTransparent = !shadowOutput && ((features & HAS_OPACITY_TEXTURE) !== 0 || mat.alpha < 1);

        const boundTextures = collectStdBoundTextures(mat);
        for (const t of boundTextures) {
            acquireTexture(t);
        }
        s._meshDisposables.set(mesh, [
            () => {
                for (const t of boundTextures) {
                    releaseTexture(t);
                }
            },
        ]);

        let _lastWorldVersion = mesh.worldMatrixVersion;
        let _lastLightsCount = s.lights.length;
        const sortCenter = [mesh.worldMatrix[12]!, mesh.worldMatrix[13]!, mesh.worldMatrix[14]!] as [number, number, number];
        const update = (): void => {
            const worldVersion = mesh.worldMatrixVersion;
            if (worldVersion !== _lastWorldVersion || s.lights.length !== _lastLightsCount) {
                sortCenter[0] = mesh.worldMatrix[12]!;
                sortCenter[1] = mesh.worldMatrix[13]!;
                sortCenter[2] = mesh.worldMatrix[14]!;
                meshUboData.set(mesh.worldMatrix, 0);
                writeMeshLightSelection(mesh, s.lights, meshUboData);
                device.queue.writeBuffer(meshUBO, 0, meshUboData as Float32Array<ArrayBuffer>);
                _lastWorldVersion = worldVersion;
                _lastLightsCount = s.lights.length;
            }
            const uboVersion = mat._uboVersion;
            if (uboVersion !== _lastUboVersion) {
                _lastUboVersion = uboVersion;
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
            const g = mesh._gpu;
            let slot = 0;
            const vb = g._vbLayout;
            pass.setVertexBuffer(slot++, g.positionBuffer, vb?._p?._offset);
            pass.setVertexBuffer(slot++, g.normalBuffer, vb?._n?._offset);
            if (needsUV) {
                pass.setVertexBuffer(slot++, g.uvBuffer, vb?._u?._offset);
            }
            if (needsUV2 && g.uv2Buffer) {
                pass.setVertexBuffer(slot++, g.uv2Buffer, vb?._u2?._offset);
            }

            const ti = hasThinInstances ? mesh.thinInstances : null;
            if (ti && tiSync) {
                slot = tiSync(engine, ti, pass, slot, hasInstanceColor);
            }

            pass.setIndexBuffer(g.indexBuffer, g.indexFormat);
            pass.setBindGroup(1, meshBindGroup);
            if (receiveShadows && shadowBindGroup) {
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
                    pipeline: getOrCreateStandardPipeline(eng as EngineContext, sig, bindings),
                    update,
                    draw,
                };
            },
        };
        r._worldCenter = sortCenter;
        let _lastUboVersion = mat._uboVersion;
        return r;
    };

    const renderables = meshes.map((m) => rebuildSingle(scene, m));

    scene._disposables.push(
        () => clearStandardPipelineCache(),
        () => clearSamplerCache(engine)
    );

    return { renderables, rebuildSingle };
}
