/** Dynamic PBR pipeline builder — creates and caches GPU render pipelines
 *  based on per-mesh PBR feature flags + ComposedShader from the fragment system.
 *
 *  Pipelines cached per (fragmentKey, features, format, msaaSamples) tuple.
 *  The ComposedShader provides WGSL source, BGL descriptors, and vertex layouts. */

import type { PbrMaterialProps, SheenProps } from "./pbr-material.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";
import type { ComposedShader } from "../../shader/fragment-types.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import { createPipelineCache, releaseVariant } from "../pipeline-cache.js";
import type { PipelineCache } from "../pipeline-cache.js";
import { _getPbrLightExtension, _getPbrExts } from "./pbr-flags.js";
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
    PBR_HAS_SHEEN_TEXTURE,
} from "./pbr-flags.js";
export * from "./pbr-flags.js";

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
    return (
        (hasNormalTexture ? (hasTangents ? PBR_HAS_NORMAL_MAP : PBR_HAS_COTANGENT_NORMAL) : 0) |
        (hasEmissive ? PBR_HAS_EMISSIVE : 0) |
        (hasEmissiveColor ? PBR_HAS_EMISSIVE_COLOR : 0) |
        (hasEnv ? PBR_HAS_ENV : 0) |
        (hasSkeleton ? PBR_HAS_SKELETON : 0) |
        (hasTonemap ? PBR_HAS_TONEMAP : 0) |
        (hasMorphTargets ? PBR_HAS_MORPH_TARGETS : 0) |
        (hasAlphaBlend ? PBR_HAS_ALPHA_BLEND : 0) |
        (hasSpecGloss ? PBR_HAS_SPEC_GLOSS : 0) |
        (hasDoubleSided ? PBR_HAS_DOUBLE_SIDED : 0) |
        (hasMetallicReflectanceMap ? PBR_HAS_METALLIC_REFLECTANCE_MAP : 0) |
        (hasReflectanceMap ? PBR_HAS_REFLECTANCE_MAP : 0)
    );
}

// ─── Pipeline Variant ───────────────────────────────────────────────

export interface PbrPipelineVariant {
    features: number;
    features2: number;
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

function cacheKey(features: number, features2: number, format: GPUTextureFormat, msaa: number): string {
    return `pbr:${features}:${features2}:${format}:${msaa}`;
}

export function getOrCreatePbrPipeline(
    engine: EngineContextInternal,
    format: GPUTextureFormat,
    msaaSamples: number,
    features: number,
    features2: number,
    sceneBGL: GPUBindGroupLayout,
    composed: ComposedShader
): PbrPipelineVariant {
    const device = engine.device;
    cache.ensureDevice(engine);
    const key = cacheKey(features, features2, format, msaaSamples);
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

    const variant: PbrPipelineVariant = { features, features2, pipeline, sceneBGL, meshBGL, shadowBGL, refCount: 1 };
    cache.set(key, variant);
    return variant;
}

// ─── Per-Mesh Bind Group ────────────────────────────────────────────

export function createPbrMeshBindGroup(
    engine: EngineContextInternal,
    variant: PbrPipelineVariant,
    meshUBO: GPUBuffer,
    materialUBO: GPUBuffer,
    material: PbrMaterialProps,
    env: EnvironmentTextures | null,
    meshCtx: { skeleton?: { boneTexture: GPUTexture } | null; morphTargets?: { texture: GPUTexture; weightsBuffer?: GPUBuffer } | null } | null,
    lightsUBO?: GPUBuffer
): GPUBindGroup {
    const device = engine.device;
    const features = variant.features;
    const features2 = variant.features2;
    const hasNormal = (features & PBR_HAS_NORMAL_MAP) !== 0;
    const hasCotangentNormal = (features & PBR_HAS_COTANGENT_NORMAL) !== 0;
    const hasAnyNormal = hasNormal || hasCotangentNormal;
    const hasEmissive = (features & PBR_HAS_EMISSIVE) !== 0;
    const hasSpecGloss = (features & PBR_HAS_SPEC_GLOSS) !== 0;

    const entries: GPUBindGroupEntry[] = [];
    let b = 0;
    const addTex = (t: { view: GPUTextureView; sampler: GPUSampler }) => {
        entries.push({ binding: b++, resource: t.view });
        entries.push({ binding: b++, resource: t.sampler });
    };

    const ctx: import("./pbr-flags.js").PbrBindCtx = {
        features,
        features2,
        material,
        mesh: meshCtx ?? undefined,
        env,
    };

    // Sort exts by id to match composer's alphabetical binding emission order.
    const sortedExts = Array.from(_getPbrExts().values()).sort((a, b) => a.id.localeCompare(b.id));

    // Mesh UBO (binding 0)
    entries.push({ binding: b++, resource: { buffer: meshUBO } });
    // Material UBO (binding 1)
    entries.push({ binding: b++, resource: { buffer: materialUBO } });
    // Vertex-phase exts (morph before skeleton via alphabetical composer order)
    for (const ext of sortedExts) {
        if (ext.phase === "vertex" && ext.bind) {
            b = ext.bind(ctx, entries, b);
        }
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
    // Base-tex phase exts (alphabetical: clearcoat < reflectance < ...).
    for (const ext of sortedExts) {
        if (ext.phase === "base-tex" && ext.bind) {
            b = ext.bind(ctx, entries, b);
        }
    }
    // Lights UBO (after base texture bindings, before fragment bindings — matches composer order)
    if (lightsUBO) {
        entries.push({ binding: b++, resource: { buffer: lightsUBO } });
    }
    // IBL-phase exts (alphabetical within phase).
    for (const ext of sortedExts) {
        if (ext.phase === "ibl" && ext.bind) {
            b = ext.bind(ctx, entries, b);
        }
    }
    for (const ext of sortedExts) {
        if (ext.phase === "fragment" && ext.bind) {
            b = ext.bind(ctx, entries, b);
        }
    }

    return device.createBindGroup({ layout: variant.meshBGL, entries });
}
