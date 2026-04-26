/** PBR mesh renderable — builds Renderable(s) from glTF PBR meshes + environment.
 *
 *  Uses the ShaderFragment composer: each mesh gets a ComposedShader from its
 *  feature set, which provides WGSL source, BGL descriptors, vertex layouts,
 *  and UBO specs. Scene UBO updated once per frame. */

import type { EngineContextInternal } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { SceneContextInternal } from "../../scene/scene.js";
import { getOrBuildMeshRenderable } from "../../scene/scene.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { MeshInternal } from "../../mesh/mesh.js";
import type { LightBaseInternal } from "../../light/types.js";
import type { PbrMaterialProps } from "./pbr-material.js";
import { collectPbrBoundTextures } from "./pbr-material.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";

import type { Mat4 } from "../../math/types.js";
import type { Renderable } from "../../render/renderable.js";
import type { ShaderFragment, ComposedShader } from "../../shader/fragment-types.js";
import type { PbrLightConfig } from "./pbr-template.js";
import { composeShader } from "../../shader/shader-composer.js";
import { createPbrTemplate } from "./pbr-template.js";
import { acquireTexture, releaseTexture, clearSamplerCache } from "../../resource/gpu-pool.js";
import { createUniformBuffer } from "../../resource/gpu-buffers.js";
import {
    getOrCreatePbrBindings,
    getOrCreatePbrPipeline,
    createPbrMeshBindGroup,
    releasePbrBindings,
    clearPbrPipelineCache,
    PBR_HAS_NORMAL_MAP,
    PBR_HAS_ALPHA_BLEND,
    PBR2_HAS_REFRACTION,
    PBR_HAS_METALLIC_REFLECTANCE_MAP,
    PBR_HAS_REFLECTANCE_MAP,
    PBR_HAS_SPECULAR_AA,
    PBR_HAS_EMISSIVE_COLOR,
    PBR_HAS_GAMMA_ALBEDO,
    PBR_HAS_RECEIVE_SHADOWS,
} from "./pbr-pipeline.js";
import { PBR_HAS_THIN_INSTANCES, PBR_HAS_INSTANCE_COLOR } from "./pbr-pipeline.js";
import { _getLightExtension } from "../../light/extension-registry.js";
import {
    _getPbrMaterialUboWriters,
    _registerPbrExt,
    _getPbrExts,
    _registerPbrMaterialUboWriter,
    PBR_HAS_EMISSIVE,
    PBR_HAS_ENV,
    PBR_HAS_TONEMAP,
    PBR_HAS_MORPH_TARGETS,
    PBR_HAS_SPEC_GLOSS,
    PBR_HAS_DOUBLE_SIDED,
    PBR_HAS_COTANGENT_NORMAL,
    PBR_HAS_OCCLUSION,
    PBR_HAS_ANISOTROPY,
    PBR_HAS_SKYBOX,
} from "./pbr-flags.js";
import { computeMeshPbrFeatures } from "./pbr-mesh-features.js";
import type { ShadowGenerator } from "../../shadow/shadow-generator.js";
import type { ThinInstanceData } from "../../mesh/thin-instance.js";
import type { PbrShadowLightSlot } from "./fragments/pbr-shadow-fragment.js";

/** Per-scene PBR build context — populated by `buildPbrRenderables`, read by
 *  `buildSinglePbrRenderable` for material-swap rebuilds. Module-private so it
 *  doesn't pollute the public SceneContext type. */
interface PbrBuildCtx {
    composePbr: (features: number, features2?: number) => ComposedShader;
    /** Multi-light UBO (group 1 binding) — undefined for single-light scenes. */
    lightsUBO: GPUBuffer | undefined;
    shadowLights: { lightIndex: number; shadowType: "esm" | "pcf"; gen: ShadowGenerator }[];
    shadowBGCache: Map<GPUBindGroupLayout, GPUBindGroup>;
    materialScratch: Map<number, Float32Array>;
    syncThinInstanceBuffers:
        | ((engine: EngineContextInternal, ti: ThinInstanceData, pass: GPURenderPassEncoder | GPURenderBundleEncoder, slot: number, hasColor: boolean) => number)
        | null;
    featureCtx: import("./pbr-mesh-features.js").PbrFeatureCtx;
}
const _pbrCtxByScene = new WeakMap<SceneContext, PbrBuildCtx>();

