/** Dynamic PBR pipeline builder — creates and caches GPU render pipelines
 *  based on per-mesh PBR feature flags + ComposedShader from the fragment system.
 *
 *  Pipelines cached per (fragmentKey, features, format, msaaSamples) tuple.
 *  The ComposedShader provides WGSL source, BGL descriptors, and vertex layouts. */

import type { PbrMaterialProps } from "./pbr-material.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";
import type { ComposedShader } from "../../shader/fragment-types.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { RenderTargetSignature } from "../../render/renderable.js";
import { createPipelineCache, releaseVariant } from "../pipeline-cache.js";
import type { PipelineCache } from "../pipeline-cache.js";
import { targetSignatureKey } from "../../engine/render-target.js";
import { _getPbrExtsSorted } from "./pbr-flags.js";
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

/**
 * Target-independent PBR material bindings — shaders, BGLs, feature key.
 * Cached by (features, features2) only. A single bindings instance can produce
 * multiple GPURenderPipelines, one per render-target signature the material is
 * drawn into — stored in the `pipelines` child map and keyed by
 * `targetSignatureKey(target)`.
 */
export interface PbrBindings {
    features: number;
    features2: number;
    composed: ComposedShader;
    meshBGL: GPUBindGroupLayout;
    shadowBGL: GPUBindGroupLayout | null;
    /** Target-specific pipelines. Lifetime follows the bindings. */
    pipelines: Map<string, GPURenderPipeline>;
    refCount: number;
}

// ─── Scene BGL (shared) ─────────────────────────────────────────────

import { getSceneBindGroupLayout } from "../../render/scene-helpers.js";

// ─── Bindings Cache ─────────────────────────────────────────────────

const bindingsCache: PipelineCache<PbrBindings> = createPipelineCache();

/** Clear the PBR bindings cache (and the child pipelines). Must be called when a GPU device is destroyed. */
export function clearPbrPipelineCache(): void {
    bindingsCache.clear();
}

export function releasePbrBindings(bindings: PbrBindings): void {
    releaseVariant(bindings);
    bindingsCache.evictUnused();
}

function bindingsCacheKey(features: number, features2: number): string {
    return `pbrbindings:${features}:${features2}`;
}

/**
 * Get or create target-independent PBR bindings (shaders + BGLs) for a feature set.
 * Does NOT create a render pipeline — call getOrCreatePbrPipeline(bindings, target) for that.
 */
export function getOrCreatePbrBindings(engine: EngineContextInternal, features: number, features2: number, composed: ComposedShader): PbrBindings {
    const device = engine.device;
    bindingsCache.ensureDevice(engine);
    const key = bindingsCacheKey(features, features2);
    const cached = bindingsCache.getOrIncRef(key);
    if (cached) {
        return cached;
    }

    const meshBGL = device.createBindGroupLayout({ label: `pbr-mesh-f${features}`, ...composed.meshBGLDescriptor });

    let shadowBGL: GPUBindGroupLayout | null = null;
    if (composed.shadowBGLDescriptor) {
        shadowBGL = device.createBindGroupLayout({ label: `pbr-shadow-f${features}`, ...composed.shadowBGLDescriptor });
    }

    const bindings: PbrBindings = {
        features,
        features2,
        composed,
        meshBGL,
        shadowBGL,
        pipelines: new Map(),
        refCount: 1,
    };
    bindingsCache.set(key, bindings);
    return bindings;
}

/**
 * Get or create a GPURenderPipeline for the given bindings and render-target signature.
 * Pipelines live on the bindings object (no separate cache) — their lifetime follows
 * the bindings'. The pipeline is created lazily per unique target signature the material
 * is drawn into.
 */
