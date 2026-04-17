/** PBR mesh renderable — builds Renderable(s) from glTF PBR meshes + environment.
 *
 *  Uses the ShaderFragment composer: each mesh gets a ComposedShader from its
 *  feature set, which provides WGSL source, BGL descriptors, vertex layouts,
 *  and UBO specs. Scene UBO updated once per frame. */

import type { EngineContext, EngineContextInternal } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { SceneContextInternal } from "../../scene/scene.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { MeshInternal } from "../../mesh/mesh.js";
import type { LightBaseInternal } from "../../light/types.js";
import type { PbrMaterialProps, SheenProps } from "./pbr-material.js";
import { collectPbrBoundTextures } from "./pbr-material.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";

import { getViewProjectionMatrix, getCameraPosition } from "../../camera/camera.js";
import type { Mat4 } from "../../math/types.js";
import type { Renderable, SceneUniformUpdater } from "../../render/renderable.js";
import type { ShaderFragment, ComposedShader } from "../../shader/fragment-types.js";
import type { PbrLightConfig } from "./pbr-template.js";
import type { UboField } from "../../shader/fragment-types.js";
import { composeShader } from "../../shader/shader-composer.js";
import { createPbrTemplate } from "./pbr-template.js";
import { computeUboLayout } from "../../shader/ubo-layout.js";
import { acquireTexture, releaseTexture, clearSamplerCache } from "../../resource/gpu-pool.js";
import { updateWorldMatrixUBOs } from "../../render/scene-helpers.js";
import {
    computePbrFeatures,
    createSceneBindGroupLayout,
    getOrCreatePbrPipeline,
    createPbrMeshBindGroup,
    releasePbrPipelineVariant,
    clearPbrPipelineCache,
    PBR_HAS_NORMAL_MAP,
    PBR_HAS_ALPHA_BLEND,
    PBR_HAS_METALLIC_REFLECTANCE_MAP,
    PBR_HAS_REFLECTANCE_MAP,
    PBR_HAS_SKELETON_8,
    PBR_HAS_SPECULAR_AA,
    PBR_HAS_EMISSIVE_COLOR,
    PBR_HAS_SHEEN_TEXTURE,
    PBR_HAS_RECEIVE_SHADOWS,
    PBR_HAS_GAMMA_ALBEDO,
    PBR2_CC_INT_MAP,
    PBR2_CC_ROUGH_MAP,
    PBR2_CC_NORMAL_MAP,
    PBR2_CC_F0_REMAP_OFF,
} from "./pbr-pipeline.js";
import { PBR_HAS_THIN_INSTANCES, PBR_HAS_INSTANCE_COLOR } from "./pbr-pipeline.js";
import {
    _getPbrLightExtension,
    _getSubsurfaceExt,
    getLightTypeFeatureBits,
    PBR_HAS_EMISSIVE,
    PBR_HAS_ENV,
    PBR_HAS_SKELETON,
    PBR_HAS_TONEMAP,
    PBR_HAS_MORPH_TARGETS,
    PBR_HAS_SPEC_GLOSS,
    PBR_HAS_DOUBLE_SIDED,
    PBR_HAS_COTANGENT_NORMAL,
    PBR_HAS_OCCLUSION,
    PBR_HAS_CLEARCOAT,
    PBR_HAS_SHEEN,
    PBR_HAS_USE_ALPHA_ONLY_MR,
    PBR_HAS_ANISOTROPY,
    PBR_HAS_SKYBOX,
} from "./pbr-flags.js";
import type { PbrPipelineVariant } from "./pbr-pipeline.js";
import type { ShadowGenerator } from "../../shadow/shadow-generator.js";
import type { ThinInstanceData } from "../../mesh/thin-instance.js";
import type { PbrShadowLightSlot } from "./fragments/pbr-shadow-fragment.js";

interface PbrDrawPacket {
    variant: PbrPipelineVariant;
    materialBindGroup: GPUBindGroup;
    shadowBindGroup: GPUBindGroup | null;
    shadowGens: ShadowGenerator[];
    mesh: Mesh;
    meshUBO: GPUBuffer;
    materialUBO: GPUBuffer;
    composed: ComposedShader;
    _lastWorldVersion: number;
    positionBuffer: GPUBuffer;
    normalBuffer: GPUBuffer;
    tangentBuffer: GPUBuffer | null;
    uvBuffer: GPUBuffer;
    jointsBuffer: GPUBuffer | null;
    weightsBuffer: GPUBuffer | null;
    joints1Buffer: GPUBuffer | null;
    weights1Buffer: GPUBuffer | null;
    indexBuffer: GPUBuffer;
    indexCount: number;
    indexFormat: GPUIndexFormat;
}

