/** Dynamic PBR pipeline builder — creates and caches GPU render pipelines
 *  based on per-mesh PBR feature flags + ComposedShader from the fragment system.
 *
 *  Two-tier cache:
 *   - Shader bindings (BGLs + composed shader + per-sig pipeline cache) keyed by
 *     `(features, features2)`. Sig-independent.
 *   - Pipelines live inside each `PbrShaderBindings`, keyed by `targetSignatureKey(sig)`.
 */

import type { PbrMaterialProps } from "./pbr-material.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";
import type { ComposedShader } from "../../shader/fragment-types.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { RenderTargetSignature } from "../../engine/render-target.js";
import { _getPbrExtsSorted, PBR2_HAS_UV2 } from "./pbr-flags.js";
import { PBR_HAS_NORMAL_MAP, PBR_HAS_EMISSIVE, PBR_HAS_SPEC_GLOSS, PBR_HAS_DOUBLE_SIDED, PBR_HAS_COTANGENT_NORMAL, PBR_HAS_ALPHA_BLEND } from "./pbr-flags.js";
import { targetSignatureKey } from "../../engine/render-target.js";
import { getSceneBindGroupLayout } from "../../render/scene-helpers.js";
export * from "./pbr-flags.js";

// ─── Shader Bindings (sig-independent) ──────────────────────────────

export interface PbrShaderBindings {
    features: number;
    features2: number;
    meshBGL: GPUBindGroupLayout;
    shadowBGL: GPUBindGroupLayout | null;
    composed: ComposedShader;
    /** Per-sig pipeline cache. Key = `targetSignatureKey(sig)`. */
    pipelines: Map<string, GPURenderPipeline>;
}

// ─── Caches ─────────────────────────────────────────────────────────

const _bindingsCache = new Map<string, PbrShaderBindings>();
let _cachedDevice: GPUDevice | null = null;

function ensureDevice(engine: EngineContextInternal): void {
    if (_cachedDevice !== engine.device) {
        _bindingsCache.clear();
        _cachedDevice = engine.device;
    }
}

/** Clear the pipeline cache. Must be called when a GPU device is destroyed. */
export function clearPbrPipelineCache(): void {
    _bindingsCache.clear();
    _cachedDevice = null;
}

/** Get-or-build the sig-independent PBR shader bindings. Used at renderable build time
 *  so per-mesh bind groups can be created BEFORE any sig is known. */
export function getOrCreatePbrBindings(engine: EngineContextInternal, features: number, features2: number, composed: ComposedShader): PbrShaderBindings {
    ensureDevice(engine);
    const key = `${features}:${features2}`;
    const cached = _bindingsCache.get(key);
    if (cached) {
        return cached;
    }

    const device = engine.device;
    const meshBGL = device.createBindGroupLayout(composed.meshBGLDescriptor);
    let shadowBGL: GPUBindGroupLayout | null = null;
    if (composed.shadowBGLDescriptor) {
        shadowBGL = device.createBindGroupLayout(composed.shadowBGLDescriptor);
    }
    const bindings: PbrShaderBindings = { features, features2, meshBGL, shadowBGL, composed, pipelines: new Map() };
    _bindingsCache.set(key, bindings);
    return bindings;
}

/** Get-or-build the sig-specific pipeline on top of a PBR shader bindings. Called at bind() time. */
export function getOrCreatePbrPipeline(engine: EngineContextInternal, sig: RenderTargetSignature, bindings: PbrShaderBindings): GPURenderPipeline {
    ensureDevice(engine);
    const key = targetSignatureKey(sig);
    const cached = bindings.pipelines.get(key);
    if (cached) {
        return cached;
    }

    const device = engine.device;
    const { features, composed } = bindings;
    const hasAlpha = (features & PBR_HAS_ALPHA_BLEND) !== 0;
    const hasDoubleSided = (features & PBR_HAS_DOUBLE_SIDED) !== 0;

    const sceneBGL = getSceneBindGroupLayout(engine);
    const bgls: GPUBindGroupLayout[] = bindings.shadowBGL ? [sceneBGL, bindings.meshBGL, bindings.shadowBGL] : [sceneBGL, bindings.meshBGL];

    const vertModule = device.createShaderModule({ code: composed.vertexWGSL });
    const fragModule = device.createShaderModule({ code: composed.fragmentWGSL });

    const fragTarget: GPUColorTargetState = { format: sig.colorFormat, writeMask: GPUColorWrite.ALL };
    if (hasAlpha) {
        fragTarget.blend = {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
        };
    }

    const pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: bgls }),
        vertex: { module: vertModule, entryPoint: "main", buffers: composed.vertexBufferLayouts },
        fragment: { module: fragModule, entryPoint: "main", targets: [fragTarget] },
        ...(sig.depthStencilFormat ? { depthStencil: { format: sig.depthStencilFormat, depthCompare: "less-equal" as GPUCompareFunction, depthWriteEnabled: !hasAlpha } } : {}),
        multisample: { count: sig.sampleCount },
        primitive: { topology: "triangle-list", cullMode: hasDoubleSided ? ("none" as GPUCullMode) : "back", frontFace: sig.flipY ? "cw" : "ccw" },
    });
    bindings.pipelines.set(key, pipeline);
    return pipeline;
}

// ─── Per-Mesh Bind Group ────────────────────────────────────────────

export function createPbrMeshBindGroup(
    engine: EngineContextInternal,
    bindings: PbrShaderBindings,
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

    const sortedExts = _getPbrExtsSorted();

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

    entries.push({ binding: b++, resource: { buffer: meshUBO } });
    entries.push({ binding: b++, resource: { buffer: materialUBO } });
    for (const ext of sortedExts) {
        if (ext.phase === "vertex" && ext.bind) {
            b = ext.bind(ctx, entries, b);
        }
    }
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
    if (lightsUBO) {
        entries.push({ binding: b++, resource: { buffer: lightsUBO } });
    }
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
