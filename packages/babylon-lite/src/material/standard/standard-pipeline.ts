/** Dynamic StandardMaterial pipeline builder — creates and caches GPU render
 *  pipelines based on per-material feature flags.
 *
 *  Feature flags (bitmask):
 *    HAS_DIFFUSE_TEXTURE  — diffuse texture sampling + UV attribute
 *    HAS_EMISSIVE_TEXTURE — emissive texture sampling + UV attribute
 *  Derived flag (computed automatically):
 *    NEEDS_UV = HAS_DIFFUSE_TEXTURE | HAS_EMISSIVE_TEXTURE
 *
 *  Pipelines are cached per (features, format, msaaSamples) tuple.
 *  Shared scene UBO layout is identical across all variants (176 bytes). */

import { F32 } from "../../engine/typed-arrays.js";
import type { EngineContext } from "../../engine/engine.js";
import type { RenderTargetSignature } from "../../engine/render-target.js";
import type { StandardMaterialProps } from "./standard-material.js";
import { _standardFeatureKey } from "./standard-material.js";
import { getSceneBindGroupLayout, clearSceneBGLCache } from "../../render/scene-helpers.js";
import { createStandardTemplate } from "./standard-template.js";
import { composeShader } from "../../shader/shader-composer.js";
import type { ComposedShader, ShaderFragment } from "../../shader/fragment-types.js";
import { createUniformBuffer } from "../../resource/gpu-buffers.js";
import { REVERSE_DEPTH_COMPARE, targetSignatureKey } from "../../engine/render-target.js";
import {
    DIFFUSE_USES_UV2,
    DISABLE_LIGHTING,
    DOUBLE_SIDED,
    HAS_DIFFUSE_TEXTURE,
    HAS_OPACITY_TEXTURE,
    MATERIAL_ALPHA_BLEND,
    NEEDS_UV,
    NEEDS_UV2,
    NO_COLOR_OUTPUT,
    ESM_SHADOW_OUTPUT,
    _getStdExtsSorted,
} from "./standard-flags.js";
import { MSH_RECEIVE_SHADOWS } from "../mesh-features.js";

// ─── Composer Path (Phase 1) ────────────────────────────────────────
// Converts feature bitmask → StandardTemplateConfig → ComposedShader.
// This produces identical WGSL to the old string-builder path but via
// the generic composer, enabling fragment-based extensions in Phase 2.

/** Compose Standard shader via the generic ShaderComposer.
 *  @param fragments - Optional extra fragments (e.g. thin-instance). */
export function composeStandardShader(features: number, _meshFeatures = 0, fragments: ShaderFragment[] = [], esmShadowDepthCode = ""): ComposedShader {
    const has = (bit: number) => (features & bit) !== 0;
    const template = createStandardTemplate(
        {
            _diffuse: has(HAS_DIFFUSE_TEXTURE),
            _needsUV: has(NEEDS_UV),
            _needsUV2: has(NEEDS_UV2),
            _diffuseUsesUV2: has(DIFFUSE_USES_UV2),
            _disableLighting: has(DISABLE_LIGHTING),
            _noColorOutput: has(NO_COLOR_OUTPUT),
            _esmShadowOutput: has(ESM_SHADOW_OUTPUT),
        },
        esmShadowDepthCode
    );
    return composeShader(template, fragments);
}

// ─── Shader Bindings (sig-independent) ──────────────────────────────

/** Cached per-(features, fragments) shader bindings: BGLs + composed shader +
 *  per-sig pipeline cache. Created once at renderable build time, shared across
 *  all sig-specific pipelines. */
export interface StandardShaderBindings {
    /** @internal */
    _features: number;
    /** @internal */
    _meshFeatures: number;
    /** @internal */
    _meshBGL: GPUBindGroupLayout;
    /** @internal */
    _shadowBGL: GPUBindGroupLayout | null;
    /** @internal */
    _composed: ComposedShader;
    /** @internal Per-sig pipeline cache. Key = `targetSignatureKey(sig)`. */
    _pipelines: Map<string, GPURenderPipeline>;
}

// ─── Caches ─────────────────────────────────────────────────────────

/** Per-(features:fk) shader bindings cache (sig-independent). */
const _bindingsCache = new Map<string, StandardShaderBindings>();
let _composedCache: Map<string, ComposedShader> | null = null;
let _cachedDevice: GPUDevice | null = null;