export function getOrCreatePbrPipeline(engine: EngineContextInternal, bindings: PbrBindings, target: RenderTargetSignature): GPURenderPipeline {
    const key = targetSignatureKey(target);
    const existing = bindings.pipelines.get(key);
    if (existing) {
        return existing;
    }

    const device = engine.device;
    const { features, composed, meshBGL, shadowBGL } = bindings;
    const hasAlpha = (features & PBR_HAS_ALPHA_BLEND) !== 0;
    const hasDoubleSided = (features & PBR_HAS_DOUBLE_SIDED) !== 0;

    const bgls: GPUBindGroupLayout[] = [getSceneBindGroupLayout(engine), meshBGL];
    if (shadowBGL) {
        bgls.push(shadowBGL);
    }

    const vertModule = device.createShaderModule({ code: composed.vertexWGSL, label: `pbr-vert-f${features}` });
    const fragModule = device.createShaderModule({ code: composed.fragmentWGSL, label: `pbr-frag-f${features}` });

    const fragTarget: GPUColorTargetState = { format: target.colorFormat, writeMask: GPUColorWrite.ALL };
    if (hasAlpha) {
        fragTarget.blend = {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
        };
    }

    const pipelineDesc: GPURenderPipelineDescriptor = {
        label: `pbr-pipeline-f${features}-${key}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: bgls }),
        vertex: { module: vertModule, entryPoint: "main", buffers: composed.vertexBufferLayouts },
        fragment: { module: fragModule, entryPoint: "main", targets: [fragTarget] },
        multisample: { count: target.sampleCount },
        primitive: { topology: "triangle-list", cullMode: hasDoubleSided ? ("none" as GPUCullMode) : "back", frontFace: target.flipY ? "cw" : "ccw" },
    };
    if (target.depthStencilFormat) {
        pipelineDesc.depthStencil = { format: target.depthStencilFormat, depthCompare: "less-equal", depthWriteEnabled: !hasAlpha };
    }

    const pipeline = device.createRenderPipeline(pipelineDesc);
    bindings.pipelines.set(key, pipeline);
    return pipeline;
}

// ─── Per-Mesh Bind Group ────────────────────────────────────────────

export function createPbrMeshBindGroup(
    engine: EngineContextInternal,
    bindings: PbrBindings,
    composed: ComposedShader,
    meshUBO: GPUBuffer,
    materialUBO: GPUBuffer,
    material: PbrMaterialProps,
    env: EnvironmentTextures | null,
    meshCtx: { skeleton?: { boneTexture: GPUTexture } | null; morphTargets?: { texture: GPUTexture; weightsBuffer?: GPUBuffer } | null } | null,
    lightsUBO?: GPUBuffer
): GPUBindGroup {
    const device = engine.device;
    const features = bindings.features;
    const features2 = bindings.features2;
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
    const sortedExts = _getPbrExtsSorted();

    // Build fragment-id → ext map that honours fragment-id variants like
    // "clearcoat-IRN" (ext id "clearcoat"). Walk composed.fragmentKey to
    // determine composer's topological binding order.
    const extByFragId = new Map<string, import("./pbr-flags.js").PbrExt>();
    const fragIds = composed.fragmentKey ? composed.fragmentKey.split("|").filter((s) => s.length > 0) : [];
    for (const fid of fragIds) {
        let match = sortedExts.find((e) => e.id === fid);
        if (!match) {
            match = sortedExts.find((e) => fid.startsWith(e.id + "-"));
        }
        if (match) {
            extByFragId.set(fid, match);
        }
    }

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
    // Base bindings (matching composer order: baseColor, normal, ORM, emissive, specGloss)
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
    // Lights UBO (after base texture bindings, before fragment bindings — matches composer order)
    if (lightsUBO) {
        entries.push({ binding: b++, resource: { buffer: lightsUBO } });
    }
    // Non-vertex exts — iterate in composer's topological order (from
    // composed.fragmentKey) so bind entries align with the emitted BGL.
    const seenExts = new Set<import("./pbr-flags.js").PbrExt>();
    for (const fid of fragIds) {
        const ext = extByFragId.get(fid);
        if (!ext || ext.phase === "vertex" || !ext.bind || seenExts.has(ext)) {
            continue;
        }
        seenExts.add(ext);
        b = ext.bind(ctx, entries, b);
    }

    return device.createBindGroup({ layout: bindings.meshBGL, entries });
}