/** Convert a PbrLightExtension to PbrLightConfig for the template. */
function lightExtToConfig(ext: {
    pbrSceneUboFields: readonly { readonly name: string; readonly type: string }[];
    emitLightVector(): string;
    emitDirectDiffuse(): string;
    emitGeometricAA(): string;
}): PbrLightConfig {
    return {
        sceneUboFields: ext.pbrSceneUboFields as UboField[],
        lightVectorCode: ext.emitLightVector(),
        directDiffuseCode: ext.emitDirectDiffuse(),
        geometricAACode: ext.emitGeometricAA(),
    };
}

/** Build PBR Renderable(s) + a SceneUniformUpdater from PBR meshes. */
export async function buildPbrRenderables(
    scene: SceneContext,
    meshes: Mesh[],
    envTextures: EnvironmentTextures | undefined
): Promise<{ renderables: Renderable[]; updater: SceneUniformUpdater; _sceneBGL: GPUBindGroupLayout; _sceneBG: GPUBindGroup }> {
    const engine = scene.engine as EngineContextInternal;
    const device = engine.device;
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

    // Register PBR extensions for all lights
    for (const light of scene.lights) {
        const li = light as LightBaseInternal;
        if (li._registerPbr) {
            await li._registerPbr();
        }
    }

    // ── Dynamically import fragment creators based on scene capabilities ──

    // IBL fragment
    let _createIblFragment: ((hasNormalMap: boolean, anisoBentNormalCode?: string, skyboxCalculation?: string) => ShaderFragment) | null = null;
    let _iblSkyboxCalc = "";
    if (hasEnv) {
        const mod = await import("./fragments/ibl-fragment.js");
        _createIblFragment = mod.createIblFragment;
        // Skybox-mode WGSL is only loaded when at least one mesh in the scene needs it.
        if (meshes.some((m) => !!(m.material as PbrMaterialProps).skyboxMode)) {
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

    // Per-mesh fragment creators (imported if any mesh needs them)
    const hasMetallicReflectance = meshes.some((m) => {
        const mat = m.material as PbrMaterialProps;
        return !!mat.metallicReflectanceTexture || !!mat.reflectanceTexture;
    });
    let _createReflectanceFragment: ((hasMR: boolean, hasR: boolean, useAlpha: boolean) => ShaderFragment) | null = null;
    if (hasMetallicReflectance) {
        const mod = await import("./fragments/reflectance-fragment.js");
        _createReflectanceFragment = mod.createReflectanceFragment;
    }

    const hasClearcoat = meshes.some((m) => !!(m.material as PbrMaterialProps).clearCoat?.isEnabled);
    let _createClearcoatFragment:
        | ((hasIbl: boolean, hasReflectance: boolean, hasIntensityMap?: boolean, hasRoughnessMap?: boolean, hasNormalMap?: boolean, disableF0Remap?: boolean) => ShaderFragment)
        | null = null;
    if (hasClearcoat) {
        const mod = await import("./fragments/clearcoat-fragment.js");
        _createClearcoatFragment = mod.createClearcoatFragment;
    }

    const hasSheen = meshes.some((m) => !!(m.material as PbrMaterialProps).sheen?.isEnabled);
    let _createSheenFragment: ((hasTex: boolean, hasIbl: boolean) => ShaderFragment) | null = null;
    if (hasSheen) {
        const mod = await import("./fragments/sheen-fragment.js");
        _createSheenFragment = mod.createSheenFragment;
    }

    const hasAnyAnisotropy = meshes.some((m) => !!(m.material as PbrMaterialProps).anisotropy?.isEnabled);
    let _anisoExt: typeof import("./fragments/anisotropy-fragment.js") | null = null;
    if (hasAnyAnisotropy) {
        _anisoExt = await import("./fragments/anisotropy-fragment.js");
    }

    const hasAnySubsurface = meshes.some((m) => !!(m.material as PbrMaterialProps).subsurface?.translucency);
    if (hasAnySubsurface && !_getSubsurfaceExt()) {
        await import("./install-subsurface.js");
    }
    const _ssExt = _getSubsurfaceExt();

    const needsEmissiveColor = meshes.some((m) => !!(m.material as PbrMaterialProps).emissiveColor);
    let _createEmissiveColorFragment: ((hasTex: boolean) => ShaderFragment) | null = null;
    if (needsEmissiveColor) {
        const mod = await import("./fragments/emissive-fragment.js");
        _createEmissiveColorFragment = mod.createEmissiveColorFragment;
    }

    const hasSomeSkeletons = meshes.some((m) => !!m.skeleton);
    let _createSkeletonFragment: ((has8: boolean) => ShaderFragment) | null = null;
    if (hasSomeSkeletons) {
        const mod = await import("./fragments/skeleton-fragment.js");
        _createSkeletonFragment = mod.createSkeletonFragment;
    }

    const hasSomeMorphs = meshes.some((m) => !!m.morphTargets);
    let _createMorphFragment: (() => ShaderFragment) | null = null;
    if (hasSomeMorphs) {
        const mod = await import("./fragments/morph-fragment.js");
        _createMorphFragment = mod.createMorphFragment;
    }

    const hasSomeThinInstances = meshes.some((m) => !!m.thinInstances);
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
    const lightExt = _getPbrLightExtension();
    const lightConfig: PbrLightConfig | null = lightExt ? lightExtToConfig(lightExt) : null;
    const hasLight = !!lightExt;
    const lightTypeBits = getLightTypeFeatureBits();

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
        const hasSkel = has(PBR_HAS_SKELETON);
        const hasShadow = has(PBR_HAS_RECEIVE_SHADOWS);
        const hasCC = has(PBR_HAS_CLEARCOAT);
        const hasSh = has(PBR_HAS_SHEEN);
        const hasAniso = has(PBR_HAS_ANISOTROPY);
        const hasEmCol = has(PBR_HAS_EMISSIVE_COLOR);
        const hasEmTex = has(PBR_HAS_EMISSIVE);
        const hasTI = has(PBR_HAS_THIN_INSTANCES);
        const ccIntMap = (features2 & PBR2_CC_INT_MAP) !== 0;
        const ccRoughMap = (features2 & PBR2_CC_ROUGH_MAP) !== 0;
        const ccNormalMap = (features2 & PBR2_CC_NORMAL_MAP) !== 0;
        const ccF0RemapOff = (features2 & PBR2_CC_F0_REMAP_OFF) !== 0;

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
            hasSheenTexture: has(PBR_HAS_SHEEN_TEXTURE),
            hasEmissiveColor: hasEmCol,
            hasReflectanceExt: hasReflExt,
            hasIbl,
            hasClearcoat: hasCC,
            hasCcIntensityMap: ccIntMap,
            hasCcRoughnessMap: ccRoughMap,
            hasCcNormalMap: ccNormalMap,
            hasSheen: hasSh,
            hasAnisotropy: hasAniso,
            anisoBrdfFunctions: hasAniso && _anisoExt ? _anisoExt.ANISO_BRDF_FUNCTIONS : "",
            anisoTBBlock: hasAniso && _anisoExt ? _anisoExt.makeAnisotropyTBBlock(hasNormal) : "",
            anisoDirectDG: hasAniso && _anisoExt ? _anisoExt.ANISO_DIRECT_DG : "",
        });

        const frags: ShaderFragment[] = [];
        if (hasSkel && _createSkeletonFragment) {
            frags.push(_createSkeletonFragment(has(PBR_HAS_SKELETON_8)));
        }
        if (hasMorph && _createMorphFragment) {
            frags.push(_createMorphFragment());
        }
        if (hasReflExt && _createReflectanceFragment) {
            frags.push(_createReflectanceFragment(has(PBR_HAS_METALLIC_REFLECTANCE_MAP), has(PBR_HAS_REFLECTANCE_MAP), has(PBR_HAS_USE_ALPHA_ONLY_MR)));
        }
        if (hasEmCol && _createEmissiveColorFragment) {
            frags.push(_createEmissiveColorFragment(hasEmTex));
        }
        if (hasCC && _createClearcoatFragment) {
            frags.push(_createClearcoatFragment(hasIbl, hasReflExt, ccIntMap, ccRoughMap, ccNormalMap, ccF0RemapOff, has(PBR_HAS_SPECULAR_AA)));
        }
        if (hasSh && _createSheenFragment) {
            frags.push(_createSheenFragment(has(PBR_HAS_SHEEN_TEXTURE), hasIbl));
        }
        if (hasIbl && _createIblFragment) {
            const anisoBentCode = hasAniso && _anisoExt ? _anisoExt.ANISO_BENT_NORMAL : "";
            frags.push(_createIblFragment(hasNormal || hasCotangent, anisoBentCode, has(PBR_HAS_SKYBOX) ? _iblSkyboxCalc : ""));
        }
        if (_ssExt) {
            const ssFrag = _ssExt.frag(f, hasIbl);
            if (ssFrag) {
                frags.push(ssFrag as ShaderFragment);
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

    // Stash composePbr on the scene so single-rebuild can reuse it
    (scene as SceneContextInternal)._composePbr = composePbr;

    // ── Scene UBO layout ──
    // Compute the scene UBO spec from the template's baseSceneUboFields.
    // All PBR variants share the same scene UBO layout — the base template
    // includes all scene fields. Light fields are always present for layout
    // compatibility with background ground shader.
    const refTemplate = createPbrTemplate({
        light: hasMultiLight ? null : lightConfig,
        hasMultiLight,
        multiLightWGSL: _multiLightWGSL,
        multiLightLoop: _multiLightLoop,
        hasIbl: hasEnv,
    });
    const sceneUboSpec = computeUboLayout(refTemplate.baseSceneUboFields);
    const sceneUboSize = sceneUboSpec.totalBytes;
    const envRotYOffset = sceneUboSpec.offsets.get("envRotationY")! / 4;
    const shBaseOffset = hasEnv ? sceneUboSpec.offsets.get("vSphericalL00")! / 4 : 0;
    const exposureOffset = sceneUboSpec.offsets.get("exposureLinear")! / 4;
    // First light field offset — light extension writes relative to this
    const lightFieldName = lightConfig?.sceneUboFields[0]?.name ?? "lightDirection";
    const lightBaseOffset = sceneUboSpec.offsets.get(lightFieldName)! / 4;

    const sceneBGL = createSceneBindGroupLayout(engine);
    const sceneUniformBuffer = device.createBuffer({
        size: sceneUboSize,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const sceneBindGroup = device.createBindGroup({
        layout: sceneBGL,
        entries: [{ binding: 0, resource: { buffer: sceneUniformBuffer } }],
    });

    let lightsUBOBuffer: GPUBuffer | undefined;
    let lightsUBOScratch: Float32Array | undefined;
    if (hasMultiLight && _writeLightsUBO) {
        lightsUBOBuffer = _writeLightsUBO(engine, scene.lights);
        lightsUBOScratch = new Float32Array(_LIGHTS_UBO_SIZE / 4);
        (scene as SceneContextInternal)._pbrLightsUBO = lightsUBOBuffer;
        (scene as SceneContextInternal)._pbrLightsUBOScratch = lightsUBOScratch;
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

    const packets: PbrDrawPacket[] = [];
    for (const mesh of meshes) {
        const gpu = (mesh as MeshInternal)._gpu;
        const hasTangents = !!gpu.tangentBuffer;
        const hasEmissive = !!(mesh.material as PbrMaterialProps).emissiveTexture;
        const hasEmissiveCol = !!(mesh.material as PbrMaterialProps).emissiveColor;
        const hasSkeleton = !!mesh.skeleton;
        const hasMorphTargets = !!mesh.morphTargets;
        const mat = mesh.material as PbrMaterialProps;
        const hasAlphaBlend = mat.alphaBlend === true || (mat.alpha !== undefined && mat.alpha < 1);
        const hasSpecGloss = !!mat.specGlossTexture;
        const hasDoubleSided = !!mat.doubleSided;
        const hasNormalTexture = !!mat.normalTexture;
        const hasMetallicReflectanceMap = !!mat.metallicReflectanceTexture;
        const hasReflectanceMap = !!mat.reflectanceTexture;
        let features = computePbrFeatures(
            hasTangents,
            hasEmissive,
            hasEnv,
            hasSkeleton,
            hasTonemap,
            hasMorphTargets,
            hasAlphaBlend,
            hasSpecGloss,
            hasDoubleSided,
            hasNormalTexture,
            hasMetallicReflectanceMap,
            hasReflectanceMap,
            hasEmissiveCol
        );
        if (mat.useOnlyMetallicFromMetallicReflectanceTexture) {
            features |= PBR_HAS_USE_ALPHA_ONLY_MR;
        }
        features |= lightTypeBits;
        if ((mat.occlusionStrength ?? 1.0) > 0) {
            features |= PBR_HAS_OCCLUSION;
        }
        if (hasSkeleton && mesh.skeleton?.joints1Buffer) {
            features |= PBR_HAS_SKELETON_8;
        }
        if (mat.enableSpecularAA) {
            features |= PBR_HAS_SPECULAR_AA;
        }
        if ((mat.clearCoat as { isEnabled?: boolean } | undefined)?.isEnabled) {
            features |= PBR_HAS_CLEARCOAT;
        }
        let features2 = 0;
        const ccProps = mat.clearCoat as import("./pbr-material.js").ClearCoatProps | undefined;
        if (ccProps?.isEnabled) {
            if (ccProps.texture) {
                features2 |= PBR2_CC_INT_MAP;
            }
            if (ccProps.roughnessTexture) {
                features2 |= PBR2_CC_ROUGH_MAP;
            }
            if (ccProps.bumpTexture) {
                features2 |= PBR2_CC_NORMAL_MAP;
            }
            if (ccProps.useF0Remap === false) {
                features2 |= PBR2_CC_F0_REMAP_OFF;
            }
        }
        const sheenProps = mat.sheen as SheenProps | undefined;
        if (sheenProps?.isEnabled) {
            features |= PBR_HAS_SHEEN;
            if (sheenProps.texture) {
                features |= PBR_HAS_SHEEN_TEXTURE;
            }
        }
        if (mesh.receiveShadows && hasSomeShadows) {
            features |= PBR_HAS_RECEIVE_SHADOWS;
        }
        if (mat.gammaAlbedo) {
            features |= PBR_HAS_GAMMA_ALBEDO;
        }
        if (mat.anisotropy?.isEnabled) {
            features |= PBR_HAS_ANISOTROPY;
        }
        if (mat.skyboxMode) {
            features |= PBR_HAS_SKYBOX;
        }
        if (_ssExt) {
            features |= _ssExt.detect(mat);
        }
        if (mesh.thinInstances) {
            features |= PBR_HAS_THIN_INSTANCES;
            if (mesh.thinInstances.colors) {
                features |= PBR_HAS_INSTANCE_COLOR;
            }
        }

        const composed = composePbr(features, features2);
        const variant = getOrCreatePbrPipeline(engine, engine.format, engine.msaaSamples, features, features2, sceneBGL, composed);
        const worldMatrix = mesh.worldMatrix;
        const meshUBO = createMeshUBO(engine, worldMatrix, composed);
        const materialUBO = createMaterialUBO(engine, mat, composed);
        const boneView = mesh.skeleton?.boneTexture.createView();
        const morphView = mesh.morphTargets?.texture.createView();
        const materialBindGroup = createPbrMeshBindGroup(
            engine,
            variant,
            meshUBO,
            materialUBO,
            mat,
            envTextures ?? null,
            boneView,
            morphView,
            mesh.morphTargets?.weightsBuffer,
            lightsUBOBuffer
        );

        // Shadow bind group (group 2) — per-light: texture, sampler, and shared shadow UBO
        let shadowBindGroup: GPUBindGroup | null = null;
        const packetShadowGens: ShadowGenerator[] = [];
        const meshShadowLights = mesh.receiveShadows ? shadowLights : [];
        if (meshShadowLights.length > 0 && variant.shadowBGL) {
            const entries: GPUBindGroupEntry[] = [];
            let b = 0;
            for (const sl of meshShadowLights) {
                const sg = sl.gen;
                entries.push({ binding: b++, resource: sg.blurredTexture.createView() });
                entries.push({ binding: b++, resource: sg.blurredSampler });
                packetShadowGens.push(sg);
                entries.push({ binding: b++, resource: { buffer: sg.shadowUBO } });
            }
            shadowBindGroup = device.createBindGroup({ layout: variant.shadowBGL, entries });
        }

        packets.push({
            variant,
            materialBindGroup,
            shadowBindGroup,
            shadowGens: packetShadowGens,
            mesh,
            meshUBO,
            materialUBO,
            composed,
            _lastWorldVersion: mesh.worldMatrixVersion,
            positionBuffer: gpu.positionBuffer,
            normalBuffer: gpu.normalBuffer,
            tangentBuffer: gpu.tangentBuffer ?? null,
            uvBuffer: gpu.uvBuffer,
            jointsBuffer: mesh.skeleton?.jointsBuffer ?? null,
            weightsBuffer: mesh.skeleton?.weightsBuffer ?? null,
            joints1Buffer: mesh.skeleton?.joints1Buffer ?? null,
            weights1Buffer: mesh.skeleton?.weights1Buffer ?? null,
            indexBuffer: gpu.indexBuffer,
            indexCount: gpu.indexCount,
            indexFormat: gpu.indexFormat,
        });

        const boundTextures = collectPbrBoundTextures(mat);
        for (const t of boundTextures) {
            acquireTexture(t);
        }
        (scene as SceneContextInternal)._meshDisposables.set(mesh, [
            () => {
                meshUBO.destroy();
                materialUBO.destroy();
            },
            () => {
                for (const t of boundTextures) {
                    releaseTexture(t);
                }
            },
            () => releasePbrPipelineVariant(variant),
        ]);
    }

    // Split packets into opaque and transparent for correct draw order
    const opaquePackets = packets.filter((p) => (p.variant.features & PBR_HAS_ALPHA_BLEND) === 0);
    const transparentPackets = packets.filter((p) => (p.variant.features & PBR_HAS_ALPHA_BLEND) !== 0);

    // Sort each list by pipeline variant so consecutive draws can skip redundant setPipeline
    opaquePackets.sort((a, b) => a.variant.features - b.variant.features);
    transparentPackets.sort((a, b) => a.variant.features - b.variant.features);
    const renderables: Renderable[] = [];

    function drawPackets(pass: GPURenderPassEncoder | GPURenderBundleEncoder, list: PbrDrawPacket[]): number {
        pass.setBindGroup(0, sceneBindGroup);
        let currentPipeline: GPURenderPipeline | null = null;
        for (const dp of list) {
            if (dp.variant.pipeline !== currentPipeline) {
                pass.setPipeline(dp.variant.pipeline);
                currentPipeline = dp.variant.pipeline;
            }
            pass.setBindGroup(1, dp.materialBindGroup);
            if (dp.shadowBindGroup) {
                pass.setBindGroup(2, dp.shadowBindGroup);
            }
            let slot = 0;
            pass.setVertexBuffer(slot++, dp.positionBuffer);
            pass.setVertexBuffer(slot++, dp.normalBuffer);
            if (dp.variant.features & PBR_HAS_NORMAL_MAP && dp.tangentBuffer) {
                pass.setVertexBuffer(slot++, dp.tangentBuffer);
            }
            pass.setVertexBuffer(slot++, dp.uvBuffer);
            if (dp.jointsBuffer && dp.weightsBuffer) {
                pass.setVertexBuffer(slot++, dp.jointsBuffer);
                pass.setVertexBuffer(slot++, dp.weightsBuffer);
                if (dp.joints1Buffer && dp.weights1Buffer) {
                    pass.setVertexBuffer(slot++, dp.joints1Buffer);
                    pass.setVertexBuffer(slot++, dp.weights1Buffer);
                }
            }

            // Thin instance vertex buffers
            const ti = dp.mesh.thinInstances;
            const hasTI = (dp.variant.features & PBR_HAS_THIN_INSTANCES) !== 0;
            const hasTIColor = (dp.variant.features & PBR_HAS_INSTANCE_COLOR) !== 0;
            if (hasTI && ti && _syncThinInstanceBuffers) {
                slot = _syncThinInstanceBuffers(engine, ti, pass, slot, hasTIColor);
            }

            pass.setIndexBuffer(dp.indexBuffer, dp.indexFormat);
            if (hasTI && ti) {
                pass.drawIndexed(dp.indexCount, ti.count);
            } else {
                pass.drawIndexed(dp.indexCount);
            }
        }
        return list.length;
    }

    function updatePacketUBOs(list: PbrDrawPacket[]) {
        updateWorldMatrixUBOs(engine, list);
        for (const dp of list) {
            const mat = dp.mesh.material as PbrMaterialProps;
            if (!(mat as any)._uboDirty) {
                continue;
            }
            (mat as any)._uboDirty = false;
            const spec = dp.composed.materialUboSpec!;
            let data = materialScratch.get(spec.totalBytes);
            if (!data) {
                data = new Float32Array(spec.totalBytes / 4);
                materialScratch.set(spec.totalBytes, data);
            } else {
                data.fill(0);
            }
            writeMaterialData(data, mat, spec);
            device.queue.writeBuffer(dp.materialUBO, 0, data.buffer, 0, data.byteLength);
        }
    }

    if (opaquePackets.length > 0) {
        renderables.push({
            order: 100,
            isTransparent: false,
            _sceneBG: sceneBindGroup,
            updateUBOs() {
                updatePacketUBOs(opaquePackets);
            },
            draw: (pass) => drawPackets(pass, opaquePackets),
        });
    }
    if (transparentPackets.length > 0) {
        renderables.push({
            order: 150,
            isTransparent: true,
            _sceneBG: sceneBindGroup,
            updateUBOs() {
                updatePacketUBOs(transparentPackets);
            },
            draw: (pass) => drawPackets(pass, transparentPackets),
        });
    }

    // Pre-allocate scene uniform scratch buffer
    const sceneUniformData = new Float32Array(sceneUboSize / 4);
    let _lastPbrLightsVersion = -1;
    // Scene UBO dirty tracking
    let _lastPbrCamVersion = -1;
    let _lastPbrAspect = -1;
    let _lastPbrLightVersion = -1;
    let _lastExposure = -1;
    let _lastContrast = -1;
    let _lastEnvRotY = -Infinity;

    const updater: SceneUniformUpdater = {
        update(engine: EngineContext) {
            const cam = scene.camera;
            if (!cam) {
                return;
            }
            const aspect = engine.canvas.width / engine.canvas.height;
            const camVer = cam.worldMatrixVersion;
            // Inline light-version sum (avoids importing lights-ubo.js on the single-light path)
            let lightVer = 0;
            for (const l of scene.lights) {
                lightVer += (l as LightBaseInternal)._lightVersion ?? 0;
            }
            const exposure = scene.imageProcessing.exposure;
            const contrast = scene.imageProcessing.contrast;
            const envRotY = scene.envRotationY ?? 0;

            // Only rewrite scene UBO if any input changed
            if (
                camVer !== _lastPbrCamVersion ||
                aspect !== _lastPbrAspect ||
                lightVer !== _lastPbrLightVersion ||
                exposure !== _lastExposure ||
                contrast !== _lastContrast ||
                envRotY !== _lastEnvRotY
            ) {
                _lastPbrCamVersion = camVer;
                _lastPbrAspect = aspect;
                _lastPbrLightVersion = lightVer;
                _lastExposure = exposure;
                _lastContrast = contrast;
                _lastEnvRotY = envRotY;

                const viewProj = getViewProjectionMatrix(cam, aspect);
                const camPos = getCameraPosition(cam);

                const data = sceneUniformData;
                data.fill(0);
                data.set(viewProj, 0);
                data[16] = camPos.x;
                data[17] = camPos.y;
                data[18] = camPos.z;
                if (hasLight) {
                    const light = scene.lights[0];
                    const ext = _getPbrLightExtension();
                    if (light && ext) {
                        ext.writeSceneUbo(data, lightBaseOffset, light);
                    }
                }
                data[envRotYOffset] = envRotY;
                const sh = envTextures?.sphericalHarmonics;
                if (sh) {
                    data.set(sh.l00, shBaseOffset);
                    data.set(sh.l1_1, shBaseOffset + 4);
                    data.set(sh.l10, shBaseOffset + 8);
                    data.set(sh.l11, shBaseOffset + 12);
                    data.set(sh.l2_2, shBaseOffset + 16);
                    data.set(sh.l2_1, shBaseOffset + 20);
                    data.set(sh.l20, shBaseOffset + 24);
                    data.set(sh.l21, shBaseOffset + 28);
                    data.set(sh.l22, shBaseOffset + 32);
                }
                data[exposureOffset] = exposure;
                data[exposureOffset + 1] = contrast;
                data[exposureOffset + 2] = envTextures?.lodGenerationScale ?? 0.8;
                device.queue.writeBuffer(sceneUniformBuffer, 0, data);
            }
            if (lightsUBOBuffer && lightsUBOScratch && _refreshLightsUBO) {
                if (lightVer !== _lastPbrLightsVersion) {
                    _lastPbrLightsVersion = lightVer;
                    _refreshLightsUBO(engine as EngineContextInternal, lightsUBOBuffer, scene.lights, lightsUBOScratch);
                }
            }
        },
    };

    // Stash the PBR scene bind group for background renderables to reuse
    (scene as SceneContextInternal)._pbrSceneBGL = sceneBGL;
    (scene as SceneContextInternal)._pbrSceneBG = sceneBindGroup;

    (scene as SceneContextInternal)._disposables.push(
        () => clearPbrPipelineCache(),
        () => clearSamplerCache(engine)
    );

    return { renderables, updater, _sceneBGL: sceneBGL, _sceneBG: sceneBindGroup };
}

function allocUBO(engine: EngineContextInternal, data: Float32Array): GPUBuffer {
    const device = engine.device;
    const buf = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buf, 0, data as unknown as Float32Array<ArrayBuffer>);
    return buf;
}

/** Create a mesh UBO containing only the world matrix (64 bytes). */
function createMeshUBO(engine: EngineContextInternal, world: Mat4, composed: ComposedShader): GPUBuffer {
    const data = new Float32Array(composed.meshUboSpec.totalBytes / 4);
    data.set(world, 0);
    return allocUBO(engine, data);
}

/** Write material properties into a pre-allocated Float32Array. */
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

    const hasReflectanceExt = spec.offsets.has("occlusionStrength") && (material.metallicReflectanceTexture !== undefined || material.reflectanceTexture !== undefined);
    if (hasReflectanceExt) {
        const off = spec.offsets.get("occlusionStrength")! / 4;
        data[off] = material.occlusionStrength ?? 1.0;
        data[off + 1] = material.metallicF0Factor ?? 1.0;
        const mrc = material.metallicReflectanceColor;
        data[off + 4] = mrc ? mrc[0]! : 1.0;
        data[off + 5] = mrc ? mrc[1]! : 1.0;
        data[off + 6] = mrc ? mrc[2]! : 1.0;
    }

    if (material.emissiveColor && spec.offsets.has("emissiveColor")) {
        const off = spec.offsets.get("emissiveColor")! / 4;
        data[off] = material.emissiveColor[0]!;
        data[off + 1] = material.emissiveColor[1]!;
        data[off + 2] = material.emissiveColor[2]!;
    }

    if ((material.clearCoat as { isEnabled?: boolean } | undefined)?.isEnabled && spec.offsets.has("ccParams")) {
        const cc = material.clearCoat as import("./pbr-material.js").ClearCoatProps;
        const off = spec.offsets.get("ccParams")! / 4;
        const ior = cc.indexOfRefraction ?? 1.5;
        const a = 1 - ior;
        const b = 1 + ior;
        data[off] = cc.intensity ?? 1.0;
        data[off + 1] = cc.roughness ?? 0.0;
        data[off + 2] = cc.bumpTextureScale ?? 1.0;
        data[off + 4] = Math.pow(-a / b, 2);
        data[off + 5] = 1 / ior;
        data[off + 6] = a;
        data[off + 7] = b;
    }

    if ((material.sheen as SheenProps | undefined)?.isEnabled && spec.offsets.has("sheenParams")) {
        const sh = material.sheen as SheenProps;
        const off = spec.offsets.get("sheenParams")! / 4;
        const color = sh.color ?? [1, 1, 1];
        data[off] = color[0]!;
        data[off + 1] = color[1]!;
        data[off + 2] = color[2]!;
        data[off + 3] = sh.intensity ?? 1.0;
        data[off + 4] = sh.roughness ?? 0.0;
        data[off + 5] = sh.texture ? 1.0 : 0.0;
    }

    if (material.anisotropy?.isEnabled && spec.offsets.has("anisotropyParams")) {
        const aniso = material.anisotropy;
        const off = spec.offsets.get("anisotropyParams")! / 4;
        const dir = aniso.direction ?? [1, 0];
        data[off] = aniso.intensity ?? 1.0;
        data[off + 1] = dir[0]!;
        data[off + 2] = dir[1]!;
    }

    _getSubsurfaceExt()?.ubo(data, material, spec.offsets);
}

/** Create a material UBO from the ComposedShader's materialUboSpec. */
function createMaterialUBO(engine: EngineContextInternal, material: PbrMaterialProps, composed: ComposedShader): GPUBuffer {
    const spec = composed.materialUboSpec!;
    const data = new Float32Array(spec.totalBytes / 4);
    writeMaterialData(data, material, spec);
    return allocUBO(engine, data);
}

/** Exported for use by pbr-single-rebuild.ts */
export { createMeshUBO as _createPbrMeshUBO, createMaterialUBO as _createPbrMaterialUBO };
