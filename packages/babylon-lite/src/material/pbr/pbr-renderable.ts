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
import { getPbrBaseSceneUboFields } from "./pbr-template.js";
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
    PBR2_HAS_REFRACTION,
    PBR2_HAS_UV2,
    PBR2_HAS_VERTEX_COLOR,
    PBR_HAS_THIN_INSTANCES,
    PBR_HAS_INSTANCE_COLOR,
} from "./pbr-pipeline.js";
import { _getPbrLightExtension, _registerPbrExt, _getPbrExts } from "./pbr-flags.js";
import { createPbrComposer } from "./pbr-compose.js";
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
    uv2Buffer: GPUBuffer | null;
    colorBuffer: GPUBuffer | null;
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
    // Multi-light path: any time there are multiple lights OR any light casts shadows.
    // The shadow fragment itself is only attached when meshes have PBR_HAS_RECEIVE_SHADOWS;
    // the multi-light loop's default `shadowFactors = 1.0` leaves unlit meshes untouched.
    const hasMultiLight = scene.lights.length > 1 || hasSomeShadows;

    // Register PBR extensions for all lights
    for (const light of scene.lights) {
        const li = light as LightBaseInternal;
        if (li._registerPbr) {
            await li._registerPbr();
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
    let hasRefraction = false;
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
        const mi = m as import("../../mesh/mesh.js").MeshInternal;
        hasSkybox ||= !!mat.skyboxMode;
        hasMetallicReflectance ||= !!(mat.metallicReflectanceTexture || mat.reflectanceTexture || mat._hasReflExt);
        hasClearcoat ||= !!mat.clearCoat?.isEnabled;
        hasSheen ||= !!mat.sheen?.isEnabled;
        hasAnyAnisotropy ||= !!mat.anisotropy?.isEnabled;
        hasAnySubsurface ||= !!mat.subsurface?.translucency;
        hasRefraction ||= (mat.subsurface?.refraction?.intensity ?? 0) > 0;
        needsEmissiveColor ||= !!mat.emissiveColor;
        hasSomeSkeletons ||= !!m.skeleton;
        hasSomeMorphs ||= !!m.morphTargets;
        hasSomeThinInstances ||= !!m.thinInstances;
        hasAnyUnlit ||= !!mat.unlit;
        hasAnyUvTransform ||= !!mat._hasUvTx;
        // UV2 only counts when occlusion samples texcoord 1 (matches pbr-mesh-features.ts).
        hasAnyUv2 ||= !!mi._gpu.uv2Buffer && mat.occlusionTexCoord === 1;
        hasAnyVertexColor ||= !!mi._gpu.colorBuffer;
    }

    // ── Dynamically import fragment creators based on scene capabilities ──

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
    if (hasMultiLight) {
        const [lightsUboMod, wgslMod] = await Promise.all([import("../../render/lights-ubo.js"), import("./fragments/multilight-wgsl.js")]);
        _writeLightsUBO = lightsUboMod.writeLightsUBO;
        _refreshLightsUBO = lightsUboMod.refreshLightsUBO;
        _LIGHTS_UBO_SIZE = lightsUboMod.getLightsUboSize();
        _multiLightWGSL = wgslMod.MULTI_LIGHT_STRUCTS() + wgslMod.COMPUTE_PBR_LIGHT;
        _multiLightLoop = wgslMod.getMultiLightLoop();
        if (hasSomeShadows) {
            const shadowMod = await import("./fragments/pbr-shadow-fragment.js");
            _createPbrShadowFragment = shadowMod.createPbrShadowFragment;
        }
    }

    // ── Per-mesh fragment creators (imported if any mesh needs them) ──
    // Inline `if` blocks (rather than a descriptor array) keep the awaited `import()`
    // sites literal AND let terser shorten each block independently, saving ~1 KB
    // in scene1's pbr-renderable chunk. Registration runs sequentially in source
    // order, which is the iteration order consumed by `_getPbrExts().values()` on
    // the hot paths (composePbr, writeMaterialData, collectPbrBoundTextures,
    // computeMeshPbrFeatures).
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
    if (hasRefraction) {
        const mod = await import("./fragments/refraction-fragment.js");
        _registerPbrExt(mod.refractionExt);
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
    const hasAnyExt = hasAnyUvTransform || hasAnyVertexColor || hasAnyUv2;
    if (hasAnyExt) {
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

    // ── Build light config from registered extension ──
    const lightExt = _getPbrLightExtension();
    const lightConfig: PbrLightConfig | null = lightExt ? lightExtToConfig(lightExt) : null;
    const hasLight = !!lightExt;

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

    // ── Compose shaders per unique feature set (cached) ──
    const composePbr = createPbrComposer({
        hasMultiLight,
        lightConfig,
        multiLightWGSL: _multiLightWGSL,
        multiLightLoop: _multiLightLoop,
        acesHelpers: _acesHelpers,
        acesTonemapCall: _acesTonemapCall,
        createPbrTemplateExt: _createPbrTemplateExt,
        anisoExt: _anisoExt,
        iblSkyboxCalc: _iblSkyboxCalc,
        createPbrShadowFragment: _createPbrShadowFragment,
        shadowLights,
        createThinInstanceFragment: _createThinInstanceFragment,
    });

    // Stash composePbr on the scene so single-rebuild can reuse it
    (scene as SceneContextInternal)._composePbr = composePbr;

    // ── Scene UBO layout ──
    // Compute the scene UBO spec from the base template's scene UBO fields.
    // All PBR variants share the same scene UBO layout — the base template
    // includes all scene fields. Light fields are always present for layout
    // compatibility with background ground shader.
    const baseSceneUboFields = getPbrBaseSceneUboFields(hasMultiLight ? null : lightConfig, hasMultiLight, hasEnv);
    const sceneUboSpec = computeUboLayout(baseSceneUboFields);
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

    const packets: PbrDrawPacket[] = [];
    const featureCtx: import("./pbr-mesh-features.js").PbrFeatureCtx = { hasEnv, hasTonemap, hasSomeShadows };
    // Shadow bind group cache — within one scene build, all receiving meshes share the
    // same shadowLights array (see meshShadowLights assignment below), so a BG keyed by
    // shadowBGL alone is correct. Cache is scoped to this builder (not module-level).
    const shadowBGCache = new Map<GPUBindGroupLayout, GPUBindGroup>();
    for (const mesh of meshes) {
        const gpu = (mesh as MeshInternal)._gpu;
        const mat = mesh.material as PbrMaterialProps;
        const { features, features2 } = computeMeshPbrFeatures(mesh, scene, featureCtx);

        const composed = composePbr(features, features2);
        const variant = getOrCreatePbrPipeline(engine, engine.format, engine.msaaSamples, features, features2, sceneBGL, composed);
        const worldMatrix = mesh.worldMatrix;
        const meshUBO = createMeshUBO(engine, worldMatrix, composed, mat);
        const materialUBO = createMaterialUBO(engine, mat, composed);
        const materialBindGroup = createPbrMeshBindGroup(engine, variant, composed, meshUBO, materialUBO, mat, envTextures ?? null, mesh, lightsUBOBuffer);

        // Shadow bind group (group 2) — per-light: texture, sampler, and shared shadow UBO.
        // Shared across all receiving meshes in this build via shadowBGCache.
        let shadowBindGroup: GPUBindGroup | null = null;
        const packetShadowGens: ShadowGenerator[] = [];
        const meshShadowLights = mesh.receiveShadows ? shadowLights : [];
        if (meshShadowLights.length > 0 && variant.shadowBGL) {
            for (const sl of meshShadowLights) {
                packetShadowGens.push(sl.gen);
            }
            let cached = shadowBGCache.get(variant.shadowBGL);
            if (!cached) {
                const entries: GPUBindGroupEntry[] = [];
                let b = 0;
                for (const sl of meshShadowLights) {
                    const sg = sl.gen;
                    entries.push({ binding: b++, resource: sg.blurredTexture.createView() });
                    entries.push({ binding: b++, resource: sg.blurredSampler });
                    entries.push({ binding: b++, resource: { buffer: sg.shadowUBO } });
                }
                cached = device.createBindGroup({ layout: variant.shadowBGL, entries });
                shadowBGCache.set(variant.shadowBGL, cached);
            }
            shadowBindGroup = cached;
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
            uv2Buffer: gpu.uv2Buffer ?? null,
            colorBuffer: gpu.colorBuffer ?? null,
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

    // Three-way partition: 0=opaque, 1=transmissive (refraction), 2=transparent (alpha-blend).
    const buckets: PbrDrawPacket[][] = [[], [], []];
    for (const p of packets) {
        const b = p.variant.features & PBR_HAS_ALPHA_BLEND ? 2 : p.variant.features2 & PBR2_HAS_REFRACTION ? 1 : 0;
        buckets[b]!.push(p);
    }
    for (const b of buckets) {
        b.sort((a, b) => a.variant.features - b.variant.features);
    }
    const renderables: Renderable[] = [];

    function drawPackets(pass: GPURenderPassEncoder | GPURenderBundleEncoder, list: PbrDrawPacket[]): number {
        // sceneBindGroup is bound by engine.drawList via _sceneBG.
        let currentPipeline: GPURenderPipeline | null = null;
        for (const dp of list) {
            if (dp.mesh.visible === false) {
                continue;
            }
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
            if ((dp.variant.features2 & PBR2_HAS_UV2) !== 0 && dp.uv2Buffer) {
                pass.setVertexBuffer(slot++, dp.uv2Buffer);
            }
            if ((dp.variant.features2 & PBR2_HAS_VERTEX_COLOR) !== 0 && dp.colorBuffer) {
                pass.setVertexBuffer(slot++, dp.colorBuffer);
            }
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

    const ORDERS = [100, 140, 150];
    for (let i = 0; i < 3; i++) {
        const list = buckets[i]!;
        if (list.length === 0) {
            continue;
        }
        renderables.push({
            order: ORDERS[i]!,
            isTransparent: i === 2,
            isTransmissive: i === 1,
            _sceneBG: sceneBindGroup,
            updateUBOs() {
                updatePacketUBOs(list);
            },
            draw: (pass) => drawPackets(pass, list),
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

function createMeshUBO(engine: EngineContextInternal, world: Mat4, composed: ComposedShader, _material: PbrMaterialProps): GPUBuffer {
    const data = new Float32Array(composed.meshUboSpec.totalBytes / 4);
    data.set(world, 0);
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
        data[off + 2] = material.normalTextureScale ?? 1.0;
    }

    // Unified PBR extensions contribute their material-UBO slice
    // (uv-transform, reflectance, emissive, clearcoat, sheen, anisotropy, ...).
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
