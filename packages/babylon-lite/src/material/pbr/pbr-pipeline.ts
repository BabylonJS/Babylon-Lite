/** Dynamic PBR pipeline builder — creates and caches GPU render pipelines
 *  based on per-mesh PBR feature flags + ComposedShader from the fragment system.
 *
 *  Two-tier cache:
 *   - Shader bindings (BGLs + composed shader + per-sig pipeline cache) keyed by
 *     `(features, features2)`. Sig-independent.
 *   - Pipelines live inside each `_PbrShaderBindings`, keyed by `targetSignatureKey(sig)`.
 */

import type { PbrMaterialProps } from "./pbr-material.js";
import type { EnvironmentTextures } from "../../loader-env/load-env.js";
import type { ComposedShader } from "../../shader/fragment-types.js";
import type { EngineContextInternal } from "../../engine/engine.js";
import type { RenderTargetSignature } from "../../engine/render-target.js";
import type { Texture2D } from "../../texture/texture-2d.js";
import type { _PbrBindCtx, PbrExt } from "./pbr-flags.js";
import { _getPbrExtsSorted, PBR2_ESM_SHADOW_OUTPUT, PBR2_NO_COLOR_OUTPUT, PBR2_HAS_UV2 } from "./pbr-flags.js";
import { PBR_HAS_NORMAL_MAP, PBR_HAS_EMISSIVE, PBR_HAS_SPEC_GLOSS, PBR_HAS_DOUBLE_SIDED, PBR_HAS_ALPHA_BLEND } from "./pbr-flags.js";
import { MSH_HAS_TANGENTS, MSH_HAS_UV2 } from "../mesh-features.js";
import { targetSignatureKey } from "../../engine/render-target.js";
import { getSceneBindGroupLayout } from "../../render/scene-helpers.js";

// ─── Shader Bindings (sig-independent) ──────────────────────────────

interface _PbrShaderBindings {
    _features: number;
    _features2: number;
    _meshFeatures: number;
    _meshBGL: GPUBindGroupLayout;
    _shadowBGL: GPUBindGroupLayout | null;
    _composed: ComposedShader;
    /** Per-sig pipeline cache. Key = `targetSignatureKey(sig)`. */
    _pipelines: Map<string, GPURenderPipeline>;
}

// ─── Caches ─────────────────────────────────────────────────────────

const _bindingsCache = new Map<string, _PbrShaderBindings>();
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
export function getOrCreatePbrBindings(
    engine: EngineContextInternal,
    features: number,
    features2: number,
    meshFeatures: number,
    sceneFeatures: number,
    composed: ComposedShader,
    shaderKey = ""
): _PbrShaderBindings {
    ensureDevice(engine);
    const key = `${features}:${features2}:${meshFeatures}:${sceneFeatures}:${shaderKey}`;
    const cached = _bindingsCache.get(key);
    if (cached) {
        return cached;
    }

    const device = engine.device;
    const meshBGL = device.createBindGroupLayout(composed._meshBGLDescriptor);
    let shadowBGL: GPUBindGroupLayout | null = null;
    if (composed._shadowBGLDescriptor) {
        shadowBGL = device.createBindGroupLayout(composed._shadowBGLDescriptor);
    }
    const bindings: _PbrShaderBindings = {
        _features: features,
        _features2: features2,
        _meshFeatures: meshFeatures,
        _meshBGL: meshBGL,
        _shadowBGL: shadowBGL,
        _composed: composed,
        _pipelines: new Map(),
    };
    _bindingsCache.set(key, bindings);
    return bindings;
}

