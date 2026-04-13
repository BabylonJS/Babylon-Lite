/** Dynamic PBR pipeline builder — creates and caches GPU render pipelines
 *  based on per-mesh PBR feature flags + ComposedShader from the fragment system.
 *
 *  Pipelines cached per (fragmentKey, features, format, msaaSamples) tuple.
 *  The ComposedShader provides WGSL source, BGL descriptors, and vertex layouts. */

import type { PbrMaterialProps, SheenProps } from "./pbr-material.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";
import type { ComposedShader } from "../../shader/fragment-types.js";
import { createPipelineCache, releaseVariant } from "../pipeline-cache.js";
import type { PipelineCache } from "../pipeline-cache.js";
import {
    PBR_HAS_NORMAL_MAP,
    PBR_HAS_EMISSIVE,
    PBR_HAS_EMISSIVE_COLOR,
    PBR_HAS_ENV,
    PBR_HAS_SKELETON,
    PBR_HAS_TONEMAP,
    PBR_HAS_MORPH_TARGETS,
    PBR_HAS_ALPHA_BLEND,
    PBR_HAS_SPEC_GLOSS,
    PBR_HAS_DOUBLE_SIDED,
    PBR_HAS_COTANGENT_NORMAL,
    PBR_HAS_METALLIC_REFLECTANCE_MAP,
    PBR_HAS_REFLECTANCE_MAP,
    PBR_HAS_SKELETON_8,
    PBR_HAS_SPECULAR_AA,
    PBR_HAS_THIN_INSTANCES,
    PBR_HAS_INSTANCE_COLOR,
    PBR_HAS_SHEEN_TEXTURE,
    PBR_HAS_RECEIVE_SHADOWS,
    PBR_HAS_GAMMA_ALBEDO,
    PBR_HAS_OCCLUSION,
    PBR_HAS_CLEARCOAT,
    PBR_HAS_SHEEN,
    PBR_HAS_USE_ALPHA_ONLY_MR,
    PBR_HAS_ANISOTROPY,
    _setPbrLightExtension,
    _getPbrLightExtension,
    getLightTypeFeatureBits,
} from "./pbr-flags.js";
export {
    PBR_HAS_NORMAL_MAP,
    PBR_HAS_EMISSIVE,
    PBR_HAS_EMISSIVE_COLOR,
    PBR_HAS_ENV,
    PBR_HAS_SKELETON,
    PBR_HAS_TONEMAP,
    PBR_HAS_MORPH_TARGETS,
    PBR_HAS_ALPHA_BLEND,
    PBR_HAS_SPEC_GLOSS,
    PBR_HAS_DOUBLE_SIDED,
    PBR_HAS_COTANGENT_NORMAL,
    PBR_HAS_METALLIC_REFLECTANCE_MAP,
    PBR_HAS_REFLECTANCE_MAP,
    PBR_HAS_SKELETON_8,
    PBR_HAS_SPECULAR_AA,
    PBR_HAS_THIN_INSTANCES,
    PBR_HAS_INSTANCE_COLOR,
    PBR_HAS_SHEEN_TEXTURE,
    PBR_HAS_RECEIVE_SHADOWS,
    PBR_HAS_GAMMA_ALBEDO,
    PBR_HAS_OCCLUSION,
    PBR_HAS_CLEARCOAT,
    PBR_HAS_SHEEN,
    PBR_HAS_USE_ALPHA_ONLY_MR,
    PBR_HAS_ANISOTROPY,
    _setPbrLightExtension,
    _getPbrLightExtension,
    getLightTypeFeatureBits,
};

// ─── Feature detection ──────────────────────────────────────────────

