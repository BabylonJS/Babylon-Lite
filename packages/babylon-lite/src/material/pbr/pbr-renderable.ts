/** PBR mesh renderable — builds Renderables from glTF PBR meshes + environment.
 *
 *  `buildPbrRenderables` does shared per-scene setup (extension/fragment imports,
 *  shader composer, scene bind group, multi-light UBO), then delegates per-mesh
 *  work to `buildSinglePbrRenderable`. Both initial build and material-swap
 *  rebuilds go through the same single-mesh function. */

import type { EngineContextInternal } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { SceneContextInternal } from "../../scene/scene.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { MeshInternal } from "../../mesh/mesh.js";
import type { LightBaseInternal } from "../../light/types.js";
import type { PbrMaterialProps } from "./pbr-material.js";
import { collectPbrBoundTextures } from "./pbr-material.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";

import type { Renderable, MeshGroupBuildResult } from "../../render/renderable.js";
import type { ShaderFragment } from "../../shader/fragment-types.js";
import { acquireTexture, releaseTexture, clearSamplerCache } from "../../resource/gpu-pool.js";
import { createUniformBuffer } from "../../resource/gpu-buffers.js";
import { getOrCreatePbrBindings, getOrCreatePbrPipeline, createPbrMeshBindGroup, clearPbrPipelineCache } from "./pbr-pipeline.js";
import {
    _registerPbrExt,
    _getPbrExts,
    PBR_HAS_NORMAL_MAP,
    PBR_HAS_ALPHA_BLEND,
    PBR2_NO_COLOR_OUTPUT,
    PBR2_HAS_REFRACTION,
    PBR2_HAS_UV2,
    PBR_HAS_ENV,
    PBR_HAS_TONEMAP,
    PBR2_ESM_SHADOW_OUTPUT,
} from "./pbr-flags.js";
import { createPbrComposer } from "./pbr-compose.js";
import { _computePbrMaterialFeatures } from "./pbr-material.js";
import type { ShadowGenerator } from "../../shadow/shadow-generator.js";
import type { ThinInstanceData } from "../../mesh/thin-instance.js";
import type { PbrShadowLightSlot } from "./fragments/pbr-shadow-fragment.js";
import { writeMeshLightSelection } from "../../render/lights-ubo.js";
import type { PbrLightMode } from "./pbr-compose.js";
import type { Material, MaterialRenderFeatures } from "../material.js";
import { _computeMeshFeatures, MSH_HAS_INSTANCE_COLOR, MSH_HAS_THIN_INSTANCES, MSH_HAS_UV2, MSH_HAS_VERTEX_COLOR } from "../mesh-features.js";

type SingleLightType = "hemispheric" | "directional" | "spot" | "point";
interface SingleLightWgslModule {
    SINGLE_LIGHT_STRUCTS: string;
    getSingleLightBlock(): string;
}