function getComposedCache(): Map<string, ComposedShader> {
    if (!_composedCache) {
        _composedCache = new Map();
    }
    return _composedCache;
}

function ensureDevice(engine: EngineContext): void {
    if (_cachedDevice !== engine._device) {
        _bindingsCache.clear();
        _composedCache?.clear();
        clearSceneBGLCache();
        _cachedDevice = engine._device;
    }
}

/** Clear the pipeline cache. Must be called when a GPU device is destroyed. */
export function clearStandardPipelineCache(): void {
    _bindingsCache.clear();
    _composedCache?.clear();
    clearSceneBGLCache();
    _cachedDevice = null;
}

/** Get-or-build the sig-independent shader bindings for a given feature/fragment set.
 *  Used at renderable build time so per-mesh bind groups can be created BEFORE the
 *  first bind() call (when sig is known). */
export function getOrCreateStandardBindings(
    engine: EngineContext,
    features: number,
    meshFeatures: number,
    fragments: ShaderFragment[] = [],
    shaderKey = "",
    esmShadowDepthCode = ""
): StandardShaderBindings {
    ensureDevice(engine);
    const key = _standardFeatureKey(features, meshFeatures, shaderKey);
    const cached = _bindingsCache.get(key);
    if (cached) {
        return cached;
    }

    const cc = getComposedCache();
    let composed = cc.get(key);
    if (!composed) {
        composed = composeStandardShader(features, meshFeatures, fragments, esmShadowDepthCode);
        cc.set(key, composed);
    }

    const device = engine._device;
    const meshBGL = device.createBindGroupLayout(composed._meshBGLDescriptor);
    let shadowBGL: GPUBindGroupLayout | null = null;
    const hasShadow = (meshFeatures & MSH_RECEIVE_SHADOWS) !== 0;
    if (hasShadow && composed._shadowBGLDescriptor) {
        shadowBGL = device.createBindGroupLayout(composed._shadowBGLDescriptor);
    }

    const bindings: StandardShaderBindings = {
        _features: features,
        _meshFeatures: meshFeatures,
        _meshBGL: meshBGL,
        _shadowBGL: shadowBGL,
        _composed: composed,
        _pipelines: new Map(),
    };
    _bindingsCache.set(key, bindings);
    return bindings;
}

/** Get-or-build a sig-specific pipeline on top of a shader bindings. Called at bind() time. */
export function getOrCreateStandardPipeline(engine: EngineContext, sig: RenderTargetSignature, bindings: StandardShaderBindings): GPURenderPipeline {
    ensureDevice(engine);
    const key = targetSignatureKey(sig);
    const cached = bindings._pipelines.get(key);
    if (cached) {
        return cached;
    }

    const device = engine._device;
    const composed = bindings._composed;
    const features = bindings._features;
    const sceneBGL = getSceneBindGroupLayout(engine);
    const bgls: GPUBindGroupLayout[] = bindings._shadowBGL ? [sceneBGL, bindings._meshBGL, bindings._shadowBGL] : [sceneBGL, bindings._meshBGL];

    const vertModule = device.createShaderModule({ code: composed._vertexWGSL });
    const noColorOutput = (features & NO_COLOR_OUTPUT) !== 0;
    const esmShadowOutput = (features & ESM_SHADOW_OUTPUT) !== 0;
    const fragModule = !sig._colorFormat && !noColorOutput ? null : device.createShaderModule({ code: composed._fragmentWGSL });

    const needsBlend = !esmShadowOutput && ((features & HAS_OPACITY_TEXTURE) !== 0 || (features & MATERIAL_ALPHA_BLEND) !== 0);
    const colorTarget: GPUColorTargetState | null = noColorOutput
        ? null
        : needsBlend
          ? {
                format: sig._colorFormat!,
                blend: {
                    color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
                    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                },
            }
          : { format: sig._colorFormat! };

    const pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: bgls }),
        vertex: { module: vertModule, entryPoint: "main", buffers: composed._vertexBufferLayouts },
        ...(fragModule ? { fragment: { module: fragModule, entryPoint: "main", targets: colorTarget ? [colorTarget] : [] } } : {}),
        ...(sig._depthStencilFormat
            ? {
                  depthStencil: {
                      format: sig._depthStencilFormat,
                      depthCompare: sig._depthCompare ?? REVERSE_DEPTH_COMPARE,
                      depthWriteEnabled: noColorOutput || esmShadowOutput || !needsBlend,
                  },
              }
            : {}),
        multisample: { count: sig._sampleCount },
        primitive: { topology: "triangle-list", cullMode: features & DOUBLE_SIDED ? "none" : "back", frontFace: "ccw" },
    });

    bindings._pipelines.set(key, pipeline);
    return pipeline;
}