/** Get-or-build the sig-specific pipeline on top of a PBR shader bindings. Called at bind() time. */
export function getOrCreatePbrPipeline(engine: EngineContextInternal, sig: RenderTargetSignature, bindings: _PbrShaderBindings): GPURenderPipeline {
    ensureDevice(engine);
    const key = targetSignatureKey(sig);
    const cached = bindings._pipelines.get(key);
    if (cached) {
        return cached;
    }

    const device = engine.device;
    const { _features: features, _features2: features2, _composed: composed } = bindings;
    const esmShadowOutput = (features2 & PBR2_ESM_SHADOW_OUTPUT) !== 0;
    const hasAlpha = !esmShadowOutput && (features & PBR_HAS_ALPHA_BLEND) !== 0;
    const hasDoubleSided = (features & PBR_HAS_DOUBLE_SIDED) !== 0;

    const sceneBGL = getSceneBindGroupLayout(engine);
    const bgls: GPUBindGroupLayout[] = bindings._shadowBGL ? [sceneBGL, bindings._meshBGL, bindings._shadowBGL] : [sceneBGL, bindings._meshBGL];

    const vertModule = device.createShaderModule({ code: composed._vertexWGSL });
    const noColorOutput = (features2 & PBR2_NO_COLOR_OUTPUT) !== 0;
    const fragModule = !sig.colorFormat && !noColorOutput ? null : device.createShaderModule({ code: composed._fragmentWGSL });

    const fragTarget: GPUColorTargetState | null = noColorOutput ? null : { format: sig.colorFormat!, writeMask: GPUColorWrite.ALL };
    if (hasAlpha && fragTarget) {
        fragTarget.blend = {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
        };
    }

    const pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: bgls }),
        vertex: { module: vertModule, entryPoint: "main", buffers: composed._vertexBufferLayouts },
        ...(fragModule ? { fragment: { module: fragModule, entryPoint: "main", targets: fragTarget ? [fragTarget] : [] } } : {}),
        ...(sig.depthStencilFormat
            ? {
                  depthStencil: {
                      format: sig.depthStencilFormat,
                      depthCompare: "less-equal" as GPUCompareFunction,
                      depthWriteEnabled: noColorOutput || esmShadowOutput || !hasAlpha,
                  },
              }
            : {}),
        multisample: { count: sig.sampleCount },
        primitive: { topology: "triangle-list", cullMode: hasDoubleSided ? ("none" as GPUCullMode) : "back", frontFace: sig.flipY ? "cw" : "ccw" },
    });
    bindings._pipelines.set(key, pipeline);
    return pipeline;
}

// ─── Per-Mesh Bind Group ────────────────────────────────────────────

export function createPbrMeshBindGroup(
    engine: EngineContextInternal,
    bindings: _PbrShaderBindings,
    composed: ComposedShader,
    meshUBO: GPUBuffer,
    materialUBO: GPUBuffer,
    material: PbrMaterialProps,
    env: EnvironmentTextures | null,
    meshCtx: { skeleton?: { boneTexture: GPUTexture } | null; morphTargets?: { texture: GPUTexture; weightsBuffer?: GPUBuffer } | null } | null,
    refractionTexture?: Texture2D | null
): GPUBindGroup {
    const device = engine.device;
    const features = bindings._features;
    const features2 = bindings._features2;
    const meshFeatures = bindings._meshFeatures;
    const hasNormal = (features & PBR_HAS_NORMAL_MAP) !== 0 && (meshFeatures & MSH_HAS_TANGENTS) !== 0;
    const hasCotangentNormal = (features & PBR_HAS_NORMAL_MAP) !== 0 && (meshFeatures & MSH_HAS_TANGENTS) === 0;
    const hasAnyNormal = hasNormal || hasCotangentNormal;
    const hasEmissive = (features & PBR_HAS_EMISSIVE) !== 0;
    const hasSpecGloss = (features & PBR_HAS_SPEC_GLOSS) !== 0;
    const esmShadowOutput = (features2 & PBR2_ESM_SHADOW_OUTPUT) !== 0;

    const entries: GPUBindGroupEntry[] = [];
    let b = 0;
    const addTex = (t: { view: GPUTextureView; sampler: GPUSampler }) => {
        entries.push({ binding: b++, resource: t.view });
        entries.push({ binding: b++, resource: t.sampler });
    };

    const ctx: _PbrBindCtx = {
        _engine: engine,
        _features: features,
        _features2: features2,
        _meshFeatures: meshFeatures,
        _material: material,
        _mesh: meshCtx ?? undefined,
        _env: env,
        _refractionTexture: refractionTexture,
    };

    const sortedExts = _getPbrExtsSorted();

    const fragIds = composed._fragmentKey ? composed._fragmentKey.split("|").filter((s) => s.length > 0) : [];

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
    if ((features2 & PBR2_HAS_UV2) !== 0 && (meshFeatures & MSH_HAS_UV2) !== 0 && material.occlusionTexture) {
        addTex(material.occlusionTexture);
    }
    if (hasEmissive) {
        addTex(material.emissiveTexture!);
    }
    if (hasSpecGloss) {
        addTex(material.specGlossTexture!);
    }
    if (esmShadowOutput) {
        entries.push({
            binding: b++,
            resource: { buffer: (material as PbrMaterialProps & { readonly _esmShadowParamsUBO: GPUBuffer })._esmShadowParamsUBO },
        });
    }
    const seenExts: PbrExt[] = [];
    for (const fid of fragIds) {
        const ext = sortedExts.find((e) => e.id === fid || fid.startsWith(e.id + "-"));
        if (!ext || ext.phase === "vertex" || !ext.bind || seenExts.includes(ext)) {
            continue;
        }
        seenExts.push(ext);
        b = ext.bind(ctx, entries, b);
    }

    return device.createBindGroup({ layout: bindings._meshBGL, entries });
}
