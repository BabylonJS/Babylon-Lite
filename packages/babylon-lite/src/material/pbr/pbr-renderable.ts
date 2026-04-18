/** PBR mesh renderable — builds Renderable(s) from glTF PBR meshes + environment.
 *
 *  Uses the ShaderFragment composer: each mesh gets a ComposedShader from its
 *  feature set, which provides WGSL source, BGL descriptors, vertex layouts,
 *  and UBO specs. Scene UBO updated once per frame. */

import type { EngineContextInternal } from "../../engine/engine.js";
import type { SceneContext } from "../../scene/scene.js";
import type { SceneContextInternal } from "../../scene/scene.js";
import type { Mesh } from "../../mesh/mesh.js";
import type { MeshInternal } from "../../mesh/mesh.js";
import type { LightBaseInternal } from "../../light/types.js";
import type { PbrMaterialProps } from "./pbr-material.js";
import { collectPbrBoundTextures } from "./pbr-material.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";

import type { Mat4 } from "../../math/types.js";
import type { Renderable, SceneUniformUpdater } from "../../render/renderable.js";
import type { ShaderFragment, ComposedShader } from "../../shader/fragment-types.js";
import type { PbrLightConfig } from "./pbr-template.js";
import type { UboField } from "../../shader/fragment-types.js";
import { composeShader } from "../../shader/shader-composer.js";
import { createPbrTemplate } from "./pbr-template.js";
import { computeUboLayout } from "../../shader/ubo-layout.js";
import { acquireTexture, releaseTexture, clearSamplerCache } from "../../resource/gpu-pool.js";
import { createEmptyUniformBuffer, createUniformBuffer } from "../../resource/gpu-buffers.js";
import { updateWorldMatrixUBOs } from "../../render/scene-helpers.js";
import {
    createSceneBindGroupLayout,
    getOrCreatePbrPipeline,
    createPbrMeshBindGroup,
    releasePbrPipelineVariant,
    clearPbrPipelineCache,
    PBR_HAS_NORMAL_MAP,
    PBR_HAS_ALPHA_BLEND,
    PBR_HAS_METALLIC_REFLECTANCE_MAP,
    PBR_HAS_REFLECTANCE_MAP,
    PBR_HAS_SPECULAR_AA,
    PBR_HAS_EMISSIVE_COLOR,
    PBR_HAS_SHEEN_TEXTURE,
    PBR_HAS_GAMMA_ALBEDO,
    PBR_HAS_RECEIVE_SHADOWS,
    PBR2_CC_INT_MAP,
    PBR2_CC_ROUGH_MAP,
    PBR2_CC_NORMAL_MAP,
} from "./pbr-pipeline.js";
import { PBR_HAS_THIN_INSTANCES, PBR_HAS_INSTANCE_COLOR } from "./pbr-pipeline.js";
import {
    _getPbrLightExtension,
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
    PBR_HAS_CLEARCOAT,
    PBR_HAS_SHEEN,
    PBR_HAS_ANISOTROPY,
    PBR_HAS_SKYBOX,
} from "./pbr-flags.js";
import { computeMeshPbrFeatures } from "./pbr-mesh-features.js";
import { createPbrSceneUpdater } from "./pbr-scene-updater.js";
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
    let _iblSkyboxCalc = "";
    if (hasEnv) {
        const mod = await import("./fragments/ibl-fragment.js");
        _registerPbrExt(mod.iblExt);
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
    if (hasMetallicReflectance) {
        const mod = await import("./fragments/reflectance-fragment.js");
        _registerPbrExt(mod.reflectanceExt);
    }

    const hasClearcoat = meshes.some((m) => !!(m.material as PbrMaterialProps).clearCoat?.isEnabled);
    if (hasClearcoat) {
        const mod = await import("./fragments/clearcoat-fragment.js");
        _registerPbrExt(mod.clearcoatExt);
    }

    const hasSheen = meshes.some((m) => !!(m.material as PbrMaterialProps).sheen?.isEnabled);
    if (hasSheen) {
        const mod = await import("./fragments/sheen-fragment.js");
        _registerPbrExt(mod.sheenExt);
    }

    const hasAnyAnisotropy = meshes.some((m) => !!(m.material as PbrMaterialProps).anisotropy?.isEnabled);
    let _anisoExt: typeof import("./fragments/anisotropy-fragment.js") | null = null;
    if (hasAnyAnisotropy) {
        _anisoExt = await import("./fragments/anisotropy-fragment.js");
        const anisoMod = _anisoExt;
        _registerPbrMaterialUboWriter("anisotropy", (d, m, o) => anisoMod.writeAnisotropyUBO(d, m as PbrMaterialProps, o));
    }

    const hasAnySubsurface = meshes.some((m) => !!(m.material as PbrMaterialProps).subsurface?.translucency);
    if (hasAnySubsurface) {
        const mod = await import("./fragments/subsurface-fragment.js");
        _registerPbrExt(mod.subsurfaceExt);
    }

    const needsEmissiveColor = meshes.some((m) => !!(m.material as PbrMaterialProps).emissiveColor);
    if (needsEmissiveColor) {
        const mod = await import("./fragments/emissive-fragment.js");
        _registerPbrExt(mod.emissiveColorExt);
    }

    const hasSomeSkeletons = meshes.some((m) => !!m.skeleton);
    if (hasSomeSkeletons) {
        const mod = await import("./fragments/skeleton-fragment.js");
        _registerPbrExt(mod.skeletonExt);
    }

    const hasSomeMorphs = meshes.some((m) => !!m.morphTargets);
    if (hasSomeMorphs) {
        const mod = await import("./fragments/morph-fragment.js");
        _registerPbrExt(mod.morphExt);
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
        const hasCC = has(PBR_HAS_CLEARCOAT);
        const hasSh = has(PBR_HAS_SHEEN);
        const hasAniso = has(PBR_HAS_ANISOTROPY);
        const hasEmCol = has(PBR_HAS_EMISSIVE_COLOR);
        const hasEmTex = has(PBR_HAS_EMISSIVE);
        const hasTI = has(PBR_HAS_THIN_INSTANCES);
        const ccIntMap = (features2 & PBR2_CC_INT_MAP) !== 0;
        const ccRoughMap = (features2 & PBR2_CC_ROUGH_MAP) !== 0;
        const ccNormalMap = (features2 & PBR2_CC_NORMAL_MAP) !== 0;

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

    const sceneBGL = createSceneBindGroupLayout(engine);
    const sceneUniformBuffer = createEmptyUniformBuffer(engine, sceneUboSize);
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
    const featureCtx: import("./pbr-mesh-features.js").PbrFeatureCtx = { hasEnv, hasTonemap, hasSomeShadows };
    for (const mesh of meshes) {
        const gpu = (mesh as MeshInternal)._gpu;
        const mat = mesh.material as PbrMaterialProps;
        const { features, features2 } = computeMeshPbrFeatures(mesh, scene, featureCtx);

        const composed = composePbr(features, features2);
        const variant = getOrCreatePbrPipeline(engine, engine.format, engine.msaaSamples, features, features2, sceneBGL, composed);
        const worldMatrix = mesh.worldMatrix;
        const meshUBO = createMeshUBO(engine, worldMatrix, composed, mat);
        const materialUBO = createMaterialUBO(engine, mat, composed);
        const materialBindGroup = createPbrMeshBindGroup(engine, variant, meshUBO, materialUBO, mat, envTextures ?? null, mesh, lightsUBOBuffer);

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

    const updater = createPbrSceneUpdater({
        scene,
        device,
        envTextures,
        sceneUboSpec,
        sceneUniformBuffer,
        hasLight,
        lightConfig,
        lightsUBOBuffer,
        lightsUBOScratch,
        refreshLightsUBO: _refreshLightsUBO,
    });

    // Stash the PBR scene bind group for background renderables to reuse
    (scene as SceneContextInternal)._pbrSceneBGL = sceneBGL;
    (scene as SceneContextInternal)._pbrSceneBG = sceneBindGroup;

    (scene as SceneContextInternal)._disposables.push(
        () => clearPbrPipelineCache(),
        () => clearSamplerCache(engine)
    );

    return { renderables, updater, _sceneBGL: sceneBGL, _sceneBG: sceneBindGroup };
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

/** Exported for use by pbr-single-rebuild.ts */
export { createMeshUBO as _createPbrMeshUBO, createMaterialUBO as _createPbrMaterialUBO };