// ─── Per-Mesh GPU Setup ─────────────────────────────────────────────

/** Build the per-mesh material bind group (group 1). The mesh UBO
 *  and material UBO are created/owned by the caller — this
 *  function only assembles the bind group entries that match the composer's
 *  binding layout.
 *
 *  Mirrors `createPbrMeshBindGroup` in pbr-pipeline.ts. */
export function createStandardMeshBindGroup(
    engine: EngineContext,
    bindings: StandardShaderBindings,
    meshUBO: GPUBuffer,
    materialUBO: GPUBuffer,
    material: StandardMaterialProps
): GPUBindGroup {
    const device = engine._device;
    const features = bindings._features;
    const needsUV = (features & NEEDS_UV) !== 0;
    const hasDiffuseTex = (features & HAS_DIFFUSE_TEXTURE) !== 0;
    const esmShadowOutput = (features & ESM_SHADOW_OUTPUT) !== 0;

    // Sequential numbering matches composer output.
    let nextBinding = 0;
    const entries: GPUBindGroupEntry[] = [
        { binding: nextBinding++, resource: { buffer: meshUBO } },
        { binding: nextBinding++, resource: { buffer: materialUBO } },
    ];

    if (hasDiffuseTex) {
        const tex = material.diffuseTexture!;
        entries.push({ binding: nextBinding++, resource: tex.texture.createView() }, { binding: nextBinding++, resource: tex.sampler });
    }

    // UV params UBO (only when UVs are actually emitted).
    if (needsUV) {
        const uvData = new F32(4);
        const scaleX = material.uvScale[0];
        let scaleY = material.uvScale[1];
        let offsetY = 0;
        // Flip V for y-down source data (e.g. basis/compressed textures).
        // uv * (sx, sy) + (ox, oy) with vFlip becomes uv.xy * (sx, -sy) + (ox, sy+oy).
        if (material.diffuseTexture?.invertY) {
            offsetY = scaleY;
            scaleY = -scaleY;
        }
        uvData[0] = scaleX;
        uvData[1] = scaleY;
        uvData[2] = 0;
        uvData[3] = offsetY;
        entries.push({ binding: nextBinding++, resource: { buffer: createUniformBuffer(engine, uvData) } });
    }

    if (esmShadowOutput) {
        entries.push({
            binding: nextBinding++,
            resource: { buffer: (material as StandardMaterialProps & { readonly _esmShadowParamsUBO: GPUBuffer })._esmShadowParamsUBO },
        });
    }

    // Fragment-contributed bindings — iterate ext registry in alphabetical id order
    // to match composer's fragment sort order.
    const sortedExts = _getStdExtsSorted();
    for (const ext of sortedExts) {
        if (features & ext._feature && ext._bind) {
            nextBinding = ext._bind(material, entries, nextBinding);
        }
    }

    return device.createBindGroup({ layout: bindings._meshBGL, entries });
}

// ─── Internal Helpers ───────────────────────────────────────────────

/** Write standard material properties into a pre-allocated Float32Array (24 floats). */
export function writeStdMaterialData(data: Float32Array, mat: StandardMaterialProps, textureLevel: number): void {
    const { diffuseColor: dc, specularColor: sc, emissiveColor: ec, ambientColor: ac } = mat;
    data[0] = dc[0];
    data[1] = dc[1];
    data[2] = dc[2];
    data[3] = mat.alpha;
    data[4] = sc[0];
    data[5] = sc[1];
    data[6] = sc[2];
    data[7] = mat.specularPower;
    data[8] = ec[0];
    data[9] = ec[1];
    data[10] = ec[2];
    data[11] = 1.0 / mat.bumpLevel;
    data[12] = ac[0];
    data[13] = ac[1];
    data[14] = ac[2];
    data[15] = textureLevel;
    data[16] = mat.ambientTexLevel;
    data[17] = mat.lightmapLevel;
    data[18] = mat.opacityLevel;
    data[19] = mat.alphaCutOff;
    data[20] = mat.reflectionLevel;
    data[21] = mat.reflectionCoordMode;
}