/** Convert a LightExtension to PbrLightConfig for the template. */
function lightExtToConfig(ext: { emitLightVector(): string; emitDirectDiffuse(): string; emitGeometricAA(): string }): PbrLightConfig {
    return {
        lightVectorCode: ext.emitLightVector(),
        directDiffuseCode: ext.emitDirectDiffuse(),
        geometricAACode: ext.emitGeometricAA(),
    };
}

/** Build PBR Renderable(s) + per-frame update callback from PBR meshes. */
export async function buildPbrRenderables(
    scene: SceneContext,
    meshes: Mesh[],
    envTextures: EnvironmentTextures | undefined
): Promise<{ renderables: Renderable[]; update: () => void }> {
    const engine = scene.engine as EngineContextInternal;
    // Per-size scratch buffers for material UBO re-writes (zero allocation per frame)
    const materialScratch = new Map<number, Float32Array>();
    const hasEnv = !!envTextures;
    const shadowLights: { lightIndex: number; shadowType: "esm" | "pcf"; gen: ShadowGenerator }[] = [];
    for (let i = 0; i < scene.lights.length; i++) {
        const sg = scene.lights[i]!.shadowGenerator;
        if (sg) {
            shadowLights.push({ lightIndex: i, shadowType: sg.shadowType, gen: sg });
        }
    }
    const hasSomeShadows = shadowLights.length > 0;
    const hasMultiLight = scene.lights.length > 0 && hasSomeShadows;

    // Register light extensions for all lights
    for (const light of scene.lights) {
        const li = light as LightBaseInternal;
        if (li._registerExtension) {
            await li._registerExtension();
        }
    }

    // ── Dynamically import fragment creators based on scene capabilities ──

    // Single O(N) pass over meshes detecting every per-mesh / per-material feature flag used below.
    // Replaces ~11 sequential meshes.some() loops (was O(11N)). Short-circuits once every flag is true.
    let hasSkybox = false;
    let hasMetallicReflectance = false;
    let hasClearcoat = false;
    let hasSheen = false;
    let hasAnyAnisotropy = false;
    let hasAnySubsurface = false;
    let hasRefraction = false;
    let needsEmissiveColor = false;
    let hasSomeSkeletons = false;
    let hasSomeMorphs = false;
    let hasSomeThinInstances = false;
    for (let i = 0; i < meshes.length; i++) {
        const m = meshes[i]!;
        const mat = m.material as PbrMaterialProps;
        if (!hasSkybox && !!mat.skyboxMode) {
            hasSkybox = true;
        }
        if (!hasMetallicReflectance && (!!mat.metallicReflectanceTexture || !!mat.reflectanceTexture)) {
            hasMetallicReflectance = true;
        }
        if (!hasClearcoat && !!mat.clearCoat?.isEnabled) {
            hasClearcoat = true;
        }
        if (!hasSheen && !!mat.sheen?.isEnabled) {
            hasSheen = true;
        }
        if (!hasAnyAnisotropy && !!mat.anisotropy?.isEnabled) {
            hasAnyAnisotropy = true;
        }
        if (!hasAnySubsurface && !!mat.subsurface?.translucency) {
            hasAnySubsurface = true;
        }
        if (!hasRefraction && (mat.subsurface?.refraction?.intensity ?? 0) > 0) {
            hasRefraction = true;
        }
        if (!needsEmissiveColor && !!mat.emissiveColor) {
            needsEmissiveColor = true;
        }
        if (!hasSomeSkeletons && !!m.skeleton) {
            hasSomeSkeletons = true;
        }
        if (!hasSomeMorphs && !!m.morphTargets) {
            hasSomeMorphs = true;
        }
        if (!hasSomeThinInstances && !!m.thinInstances) {
            hasSomeThinInstances = true;
        }
        if (
            hasSkybox &&
            hasMetallicReflectance &&
            hasClearcoat &&
            hasSheen &&
            hasAnyAnisotropy &&
            hasAnySubsurface &&
            hasRefraction &&
            needsEmissiveColor &&
            hasSomeSkeletons &&
            hasSomeMorphs &&
            hasSomeThinInstances
        ) {
            break;
        }
    }

    // IBL fragment
    let _iblSkyboxCalc = "";
    if (hasEnv) {
        const mod = await import("./fragments/ibl-fragment.js");
        _registerPbrExt(mod.iblExt);
        // Skybox-mode WGSL is only loaded when at least one mesh in the scene needs it.
        if (hasSkybox) {
            const sky = await import("./fragments/ibl-skybox-wgsl.js");
            _iblSkyboxCalc = sky.IBL_SKYBOX_CALCULATION;
        }
    }

    // Shadow fragment + multi-light helpers (dynamic to keep non-shadow PBR bundles lean)
    let _createPbrShadowFragment: ((slots: PbrShadowLightSlot[]) => ShaderFragment) | null = null;
    let _multiLightWGSL = "";
    let _multiLightLoop = "";
    let _writeLightsUBO: ((engine: EngineContextInternal, lights: readonly import("../../light/types.js").LightBase[]) => GPUBuffer) | undefined;
    let _refreshLightsUBO:
        | ((engine: EngineContextInternal, buffer: GPUBuffer, lights: readonly import("../../light/types.js").LightBase[], scratch: Float32Array) => void)
        | undefined;
    let _LIGHTS_UBO_SIZE = 0;
    if (hasSomeShadows) {
        const [shadowMod, lightsUboMod, wgslMod] = await Promise.all([
            import("./fragments/pbr-shadow-fragment.js"),
            import("../../render/lights-ubo.js"),
            import("./fragments/multilight-wgsl.js"),
        ]);
        _createPbrShadowFragment = shadowMod.createPbrShadowFragment;
        _writeLightsUBO = lightsUboMod.writeLightsUBO;
        _refreshLightsUBO = lightsUboMod.refreshLightsUBO;
        _LIGHTS_UBO_SIZE = lightsUboMod.LIGHTS_UBO_SIZE;
        _multiLightWGSL = wgslMod.MULTI_LIGHT_STRUCTS + wgslMod.COMPUTE_PBR_LIGHT;
        _multiLightLoop = wgslMod.MULTI_LIGHT_LOOP;
    }

    // Per-mesh fragment creators (imported if any mesh needs them — flags populated by single pass above)
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

    let _anisoExt: typeof import("./fragments/anisotropy-fragment.js") | null = null;
    if (hasAnyAnisotropy) {
        _anisoExt = await import("./fragments/anisotropy-fragment.js");
        const anisoMod = _anisoExt;
        _registerPbrMaterialUboWriter("anisotropy", (d, m, o) => anisoMod.writeAnisotropyUBO(d, m as PbrMaterialProps, o));
    }

    if (hasAnySubsurface) {
        const mod = await import("./fragments/subsurface-fragment.js");
        _registerPbrExt(mod.subsurfaceExt);
    }

    if (hasRefraction) {
        const mod = await import("./fragments/refraction-fragment.js");
        _registerPbrExt(mod.refractionExt);
    }

    if (needsEmissiveColor) {
        const mod = await import("./fragments/emissive-fragment.js");
        _registerPbrExt(mod.emissiveColorExt);
    }

    if (hasSomeSkeletons) {
        const mod = await import("./fragments/skeleton-fragment.js");
        _registerPbrExt(mod.skeletonExt);
    }

    if (hasSomeMorphs) {
        const mod = await import("./fragments/morph-fragment.js");
        _registerPbrExt(mod.morphExt);
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

    // ── Build light config from registered extension ──
    const lightExt = _getLightExtension();
    const lightConfig: PbrLightConfig | null = lightExt ? lightExtToConfig(lightExt) : null;

    // ── Compose shaders per unique feature set (cached) ──
    const composedCache = new Map<string, ComposedShader>();

    function composePbr(features: number, features2: number = 0): ComposedShader {
        const ckey = `${features}:${features2}`;
        let c = composedCache.get(ckey);
        if (c) {
            return c;
        }

        const f = features;
        const has = (bit: number) => (f & bit) !== 0;
        const hasNormal = has(PBR_HAS_NORMAL_MAP);
        const hasCotangent = has(PBR_HAS_COTANGENT_NORMAL);
        const hasReflExt = has(PBR_HAS_METALLIC_REFLECTANCE_MAP | PBR_HAS_REFLECTANCE_MAP);
        const hasIbl = has(PBR_HAS_ENV);
        const hasMorph = has(PBR_HAS_MORPH_TARGETS);
        const hasShadow = has(PBR_HAS_RECEIVE_SHADOWS);
        const hasAniso = has(PBR_HAS_ANISOTROPY);
        const hasEmCol = has(PBR_HAS_EMISSIVE_COLOR);
        const hasEmTex = has(PBR_HAS_EMISSIVE);
        const hasTI = has(PBR_HAS_THIN_INSTANCES);

        const template = createPbrTemplate({
            light: hasMultiLight ? null : lightConfig,
            hasMultiLight,
            multiLightWGSL: _multiLightWGSL,
            multiLightLoop: _multiLightLoop,
            normalMode: hasNormal ? "tangent" : hasCotangent ? "cotangent" : "none",
            hasEmissiveTexture: hasEmTex,
            hasSpecGloss: has(PBR_HAS_SPEC_GLOSS),
            hasDoubleSided: has(PBR_HAS_DOUBLE_SIDED),
            hasTonemap: has(PBR_HAS_TONEMAP),
            acesHelpers: _acesHelpers,
            acesTonemapCall: _acesTonemapCall,
            hasAlphaBlend: has(PBR_HAS_ALPHA_BLEND),
            hasSpecularAA: has(PBR_HAS_SPECULAR_AA),
            hasGammaAlbedo: has(PBR_HAS_GAMMA_ALBEDO),
            hasMorph,
            hasOcclusion: has(PBR_HAS_OCCLUSION) && !hasReflExt,
            hasEmissiveColor: hasEmCol,
            hasReflectanceExt: hasReflExt,
            hasIbl,
            hasAnisotropy: hasAniso,
            anisoBrdfFunctions: hasAniso && _anisoExt ? _anisoExt.ANISO_BRDF_FUNCTIONS : "",
            anisoTBBlock: hasAniso && _anisoExt ? _anisoExt.makeAnisotropyTBBlock(hasNormal) : "",
            anisoDirectDG: hasAniso && _anisoExt ? _anisoExt.ANISO_DIRECT_DG : "",
        });

        const frags: ShaderFragment[] = [];
        const hasAnyNormal = hasNormal || hasCotangent;
        const hasSpecularAAbit = has(PBR_HAS_SPECULAR_AA);
        const fragCtx: import("./pbr-flags.js").PbrFragCtx = {
            features,
            features2,
            hasIbl,
            hasAnyNormal,
            hasSpecularAA: hasSpecularAAbit,
            anisoBentNormalCode: hasAniso && _anisoExt ? _anisoExt.ANISO_BENT_NORMAL : "",
            iblSkyboxCalc: has(PBR_HAS_SKYBOX) ? _iblSkyboxCalc : "",
        };
        // All registered exts contribute fragments via ext.frag().
        // Registration order defines iteration order; callers register in composer-matching order.
        for (const ext of _getPbrExts().values()) {
            if (ext.frag) {
                const fr = ext.frag(fragCtx);
                if (fr) {
                    frags.push(fr);
                }
            }
        }
        if (hasShadow && _createPbrShadowFragment) {
            const slots = shadowLights.map((sl) => ({ lightIndex: sl.lightIndex, shadowType: sl.shadowType }));
            frags.push(_createPbrShadowFragment(slots));
        }
        if (hasTI && _createThinInstanceFragment) {
            frags.push(_createThinInstanceFragment(has(PBR_HAS_INSTANCE_COLOR)));
        }

        c = composeShader(template, frags);
        composedCache.set(ckey, c);
        return c;
    }

    let lightsUBOBuffer: GPUBuffer | undefined;
    let lightsUBOScratch: Float32Array | undefined;
    if (hasMultiLight && _writeLightsUBO) {
        lightsUBOBuffer = _writeLightsUBO(engine, scene.lights);
        lightsUBOScratch = new Float32Array(_LIGHTS_UBO_SIZE / 4);
    }

    const hasTonemap = scene.imageProcessing.toneMappingEnabled;
    // ACES tonemap WGSL is dynamically imported only when requested (keeps standard-tonemap bundles lean).
    let _acesHelpers = "";
    let _acesTonemapCall = "";
    if (hasTonemap && scene.imageProcessing.toneMappingType === "aces") {
        const acesMod = await import("./pbr-aces-wgsl.js");
        _acesHelpers = acesMod.ACES_HELPERS_WGSL;
        _acesTonemapCall = acesMod.ACES_TONEMAP_CALL_WGSL;
    }

    const featureCtx: import("./pbr-mesh-features.js").PbrFeatureCtx = { hasEnv, hasTonemap, hasSomeShadows };
    // Shadow bind group cache — within one scene build, all receiving meshes share the
    // same shadowLights array, so a BG keyed by shadowBGL alone is correct. Cached on
    // the per-scene PbrBuildCtx so material-swap rebuilds reuse already-created BGs.
    const shadowBGCache = new Map<GPUBindGroupLayout, GPUBindGroup>();

    _pbrCtxByScene.set(scene, {
        composePbr,
        lightsUBO: lightsUBOBuffer,
        shadowLights,
        shadowBGCache,
        materialScratch,
        syncThinInstanceBuffers: _syncThinInstanceBuffers,
        featureCtx,
    });

    const renderables: Renderable[] = meshes.map((mesh) => getOrBuildMeshRenderable(scene, mesh, mesh.material!, buildSinglePbrRenderable));

    // The pass's writePassSceneUBO writes the unified scene UBO every frame —
    // the only remaining per-frame work for PBR is refreshing the multi-light UBO.
    const update = (): void => {
        if (lightsUBOBuffer && lightsUBOScratch && _refreshLightsUBO) {
            _refreshLightsUBO(engine, lightsUBOBuffer, scene.lights, lightsUBOScratch);
        }
    };

    (scene as SceneContextInternal)._disposables.push(
        () => clearPbrPipelineCache(),
        () => clearSamplerCache(engine),
        () => _pbrCtxByScene.delete(scene)
    );

    return { renderables, update };
}

const _UV_IDENTITY = new Float32Array([1, 1, 0, 0]);
function createMeshUBO(engine: EngineContextInternal, world: Mat4, composed: ComposedShader, material: PbrMaterialProps): GPUBuffer {
    const data = new Float32Array(composed.meshUboSpec.totalBytes / 4);
    data.set(world, 0);
    data.set(material.uvTransformST ?? _UV_IDENTITY, 16);
    return createUniformBuffer(engine, data);
}

/** Write material properties into a pre-allocated Float32Array.
 *  Core fields only; per-extension slices are contributed by registered
 *  writers — each PBR fragment module's writer is registered by
 *  buildPbrRenderables right after the dynamic import, avoiding
 *  module-level side effects. */
function writeMaterialData(data: Float32Array, material: PbrMaterialProps, spec: import("../../shader/fragment-types.js").UboSpec): void {
    data[0] = material.environmentIntensity ?? 1.0;
    data[1] = material.directIntensity ?? 1.0;
    data[2] = material.reflectance ?? 0.04;
    data[3] = material.alpha ?? 1.0;
    if (spec.offsets.has("metallicFactor")) {
        const off = spec.offsets.get("metallicFactor")! / 4;
        data[off] = material.metallicFactor ?? 1.0;
        data[off + 1] = material.roughnessFactor ?? 1.0;
    }

    for (const write of _getPbrMaterialUboWriters().values()) {
        write(data, material, spec.offsets);
    }

    // Unified PBR extensions contribute their material-UBO slice.
    for (const ext of _getPbrExts().values()) {
        if (ext.writeUbo) {
            ext.writeUbo(data, material, spec.offsets);
        }
    }
}

/** Create a material UBO from the ComposedShader's materialUboSpec. */
function createMaterialUBO(engine: EngineContextInternal, material: PbrMaterialProps, composed: ComposedShader): GPUBuffer {
    const spec = composed.materialUboSpec!;
    const data = new Float32Array(spec.totalBytes / 4);
    writeMaterialData(data, material, spec);
    return createUniformBuffer(engine, data);
}

/** Build a single PBR Renderable for one mesh — canonical per-mesh path used
 *  by both the batch builder and the material-swap rebuild. Requires the scene
 *  to have been initialised by `buildPbrRenderables` (sets the per-scene
 *  PbrBuildCtx). When `materialOverride` is provided, that material is used
 *  instead of `mesh.material` (e.g. for per-pass material). */
export function buildSinglePbrRenderable(scene: SceneContext, mesh: Mesh, materialOverride?: unknown): Renderable {
    const engine = scene.engine as EngineContextInternal;
    const device = engine.device;
    const sceneInt = scene as SceneContextInternal;
    const mat = (materialOverride ?? mesh.material) as PbrMaterialProps;
    const envTextures = sceneInt._envTextures;
    const pbrCtx = _pbrCtxByScene.get(scene)!;
    const { composePbr, lightsUBO, shadowLights, shadowBGCache, materialScratch, syncThinInstanceBuffers, featureCtx } = pbrCtx;

    const { features, features2 } = computeMeshPbrFeatures(mesh, scene, featureCtx, mat);

    const composed = composePbr(features, features2);
    const bindings = getOrCreatePbrBindings(engine, features, features2, composed);
    const meshUBO = createMeshUBO(engine, mesh.worldMatrix, composed, mat);
    const materialUBO = createMaterialUBO(engine, mat, composed);
    const materialBindGroup = createPbrMeshBindGroup(engine, bindings, composed, meshUBO, materialUBO, mat, envTextures ?? null, mesh, lightsUBO);

    // Shadow bind group (group 2) — shared across receiving meshes via shadowBGCache.
    let shadowBindGroup: GPUBindGroup | null = null;
    const meshShadowLights = mesh.receiveShadows ? shadowLights : [];
    if (meshShadowLights.length > 0 && bindings.shadowBGL) {
        let cached = shadowBGCache.get(bindings.shadowBGL);
        if (!cached) {
            const entries: GPUBindGroupEntry[] = [];
            let b = 0;
            for (const sl of meshShadowLights) {
                const sg = sl.gen;
                entries.push({ binding: b++, resource: sg.blurredTexture.createView() });
                entries.push({ binding: b++, resource: sg.blurredSampler });
                entries.push({ binding: b++, resource: { buffer: sg.shadowUBO } });
            }
            cached = device.createBindGroup({ layout: bindings.shadowBGL, entries });
            shadowBGCache.set(bindings.shadowBGL, cached);
        }
        shadowBindGroup = cached;
    }

    const boundTextures = collectPbrBoundTextures(mat);
    for (const t of boundTextures) {
        acquireTexture(t);
    }
    // Append disposables — multiple Renderables may share a mesh (per-pass overrides).
    let disposables = sceneInt._meshDisposables.get(mesh);
    if (!disposables) {
        disposables = [];
        sceneInt._meshDisposables.set(mesh, disposables);
    }
    disposables.push(
        () => {
            meshUBO.destroy();
            materialUBO.destroy();
        },
        () => {
            for (const t of boundTextures) {
                releaseTexture(t);
            }
        },
        () => releasePbrBindings(bindings)
    );

    const gpu = (mesh as MeshInternal)._gpu;
    const isTransparent = (features & PBR_HAS_ALPHA_BLEND) !== 0;
    const isTransmissive = !isTransparent && (features2 & PBR2_HAS_REFRACTION) !== 0;
    const order = mesh.renderOrder ?? (isTransparent ? 150 : isTransmissive ? 140 : 100);
    const hasNormalMap = (features & PBR_HAS_NORMAL_MAP) !== 0;
    const hasTI = (features & PBR_HAS_THIN_INSTANCES) !== 0;
    const hasTIColor = (features & PBR_HAS_INSTANCE_COLOR) !== 0;
    let _lastWorldVersion = mesh.worldMatrixVersion;
    // True only when this Renderable was built for the mesh's CURRENT material — used
    // to detect material swaps. Override Renderables (different material) always draw.
    const isMainMat = mat === mesh.material;
    const updateUBOs = (): void => {
        if (mesh.worldMatrixVersion !== _lastWorldVersion) {
            device.queue.writeBuffer(meshUBO, 0, mesh.worldMatrix as unknown as Float32Array<ArrayBuffer>);
            _lastWorldVersion = mesh.worldMatrixVersion;
        }
        const m = mat as any;
        if (!m._uboDirty) {
            return;
        }
        m._uboDirty = false;
        const spec = composed.materialUboSpec!;
        let data = materialScratch.get(spec.totalBytes);
        if (!data) {
            data = new Float32Array(spec.totalBytes / 4);
            materialScratch.set(spec.totalBytes, data);
        } else {
            data.fill(0);
        }
        writeMaterialData(data, m, spec);
        device.queue.writeBuffer(materialUBO, 0, data.buffer, 0, data.byteLength);
    };

    const r: Renderable = {
        order,
        isTransparent,
        isTransmissive,
        mesh,
        bind(eng, target) {
            const pipeline = getOrCreatePbrPipeline(eng as EngineContextInternal, bindings, target);
            return {
                renderable: r,
                pipeline,
                shadowBG: shadowBindGroup ?? undefined,
                updateUBOs,
                draw(pass) {
                    if (isMainMat && mesh.material !== mat) {
                        return 0;
                    }
                    pass.setBindGroup(1, materialBindGroup);
                    let slot = 0;
                    pass.setVertexBuffer(slot++, gpu.positionBuffer);
                    pass.setVertexBuffer(slot++, gpu.normalBuffer);
                    if (hasNormalMap && gpu.tangentBuffer) {
                        pass.setVertexBuffer(slot++, gpu.tangentBuffer);
                    }
                    pass.setVertexBuffer(slot++, gpu.uvBuffer);
                    if (mesh.skeleton) {
                        pass.setVertexBuffer(slot++, mesh.skeleton.jointsBuffer);
                        pass.setVertexBuffer(slot++, mesh.skeleton.weightsBuffer);
                        if (mesh.skeleton.joints1Buffer && mesh.skeleton.weights1Buffer) {
                            pass.setVertexBuffer(slot++, mesh.skeleton.joints1Buffer);
                            pass.setVertexBuffer(slot++, mesh.skeleton.weights1Buffer);
                        }
                    }
                    const ti = mesh.thinInstances;
                    if (hasTI && ti && syncThinInstanceBuffers) {
                        slot = syncThinInstanceBuffers(eng as EngineContextInternal, ti, pass, slot, hasTIColor);
                    }
                    pass.setIndexBuffer(gpu.indexBuffer, gpu.indexFormat);
                    if (hasTI && ti) {
                        pass.drawIndexed(gpu.indexCount, ti.count);
                    } else {
                        pass.drawIndexed(gpu.indexCount);
                    }
                    return 1;
                },
            };
        },
    };
    return r;
}