/** Build PBR Renderable(s) + a SceneUniformUpdater from PBR meshes. */
export async function buildPbrRenderables(scene: SceneContext, meshes: Mesh[], envTextures: EnvironmentTextures | undefined): Promise<MeshGroupBuildResult> {
    const engine = scene.engine as EngineContextInternal;
    const device = engine.device;
    // Per-size scratch buffers for material UBO re-writes (zero allocation per frame).
    const materialScratch = new Map<number, Float32Array>();
    const hasEnv = !!envTextures;
    const shadowLights: { lightIndex: number; shadowType: "esm" | "pcf"; gen: ShadowGenerator }[] = [];
    for (let i = 0; i < scene.lights.length; i++) {
        const sg = scene.lights[i]!.shadowGenerator;
        if (sg) {
            shadowLights.push({ lightIndex: i, shadowType: sg._shadowType, gen: sg });
        }
    }
    const hasSomeShadows = shadowLights.length > 0;
    let hasAnyAffectedLight = false;
    let needsSingleLightPath = false;
    let needsMultiLightPath = false;
    const singleLightTypes: SingleLightType[] = [];
    for (const mesh of meshes) {
        const lr = writeMeshLightSelection(mesh, scene.lights);
        const affectedCount = lr > 0 ? 1 : -lr;
        hasAnyAffectedLight ||= affectedCount > 0;
        if (affectedCount === 1 && !(mesh.receiveShadows && hasSomeShadows)) {
            needsSingleLightPath = true;
            const type = getPackedSingleLightType(scene.lights, lr - 1);
            if (!singleLightTypes.includes(type)) {
                singleLightTypes.push(type);
            }
        } else if (affectedCount > 0) {
            needsMultiLightPath = true;
        }
    }

    // ── Single O(N) scan over meshes for all scene-wide feature flags ──
    // Flags are plain locals (not an object return) so terser can mangle their names.
    // Replaces ~11 sequential meshes.some() loops (was O(11N)).
    let hasSkybox = false;
    let hasMetallicReflectance = false;
    let hasClearcoat = false;
    let hasSheen = false;
    let hasAnyAnisotropy = false;
    let hasAnySubsurface = false;
    let hasAlphaTest = false;
    let hasTransmissionRefraction = false;
    let needsEmissiveColor = false;
    let hasSomeSkeletons = false;
    let hasSomeMorphs = false;
    let hasSomeThinInstances = false;
    let hasAnyUnlit = false;
    let hasAnyUvTransform = false;
    let hasAnyUv2 = false;
    let hasAnyVertexColor = false;
    for (let i = 0; i < meshes.length; i++) {
        const m = meshes[i]!;
        const mat = m.material as PbrMaterialProps & { _hasReflExt?: boolean; _hasUvTx?: boolean };
        const mi = m as MeshInternal;
        const refractionIntensity = mat.subsurface?.refraction?.intensity ?? 0;
        hasSkybox ||= !!mat.skyboxMode;
        hasMetallicReflectance ||= !!(mat.metallicReflectanceTexture || mat.reflectanceTexture || mat._hasReflExt);
        hasClearcoat ||= !!mat.clearCoat?.isEnabled;
        hasSheen ||= !!mat.sheen?.isEnabled;
        hasAnyAnisotropy ||= !!mat.anisotropy?.isEnabled;
        hasAnySubsurface ||= !!mat.subsurface?.translucency;
        hasAlphaTest ||= mat.alphaCutOff! > 0;
        hasTransmissionRefraction ||= refractionIntensity > 0 && !!mat.transmissive;
        needsEmissiveColor ||= !!mat.emissiveColor;
        hasSomeSkeletons ||= !!m.skeleton;
        hasSomeMorphs ||= !!m.morphTargets;
        hasSomeThinInstances ||= !!m.thinInstances;
        hasAnyUnlit ||= !!mat.unlit;
        hasAnyUvTransform ||= !!mat._hasUvTx;
        // UV2 only counts when occlusion samples texcoord 1.
        hasAnyUv2 ||= !!mi._gpu.uv2Buffer && mat.occlusionTexCoord === 1;
        hasAnyVertexColor ||= !!mi._gpu.colorBuffer;
    }

    // ── Dynamically import fragment creators based on scene capabilities ──

    // IBL fragment.
    let _iblSkyboxCalc = "";
    if (hasEnv) {
        const mod = await import("./fragments/ibl-fragment.js");
        _registerPbrExt(mod.iblExt);
        if (hasSkybox) {
            // Skybox-mode WGSL is only loaded when at least one mesh in the scene needs it.
            const sky = await import("./fragments/ibl-skybox-wgsl.js");
            _iblSkyboxCalc = sky.IBL_SKYBOX_CALCULATION;
        }
    }

    // Light/shadow helpers stay dynamic so single-light and non-shadow bundles stay lean.
    let _createPbrShadowFragment: ((slots: PbrShadowLightSlot[]) => ShaderFragment) | null = null;
    let _singleLightWGSL = "";
    let _getSingleLightBlock: ((type: string) => string) | null = null;
    const singleLightBlocks: Partial<Record<SingleLightType, () => string>> = {};
    let _multiLightWGSL = "";
    let _multiLightLoop = "";
    if (needsSingleLightPath) {
        for (const type of singleLightTypes) {
            const single = await importSingleLightWgsl(type);
            _singleLightWGSL = single.SINGLE_LIGHT_STRUCTS;
            singleLightBlocks[type] = single.getSingleLightBlock;
        }
        _getSingleLightBlock = (type) => singleLightBlocks[toSingleLightType(type)]?.() ?? "";
    }
    if (needsMultiLightPath) {
        const wgslMod = await import("./fragments/multilight-wgsl.js");
        _multiLightWGSL = wgslMod.MULTI_LIGHT_STRUCTS() + wgslMod.COMPUTE_PBR_LIGHT;
        _multiLightLoop = wgslMod.getMultiLightLoop();
    }
    if (hasAnyAffectedLight && hasSomeShadows) {
        const shadowMod = await import("./fragments/pbr-shadow-fragment.js");
        _createPbrShadowFragment = shadowMod.createPbrShadowFragment;
    }

    // ── Per-mesh fragment creators (imported if any mesh needs them) ──
    // Inline `if` blocks (rather than a descriptor array) keep the awaited `import()`
    // sites literal AND let terser shorten each block independently, saving ~1 KB
    // in scene1's pbr-renderable chunk. Registration runs sequentially in source
    // order, which is the iteration order consumed by `_getPbrExts().values()` on
    // the hot paths (composePbr, writeMaterialData, collectPbrBoundTextures).
    if (hasAlphaTest) {
        const mod = await import("./fragments/alpha-test-fragment.js");
        _registerPbrExt(mod.alphaTestExt);
    }
    if (hasMetallicReflectance) {
        const mod = await import("./fragments/reflectance-fragment.js");
        _registerPbrExt(mod.reflectanceExt);
    }
    if (hasClearcoat) {
        const mod = await import("./fragments/clearcoat-fragment.js");
        _registerPbrExt(mod.clearcoatExt);
    }
    if (hasSheen) {
        const mod = await import("./fragments/sheen-fragment.js");
        _registerPbrExt(mod.sheenExt);
    }
    if (hasAnySubsurface) {
        const mod = await import("./fragments/subsurface-fragment.js");
        _registerPbrExt(mod.subsurfaceExt);
    }
    if (hasTransmissionRefraction) {
        const mod = await import("./pbr-refraction.js");
        await mod.registerPbrRefraction(scene as SceneContextInternal, engine, _registerPbrExt);
    }
    if (needsEmissiveColor) {
        const mod = await import("./fragments/emissive-fragment.js");
        _registerPbrExt(mod.emissiveColorExt);
    }
    if (hasAnyUnlit) {
        const mod = await import("./fragments/unlit-fragment.js");
        _registerPbrExt(mod.unlitExt);
    }
    if (hasSomeSkeletons) {
        const mod = await import("./fragments/skeleton-fragment.js");
        _registerPbrExt(mod.skeletonExt);
    }
    if (hasSomeMorphs) {
        const mod = await import("./fragments/morph-fragment.js");
        _registerPbrExt(mod.morphExt);
    }
    if (hasAnyUvTransform) {
        const mod = await import("./fragments/uv-transform-fragment.js");
        _registerPbrExt(mod.uvTransformExt);
    }

    // Anisotropy needs its module reference retained (for ANISO_BRDF_FUNCTIONS /
    // makeAnisotropyTBBlock / ANISO_DIRECT_DG / ANISO_BENT_NORMAL strings consumed
    // by the template below), so it keeps the full module binding.
    let _anisoExt: typeof import("./fragments/anisotropy-fragment.js") | null = null;
    if (hasAnyAnisotropy) {
        _anisoExt = await import("./fragments/anisotropy-fragment.js");
        _registerPbrExt(_anisoExt.anisotropyExt);
    }

    // Lazy-load pbr-template-ext when any advanced features are present.
    // Scene1 has none of these, so it won't pay the ~1.5KB cost.
    let _createPbrTemplateExt: typeof import("./pbr-template-ext.js").createPbrTemplateExt | null = null;
    if (hasAnyUvTransform || hasAnyVertexColor || hasAnyUv2) {
        const extMod = await import("./pbr-template-ext.js");
        _createPbrTemplateExt = extMod.createPbrTemplateExt;
    }

    let _createThinInstanceFragment: ((hasColor: boolean) => ShaderFragment) | null = null;
    let _syncThinInstanceBuffers:
        | ((engine: EngineContextInternal, ti: ThinInstanceData, pass: GPURenderPassEncoder | GPURenderBundleEncoder, slot: number, hasColor: boolean) => number)
        | null = null;
    if (hasSomeThinInstances) {
        const mod = await import("../../shader/fragments/thin-instance-fragment.js");
        _createThinInstanceFragment = mod.createThinInstanceFragment;
        const gpuMod = await import("../../mesh/thin-instance-gpu.js");
        _syncThinInstanceBuffers = gpuMod.syncThinInstanceBuffers;
    }

    // ACES tonemap WGSL is dynamically imported only when requested (keeps standard-tonemap bundles lean).
    // Must be loaded before the composer is created so deps are fully resolved.
    let _acesHelpers = "";
    let _acesTonemapCall = "";
    const hasTonemap = scene.imageProcessing.toneMappingEnabled;
    if (hasTonemap && scene.imageProcessing.toneMappingType === "aces") {
        const acesMod = await import("./pbr-aces-wgsl.js");
        _acesHelpers = acesMod.ACES_HELPERS_WGSL;
        _acesTonemapCall = acesMod.ACES_TONEMAP_CALL_WGSL;
    }

    const composePbr = createPbrComposer({
        _singleLightWGSL,
        _getSingleLightBlock,
        _multiLightWGSL,
        _multiLightLoop,
        _acesHelpers,
        _acesTonemapCall,
        _createPbrTemplateExt,
        _anisoExt,
        _iblSkyboxCalc,
        _createPbrShadowFragment,
        _shadowLights: shadowLights,
        _createThinInstanceFragment,
    });

    const sceneFeatures = (hasEnv ? PBR_HAS_ENV : 0) | (hasTonemap ? PBR_HAS_TONEMAP : 0);
    // Shadow bind group cache — within one scene build, all receiving meshes share the
    // same shadowLights array, so a BG keyed by shadowBGL alone is correct.
    const shadowBGCache = new Map<GPUBindGroupLayout, GPUBindGroup>();
    const syncThinInstanceBuffers = _syncThinInstanceBuffers;

    // Closure used both for the initial per-mesh build below AND for later
    // material-swap / per-pass-override rebuilds (set on pbrGroupBuilder._rebuildSingle).
    // Captures the per-scene context — no separate WeakMap needed.
    const rebuildSingle = (s: SceneContext, mesh: Mesh, materialOverride?: Material): Renderable => {
        const materialInput = (materialOverride ?? mesh.material) as PbrMaterialProps;
        const mat = materialInput;
        const renderFeatures = (mat._renderFeatures ??= _computePbrMaterialFeatures(mat)) as MaterialRenderFeatures;
        const isOverride = materialOverride != null;
        const mi = mesh as MeshInternal;

        const lr = writeMeshLightSelection(mesh, s.lights);
        const lightCount = lr > 0 ? 1 : -lr;
        const features = renderFeatures.features;
        const features2 = renderFeatures.features2 ?? 0;
        const shadowOutput = (features2 & (PBR2_NO_COLOR_OUTPUT | PBR2_ESM_SHADOW_OUTPUT)) !== 0;
        const receiveShadows = !shadowOutput && mesh.receiveShadows && hasSomeShadows;
        const lightMode: PbrLightMode = lightCount === 0 ? 0 : lightCount === 1 && !receiveShadows ? 1 : 2;
        const singleLightType = lightMode === 1 ? getPackedSingleLightType(s.lights, lr - 1) : "";
        const meshFeatures = _computeMeshFeatures(mesh, receiveShadows);
        const esmShadowDepthCode = (features2 & PBR2_ESM_SHADOW_OUTPUT) !== 0 ? (mat as PbrMaterialProps & { readonly _esmShadowDepthCode: string })._esmShadowDepthCode : "";

        const composed = composePbr(features, features2, meshFeatures, sceneFeatures, lightMode, singleLightType, esmShadowDepthCode);
        const bindings = getOrCreatePbrBindings(engine, features, features2, meshFeatures, sceneFeatures, composed, `${lightMode}:${singleLightType}`);

        // Mesh UBO (world matrix at offset 0; spec.totalBytes covers any extra fields).
        const meshUboData = new Float32Array(composed._meshUboSpec._totalBytes / 4);
        meshUboData.set(mesh.worldMatrix, 0);
        writeMeshLightSelection(mesh, s.lights, meshUboData);
        const meshUBO = createUniformBuffer(engine, meshUboData);

        // Material UBO.
        const materialSpec = composed._materialUboSpec!;
        const matInitData = new Float32Array(materialSpec._totalBytes / 4);
        writeMaterialData(matInitData, mat, materialSpec);
        const materialUBO = createUniformBuffer(engine, matInitData);

        const needsTaskRefraction = !!mat.transmissive && (features2 & PBR2_HAS_REFRACTION) !== 0;
        const materialBindGroupStatic = needsTaskRefraction ? null : createPbrMeshBindGroup(engine, bindings, composed, meshUBO, materialUBO, mat, envTextures ?? null, mesh);

        // Shadow bind group (group 2) — shared across receiving meshes via shadowBGCache.
        let shadowBindGroup: GPUBindGroup | null = null;
        const meshShadowLights = receiveShadows ? shadowLights : [];
        if (meshShadowLights.length > 0 && bindings._shadowBGL) {
            let cached = shadowBGCache.get(bindings._shadowBGL);
            if (!cached) {
                const entries: GPUBindGroupEntry[] = [];
                let b = 0;
                for (const sl of meshShadowLights) {
                    const sg = sl.gen;
                    entries.push({ binding: b++, resource: sg._depthTexture.createView() });
                    entries.push({ binding: b++, resource: sg._depthSampler });
                    entries.push({ binding: b++, resource: { buffer: sg._shadowUBO } });
                }
                cached = device.createBindGroup({ layout: bindings._shadowBGL, entries });
                shadowBGCache.set(bindings._shadowBGL, cached);
            }
            shadowBindGroup = cached;
        }

        const boundTextures = collectPbrBoundTextures(mat);
        for (const t of boundTextures) {
            acquireTexture(t);
        }
        (s as SceneContextInternal)._meshDisposables.set(mesh, [
            () => {
                meshUBO.destroy();
                materialUBO.destroy();
            },
            () => {
                for (const t of boundTextures) {
                    releaseTexture(t);
                }
            },
        ]);

        const isTransparent = (features2 & (PBR2_NO_COLOR_OUTPUT | PBR2_ESM_SHADOW_OUTPUT)) === 0 && (features & PBR_HAS_ALPHA_BLEND) !== 0;
        const order = mesh.renderOrder ?? (isTransparent || needsTaskRefraction ? 150 : 100);

        const hasNormalMap = (features & PBR_HAS_NORMAL_MAP) !== 0;
        const hasUV2 = (features2 & PBR2_HAS_UV2) !== 0 && (meshFeatures & MSH_HAS_UV2) !== 0;
        const hasVertexColor = (meshFeatures & MSH_HAS_VERTEX_COLOR) !== 0;
        const hasTI = (meshFeatures & MSH_HAS_THIN_INSTANCES) !== 0;
        const hasTIColor = (meshFeatures & MSH_HAS_INSTANCE_COLOR) !== 0;

        let _lastWorldVersion = -1;
        let _lastLightsCount = s.lights.length;
        const sortCenter = isTransparent || needsTaskRefraction ? ([mesh.worldMatrix[12]!, mesh.worldMatrix[13]!, mesh.worldMatrix[14]!] as [number, number, number]) : null;
        const update = (): void => {
            if (mesh.worldMatrixVersion !== _lastWorldVersion || s.lights.length !== _lastLightsCount) {
                if (sortCenter) {
                    sortCenter[0] = mesh.worldMatrix[12]!;
                    sortCenter[1] = mesh.worldMatrix[13]!;
                    sortCenter[2] = mesh.worldMatrix[14]!;
                }
                meshUboData.set(mesh.worldMatrix, 0);
                writeMeshLightSelection(mesh, s.lights, meshUboData);
                device.queue.writeBuffer(meshUBO, 0, meshUboData as Float32Array<ArrayBuffer>);
                _lastWorldVersion = mesh.worldMatrixVersion;
                _lastLightsCount = s.lights.length;
            }
            const uboVersion = mat._uboVersion;
            if (uboVersion !== _lastUboVersion) {
                _lastUboVersion = uboVersion;
                let data = materialScratch.get(materialSpec._totalBytes);
                if (!data) {
                    data = new Float32Array(materialSpec._totalBytes / 4);
                    materialScratch.set(materialSpec._totalBytes, data);
                } else {
                    data.fill(0);
                }
                writeMaterialData(data, mat, materialSpec);
                device.queue.writeBuffer(materialUBO, 0, data.buffer, 0, data.byteLength);
            }
        };

        const drawWith = (pass: GPURenderPassEncoder | GPURenderBundleEncoder, materialBindGroup: GPUBindGroup): number => {
            if (!isOverride && mesh.material !== materialInput) {
                return 0;
            }
            const gpu = mi._gpu;
            pass.setBindGroup(1, materialBindGroup);
            if (shadowBindGroup) {
                pass.setBindGroup(2, shadowBindGroup);
            }
            let slot = 0;
            pass.setVertexBuffer(slot++, gpu.positionBuffer);
            pass.setVertexBuffer(slot++, gpu.normalBuffer);
            if (hasNormalMap && gpu.tangentBuffer) {
                pass.setVertexBuffer(slot++, gpu.tangentBuffer);
            }
            pass.setVertexBuffer(slot++, gpu.uvBuffer);
            if (hasUV2 && gpu.uv2Buffer) {
                pass.setVertexBuffer(slot++, gpu.uv2Buffer);
            }
            if (hasVertexColor && gpu.colorBuffer) {
                pass.setVertexBuffer(slot++, gpu.colorBuffer);
            }
            if (mesh.skeleton) {
                pass.setVertexBuffer(slot++, mesh.skeleton.jointsBuffer);
                pass.setVertexBuffer(slot++, mesh.skeleton.weightsBuffer);
                if (mesh.skeleton.joints1Buffer && mesh.skeleton.weights1Buffer) {
                    pass.setVertexBuffer(slot++, mesh.skeleton.joints1Buffer);
                    pass.setVertexBuffer(slot++, mesh.skeleton.weights1Buffer);
                }
            }

            const ti = hasTI ? mesh.thinInstances : null;
            if (ti && syncThinInstanceBuffers) {
                slot = syncThinInstanceBuffers(engine, ti, pass, slot, hasTIColor);
            }

            pass.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
            if (ti && ti.count > 0) {
                pass.drawIndexed(gpu.indexCount, ti.count);
            } else {
                pass.drawIndexed(gpu.indexCount);
            }
            return 1;
        };
        const draw = (pass: GPURenderPassEncoder | GPURenderBundleEncoder): number => drawWith(pass, materialBindGroupStatic!);

        const r: Renderable = {
            order,
            isTransparent,
            _transmissive: needsTaskRefraction,
            mesh,
            bind(eng, sig) {
                const pipeline = getOrCreatePbrPipeline(eng as EngineContextInternal, sig, bindings);
                const materialBindGroup = needsTaskRefraction
                    ? createPbrMeshBindGroup(engine, bindings, composed, meshUBO, materialUBO, mat, envTextures ?? null, mesh, sig._transmissionTexture)
                    : materialBindGroupStatic!;
                return {
                    renderable: r,
                    pipeline,
                    update,
                    draw: needsTaskRefraction ? (pass) => drawWith(pass, materialBindGroup) : draw,
                };
            },
        };
        if (sortCenter) {
            r._worldCenter = sortCenter;
        }
        let _lastUboVersion = mat._uboVersion;
        return r;
    };

    const renderables = meshes.map((m) => rebuildSingle(scene, m));

    (scene as SceneContextInternal)._disposables.push(
        () => clearPbrPipelineCache(),
        () => clearSamplerCache(engine)
    );

    return { renderables, rebuildSingle };
}