/** Compute PBR feature bitmask from mesh capabilities + environment. */
export function computePbrFeatures(
    hasTangents: boolean,
    hasEmissive: boolean,
    hasEnv: boolean,
    hasSkeleton: boolean = false,
    hasTonemap: boolean = false,
    hasMorphTargets: boolean = false,
    hasAlphaBlend: boolean = false,
    hasSpecGloss: boolean = false,
    hasDoubleSided: boolean = false,
    hasNormalTexture: boolean = false,
    hasMetallicReflectanceMap: boolean = false,
    hasReflectanceMap: boolean = false,
    hasEmissiveColor: boolean = false
): number {
    let f = 0;
    if (hasTangents && hasNormalTexture) {
        f |= PBR_HAS_NORMAL_MAP;
    } else if (hasNormalTexture) {
        f |= PBR_HAS_COTANGENT_NORMAL;
    }
    // Compact flag accumulation — each pair: [condition, bit]
    const flags: [boolean, number][] = [
        [hasEmissive, PBR_HAS_EMISSIVE],
        [hasEmissiveColor, PBR_HAS_EMISSIVE_COLOR],
        [hasEnv, PBR_HAS_ENV],
        [hasSkeleton, PBR_HAS_SKELETON],
        [hasTonemap, PBR_HAS_TONEMAP],
        [hasMorphTargets, PBR_HAS_MORPH_TARGETS],
        [hasAlphaBlend, PBR_HAS_ALPHA_BLEND],
        [hasSpecGloss, PBR_HAS_SPEC_GLOSS],
        [hasDoubleSided, PBR_HAS_DOUBLE_SIDED],
        [hasMetallicReflectanceMap, PBR_HAS_METALLIC_REFLECTANCE_MAP],
        [hasReflectanceMap, PBR_HAS_REFLECTANCE_MAP],
    ];
    for (const [cond, bit] of flags) {
        if (cond) {
            f |= bit;
        }
    }
    return f;
}

// ─── Pipeline Variant ───────────────────────────────────────────────

export interface PbrPipelineVariant {
    features: number;
    pipeline: GPURenderPipeline;
    sceneBGL: GPUBindGroupLayout;
    meshBGL: GPUBindGroupLayout;
    shadowBGL: GPUBindGroupLayout | null;
    refCount: number;
}

// ─── Scene BGL (shared) ─────────────────────────────────────────────

// Re-export from shared scene-helpers for backward compatibility
export { getSceneBindGroupLayout as createSceneBindGroupLayout } from "../../render/scene-helpers.js";

// ─── Pipeline Cache ─────────────────────────────────────────────────

const cache: PipelineCache<PbrPipelineVariant> = createPipelineCache();

/** Clear the pipeline cache. Must be called when a GPU device is destroyed. */
export function clearPbrPipelineCache(): void {
    cache.clear();
}

export function releasePbrPipelineVariant(variant: PbrPipelineVariant): void {
    releaseVariant(variant);
    cache.evictUnused();
}

function cacheKey(features: number, format: GPUTextureFormat, msaa: number): string {
    return `pbr:${features}:${format}:${msaa}`;
}

