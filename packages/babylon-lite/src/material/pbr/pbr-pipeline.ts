/** Dynamic PBR pipeline builder — creates and caches GPU render pipelines
 *  based on per-mesh PBR feature flags + ComposedShader from the fragment system.
 *
 *  Pipelines cached per (fragmentKey, features, format, msaaSamples) tuple.
 *  The ComposedShader provides WGSL source, BGL descriptors, and vertex layouts. */

import type { PbrMaterialProps } from "./pbr-material.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";
import type { ComposedShader } from "../../shader/fragment-types.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import { createPipelineCache, releaseVariant } from "../pipeline-cache.js";
import type { PipelineCache } from "../pipeline-cache.js";
import { _getPbrLightExtension, _getPbrExtsSorted, PBR2_HAS_UV2 } from "./pbr-flags.js";
import { PBR_HAS_NORMAL_MAP, PBR_HAS_EMISSIVE, PBR_HAS_SPEC_GLOSS, PBR_HAS_DOUBLE_SIDED, PBR_HAS_COTANGENT_NORMAL, PBR_HAS_ALPHA_BLEND } from "./pbr-flags.js";
export * from "./pbr-flags.js";

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

let cache: PipelineCache<PbrPipelineVariant> | null = null;

function getCache(): PipelineCache<PbrPipelineVariant> {
    if (!cache) {
        cache = createPipelineCache();
    }
    return cache;
}

/** Clear the pipeline cache. Must be called when a GPU device is destroyed. */
export function clearPbrPipelineCache(): void {
    cache?.clear();
}

export function releasePbrPipelineVariant(variant: PbrPipelineVariant): void {
    releaseVariant(variant);
    cache?.evictUnused();
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
    const c = getCache();
    c.ensureDevice(engine);
    const key = cacheKey(features, features2, format, msaaSamples);
    const cached = c.getOrIncRef(key);
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
    c.set(key, variant);
    return variant;
}

// ─── Per-Mesh Bind Group ────────────────────────────────────────────

export function createPbrMeshBindGroup(
    engine: EngineContextInternal,
    variant: PbrPipelineVariant,
    composed: ComposedShader,
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
    if ((features2 & PBR2_HAS_UV2) !== 0 && material.occlusionTexture) {
        addTex(material.occlusionTexture);
    }
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

    return device.createBindGroup({ layout: variant.meshBGL, entries });
}