function toSingleLightType(type: string): SingleLightType {
    return type === "hemispheric" || type === "directional" || type === "spot" ? type : "point";
}

function getPackedSingleLightType(lights: SceneContext["lights"], packedIndex: number): SingleLightType {
    let packed = 0;
    for (const light of lights) {
        if (!(light as LightBaseInternal)._writeLightUbo) {
            continue;
        }
        if (packed === packedIndex) {
            return toSingleLightType(light.lightType);
        }
        packed++;
    }
    return "point";
}

async function importSingleLightWgsl(type: SingleLightType): Promise<SingleLightWgslModule> {
    if (type === "hemispheric") {
        return import("./fragments/singlelight-hemispheric-wgsl.js");
    }
    if (type === "directional") {
        return import("./fragments/singlelight-directional-wgsl.js");
    }
    if (type === "spot") {
        return import("./fragments/singlelight-spot-wgsl.js");
    }
    return import("./fragments/singlelight-point-wgsl.js");
}

/** Write material properties into a pre-allocated Float32Array.
 *  Core fields only; per-extension slices are contributed by registered
 *  writers. */
function writeMaterialData(data: Float32Array, material: PbrMaterialProps, spec: import("../../shader/fragment-types.js").UboSpec): void {
    data[0] = material.environmentIntensity ?? 1.0;
    data[1] = material.directIntensity ?? 1.0;
    data[2] = material.reflectance ?? 0.04;
    data[3] = material.alpha ?? 1.0;
    if (spec._offsets.has("metallicFactor")) {
        const off = spec._offsets.get("metallicFactor")! / 4;
        data[off] = material.metallicFactor ?? 1.0;
        data[off + 1] = material.roughnessFactor ?? 1.0;
        data[off + 2] = material.normalTextureScale ?? 1.0;
        data[off + 3] = material.usePhysicalLightFalloff === false ? 0 : 1;
    }
    for (const ext of _getPbrExts().values()) {
        if (ext.writeUbo) {
            ext.writeUbo(data, material, spec._offsets);
        }
    }
}