export function getOrCreatePbrPipeline(
    device: GPUDevice,
    format: GPUTextureFormat,
    msaaSamples: number,
    features: number,
    sceneBGL: GPUBindGroupLayout,
    composed: ComposedShader
): PbrPipelineVariant {
    cache.ensureDevice(device);
    const key = cacheKey(features, format, msaaSamples);
    const cached = cache.getOrIncRef(key);
    if (cached) {
        return cached;
    }

    const hasAlpha = (features & PBR_HAS_ALPHA_BLEND) !== 0;
    const hasDoubleSided = (features & PBR_HAS_DOUBLE_SIDED) !== 0;

    // BGLs from composer output
    const meshBGL = device.createBindGroupLayout({ label: `pbr-mesh-f${features}`, ...composed.meshBGLDescriptor });

    let shadowBGL: GPUBindGroupLayout | null = null;
    const bgls: GPUBindGroupLayout[] = [sceneBGL, meshBGL];
    if (composed.shadowBGLDescriptor) {
        shadowBGL = device.createBindGroupLayout({ label: `pbr-shadow-f${features}`, ...composed.shadowBGLDescriptor });
        bgls.push(shadowBGL);
    }

    // Shader modules from composer output
    const vertModule = device.createShaderModule({ code: composed.vertexWGSL, label: `pbr-vert-f${features}` });
    const fragModule = device.createShaderModule({ code: composed.fragmentWGSL, label: `pbr-frag-f${features}` });

    const fragTarget: GPUColorTargetState = { format, writeMask: GPUColorWrite.ALL };
    if (hasAlpha) {
        fragTarget.blend = {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
        };
    }

    const pipeline = device.createRenderPipeline({
        label: `pbr-pipeline-f${features}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: bgls }),
        vertex: { module: vertModule, entryPoint: "main", buffers: composed.vertexBufferLayouts },
        fragment: { module: fragModule, entryPoint: "main", targets: [fragTarget] },
        depthStencil: { format: "depth24plus-stencil8", depthCompare: "less-equal", depthWriteEnabled: !hasAlpha },
        multisample: { count: msaaSamples },
        primitive: { topology: "triangle-list", cullMode: hasDoubleSided ? ("none" as GPUCullMode) : "back", frontFace: "ccw" },
    });

    const variant: PbrPipelineVariant = { features, pipeline, sceneBGL, meshBGL, shadowBGL, refCount: 1 };
    cache.set(key, variant);
    return variant;
}

// ─── Per-Mesh Bind Group ────────────────────────────────────────────

export function createPbrMeshBindGroup(
    device: GPUDevice,
    variant: PbrPipelineVariant,
    meshUBO: GPUBuffer,
    material: PbrMaterialProps,
    env: EnvironmentTextures | null,
    boneTextureView?: GPUTextureView,
    morphTargetView?: GPUTextureView,
    morphWeightsBuffer?: GPUBuffer,
    lightsUBO?: GPUBuffer
): GPUBindGroup {
    const features = variant.features;
    const hasNormal = (features & PBR_HAS_NORMAL_MAP) !== 0;
    const hasCotangentNormal = (features & PBR_HAS_COTANGENT_NORMAL) !== 0;
    const hasAnyNormal = hasNormal || hasCotangentNormal;
    const hasEmissive = (features & PBR_HAS_EMISSIVE) !== 0;
    const hasEnv = (features & PBR_HAS_ENV) !== 0;
    const hasSkeleton = (features & PBR_HAS_SKELETON) !== 0;
    const hasMorph = (features & PBR_HAS_MORPH_TARGETS) !== 0;
    const hasSpecGloss = (features & PBR_HAS_SPEC_GLOSS) !== 0;

    const entries: GPUBindGroupEntry[] = [];
    let b = 0;
    const addTex = (t: { view: GPUTextureView; sampler: GPUSampler }) => {
        entries.push({ binding: b++, resource: t.view });
        entries.push({ binding: b++, resource: t.sampler });
    };

    // Mesh UBO (binding 0)
    entries.push({ binding: b++, resource: { buffer: meshUBO } });
    // Vertex bindings: morph before skeleton (alphabetical order matching composer)
    if (hasMorph) {
        entries.push({ binding: b++, resource: morphTargetView! });
        entries.push({ binding: b++, resource: { buffer: morphWeightsBuffer! } });
    }
    if (hasSkeleton) {
        entries.push({ binding: b++, resource: boneTextureView! });
    }
    // Base bindings (matching composer order: baseColor, normal, ORM, emissive, specGloss, sheen)
    addTex(material.baseColorTexture!);
    if (hasAnyNormal) {
        addTex(material.normalTexture!);
    }
    addTex(material.ormTexture!);
    if (hasEmissive) {
        addTex(material.emissiveTexture!);
    }
    if (hasSpecGloss) {
        addTex(material.specGlossTexture!);
    }
    if ((features & PBR_HAS_SHEEN_TEXTURE) !== 0) {
        addTex((material.sheen as SheenProps).texture!);
    }
    // Lights UBO (after base texture bindings, before fragment bindings — matches composer order)
    if (lightsUBO) {
        entries.push({ binding: b++, resource: { buffer: lightsUBO } });
    }
    // Fragment bindings: IBL (comes before reflectance in composer's alphabetical order)
    if (hasEnv && env) {
        entries.push({ binding: b++, resource: env.brdfLutView });
        entries.push({ binding: b++, resource: env.brdfSampler });
        entries.push({ binding: b++, resource: env.specularCubeView });
        entries.push({ binding: b++, resource: env.cubeSampler });
    }
    // Fragment bindings: reflectance maps (after IBL in alphabetical order)
    if ((features & (PBR_HAS_METALLIC_REFLECTANCE_MAP | PBR_HAS_REFLECTANCE_MAP)) !== 0) {
        if (material.metallicReflectanceTexture) {
            addTex(material.metallicReflectanceTexture);
        }
        if (material.reflectanceTexture) {
            addTex(material.reflectanceTexture);
        }
    }

    return device.createBindGroup({ layout: variant.meshBGL, entries });
}
