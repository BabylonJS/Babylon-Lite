/** Dynamic StandardMaterial pipeline builder — creates and caches GPU render
 *  pipelines based on per-material feature flags.
 *
 *  Feature flags (bitmask):
 *    HAS_DIFFUSE_TEXTURE  — diffuse texture sampling + UV attribute
 *    HAS_EMISSIVE_TEXTURE — emissive texture sampling + UV attribute
 *    RECEIVE_SHADOWS      — ESM shadow map + light-space transform
 *
 *  Derived flag (computed automatically):
 *    NEEDS_UV = HAS_DIFFUSE_TEXTURE | HAS_EMISSIVE_TEXTURE
 *
 *  Pipelines are cached per (features, format, msaaSamples) tuple.
 *  Shared scene UBO layout is identical across all variants (176 bytes). */

import type { EngineContextInternal } from "../../engine/engine.js";
import type { RenderTargetSignature } from "../../render/renderable.js";
import { LIGHTS_UBO_SIZE, writeLightsUBO, refreshLightsUBO } from "../../render/lights-ubo.js";
import type { StandardMaterialProps } from "./standard-material.js";
import { getSceneBindGroupLayout, clearSceneBGLCache } from "../../render/scene-helpers.js";
import { createStandardTemplate } from "./standard-template.js";
import { composeShader } from "../../shader/shader-composer.js";
import type { ComposedShader, ShaderFragment } from "../../shader/fragment-types.js";
import { createPipelineCache, releaseVariant } from "../pipeline-cache.js";
import type { PipelineCache } from "../pipeline-cache.js";

// ─── Pluggable Shadow Shader Extensions (tree-shakable) ────────────
// PCF shadow code is registered at runtime by createPcfShadowGenerator(),
// so it's only bundled when PCF is actually used.
interface ShadowShaderExt {
    declarations: string;
    fn: string;
    call: string;
}
let _pcfShadowExt: ShadowShaderExt | null = null;

export function registerPcfShadowShader(ext: ShadowShaderExt): void {
    _pcfShadowExt = ext;
}

export function getPcfShadowExt(): ShadowShaderExt | null {
    return _pcfShadowExt;
}

// ─── Feature Flags ──────────────────────────────────────────────────

export const HAS_DIFFUSE_TEXTURE = 1 << 0;
export const HAS_EMISSIVE_TEXTURE = 1 << 1;
export const RECEIVE_SHADOWS = 1 << 2;
export const HAS_BUMP_TEXTURE = 1 << 3;
export const HAS_SPECULAR_TEXTURE = 1 << 4;
export const HAS_AMBIENT_TEXTURE = 1 << 5;
export const HAS_LIGHTMAP_TEXTURE = 1 << 6;
export const HAS_OPACITY_TEXTURE = 1 << 7;
export const LIGHTMAP_USES_UV2 = 1 << 8;
export const AMBIENT_USES_UV2 = 1 << 9;
const DOUBLE_SIDED = 1 << 10;
export const DIFFUSE_USES_UV2 = 1 << 11;
export const SPECULAR_USES_UV2 = 1 << 12;
export const OPACITY_FROM_RGB = 1 << 13;
export const HAS_REFLECTION_TEXTURE = 1 << 14;
export const THIN_INSTANCES = 1 << 15;
export const THIN_INSTANCE_COLOR = 1 << 16;
export const DISABLE_LIGHTING = 1 << 17;
export const PCF_SHADOWS = 1 << 18;
const MATERIAL_ALPHA_BLEND = 1 << 19;
export const HAS_CUBE_REFLECTION = 1 << 20;

// ─── Pluggable Shadow Pipeline Extensions (tree-shakable) ──────────
// PCF bind group layout config is registered at runtime by createPcfShadowGenerator().
interface ShadowBglConfig {
    textureSampleType: GPUTextureSampleType;
    samplerType: GPUSamplerBindingType;
}
let _pcfBglConfig: ShadowBglConfig | null = null;

/** Called by PCF shadow generator to register its BGL config. */
export function registerPcfShadowBgl(config: ShadowBglConfig): void {
    _pcfBglConfig = config;
}

/** Get the registered PCF shadow BGL config (if any). */
export function getPcfShadowBglConfig(): ShadowBglConfig | null {
    return _pcfBglConfig;
}

// ─── Standard Material Extension Registry ───────────────────────────
import type { SampledTexture } from "../../texture/texture-2d.js";

/** Bind-ordering phase for StdExt textures (alphabetical by id within phase, matching composer). */
export type StdExtPhase = "mesh";

/** Unified extension for Standard material. Each fragment module exports one.
 *  Fragments register via `_registerStdExt(ext)` at dynamic-import sites. */
export interface StdExt {
    readonly id: string;
    readonly phase: StdExtPhase;
    /** Feature bit this ext gates on. */
    readonly feature: number;
    frag(features: number, shadowLights?: ShadowLightSlotLite[]): ShaderFragment;
    /** Push group-1 bind entries starting at binding `b`; return new b. */
    bind?(mat: StandardMaterialProps, entries: GPUBindGroupEntry[], b: number): number;
    /** Enumerate textures for acquire/release. */
    textures?(mat: StandardMaterialProps, out: SampledTexture[]): void;
}

export interface ShadowLightSlotLite {
    lightIndex: number;
    shadowType: "esm" | "pcf";
}

const _stdExts = new Map<string, StdExt>();
let _stdExtsSorted: readonly StdExt[] | null = null;

export function _registerStdExt(ext: StdExt): void {
    _stdExts.set(ext.id, ext);
    _stdExtsSorted = null;
}

export function _getStdExts(): ReadonlyMap<string, StdExt> {
    return _stdExts;
}

export function _getStdExtsSorted(): readonly StdExt[] {
    if (!_stdExtsSorted) {
        _stdExtsSorted = Array.from(_stdExts.values()).sort((a, b) => a.id.localeCompare(b.id));
    }
    return _stdExtsSorted;
}

/** Derived: mesh needs UV attribute (any texture present). */
export const NEEDS_UV = HAS_DIFFUSE_TEXTURE | HAS_EMISSIVE_TEXTURE | HAS_BUMP_TEXTURE | HAS_SPECULAR_TEXTURE | HAS_AMBIENT_TEXTURE | HAS_LIGHTMAP_TEXTURE | HAS_OPACITY_TEXTURE;

/** Derived: mesh needs UV2 attribute. */
export const NEEDS_UV2 = LIGHTMAP_USES_UV2 | AMBIENT_USES_UV2 | DIFFUSE_USES_UV2 | SPECULAR_USES_UV2;

/** Compute feature bitmask from a mesh's material + receiveShadows flag. */
export function computeFeatures(material: StandardMaterialProps, receiveShadows: boolean): number {
    const m = material;
    let f = 0;
    if (m.diffuseTexture) {
        f |= HAS_DIFFUSE_TEXTURE;
        if (m.diffuseCoordIndex === 1) {
            f |= DIFFUSE_USES_UV2;
        }
    }
    if (m.emissiveTexture) {
        f |= HAS_EMISSIVE_TEXTURE;
    }
    if (receiveShadows) {
        f |= RECEIVE_SHADOWS;
    }
    if (m.bumpTexture) {
        f |= HAS_BUMP_TEXTURE;
    }
    if (m.specularTexture) {
        f |= HAS_SPECULAR_TEXTURE;
        if (m.specularCoordIndex === 1) {
            f |= SPECULAR_USES_UV2;
        }
    }
    if (m.ambientTexture) {
        f |= HAS_AMBIENT_TEXTURE;
        if (m.ambientCoordIndex === 1) {
            f |= AMBIENT_USES_UV2;
        }
    }
    if (m.lightmapTexture) {
        f |= HAS_LIGHTMAP_TEXTURE;
        if (m.lightmapCoordIndex === 1) {
            f |= LIGHTMAP_USES_UV2;
        }
    }
    if (m.opacityTexture) {
        f |= HAS_OPACITY_TEXTURE;
        if (m.opacityFromRGB) {
            f |= OPACITY_FROM_RGB;
        }
    }
    if (!m.backFaceCulling) {
        f |= DOUBLE_SIDED;
    }
    if (m.reflectionTexture) {
        f |= HAS_REFLECTION_TEXTURE;
    }
    if ((m as any).reflectionCubeTexture) {
        f |= HAS_CUBE_REFLECTION;
    }
    if (m.disableLighting) {
        f |= DISABLE_LIGHTING;
    }
    if (m.alpha < 1) {
        f |= MATERIAL_ALPHA_BLEND;
    }
    return f;
}

// ─── Composer Path (Phase 1) ────────────────────────────────────────
// Converts feature bitmask → StandardTemplateConfig → ComposedShader.
// This produces identical WGSL to the old string-builder path but via
// the generic composer, enabling fragment-based extensions in Phase 2.

/** Convert feature bitmask to a StandardTemplateConfig for the composer. */
export function featuresToTemplateConfig(features: number) {
    const has = (bit: number) => (features & bit) !== 0;
    return {
        textures: {
            diffuse: has(HAS_DIFFUSE_TEXTURE),
            emissive: has(HAS_EMISSIVE_TEXTURE),
            bump: has(HAS_BUMP_TEXTURE),
            specular: has(HAS_SPECULAR_TEXTURE),
            ambient: has(HAS_AMBIENT_TEXTURE),
            lightmap: has(HAS_LIGHTMAP_TEXTURE),
            opacity: has(HAS_OPACITY_TEXTURE),
            reflection: has(HAS_REFLECTION_TEXTURE),
        },
        needsUV: has(NEEDS_UV),
        needsUV2: has(NEEDS_UV2),
        lightmapUsesUV2: has(LIGHTMAP_USES_UV2),
        ambientUsesUV2: has(AMBIENT_USES_UV2),
        diffuseUsesUV2: has(DIFFUSE_USES_UV2),
        specularUsesUV2: has(SPECULAR_USES_UV2),
        hasShadow: has(RECEIVE_SHADOWS),
        hasPcfShadow: has(PCF_SHADOWS),
        opacityFromRGB: has(OPACITY_FROM_RGB),
        disableLighting: has(DISABLE_LIGHTING),
    };
}

/** Compose Standard shader via the generic ShaderComposer.
 *  @param fragments Optional extra fragments (e.g. thin-instance). */
export function composeStandardShader(features: number, fragments: ShaderFragment[] = []): ComposedShader {
    const config = featuresToTemplateConfig(features);
    const template = createStandardTemplate(config);
    return composeShader(template, fragments);
}

// ─── Bindings ───────────────────────────────────────────────────────

/**
 * Target-independent Standard material bindings — shaders, BGLs, feature key.
 * Cached by (features, fragments) only. A single bindings instance can produce
 * multiple GPURenderPipelines, one per render-target signature the material is
 * drawn into — stored in the `pipelines` child map and keyed by
 * `targetSignatureKey(target)`.
 */
export interface StandardBindings {
    features: number;
    composed: ComposedShader;
    meshBGL: GPUBindGroupLayout;
    shadowBGL: GPUBindGroupLayout | null;
    /** Target-specific pipelines. Lifetime follows the bindings. */
    pipelines: Map<string, GPURenderPipeline>;
    refCount: number;
}

// ─── Bindings Cache ─────────────────────────────────────────────────

let bindingsCache: PipelineCache<StandardBindings> | null = null;
let _composedCache: Map<string, ComposedShader> | null = null;

function getBindingsCache(): PipelineCache<StandardBindings> {
    if (!bindingsCache) {
        bindingsCache = createPipelineCache();
    }
    return bindingsCache;
}

function getComposedCache(): Map<string, ComposedShader> {
    if (!_composedCache) {
        _composedCache = new Map();
    }
    return _composedCache;
}

/** Clear the bindings cache. Must be called when a GPU device is destroyed. */
export function clearStandardPipelineCache(): void {
    bindingsCache?.clear();
    _composedCache?.clear();
    clearSceneBGLCache();
}

export function releaseStandardBindings(bindings: StandardBindings): void {
    releaseVariant(bindings);
    getBindingsCache().evictUnused();
}

function fragmentKey(fragments: ShaderFragment[]): string {
    return fragments.length === 0
        ? ""
        : fragments
              .map((f) => f.id)
              .sort()
              .join(",");
}

function cacheKey(features: number, fragments: ShaderFragment[]): string {
    const fk = fragmentKey(fragments);
    return fk ? `${features}:${fk}` : `${features}`;
}

/**
 * Get or create target-independent Standard bindings (shaders + BGLs) for a feature set.
 * Does NOT create a render pipeline — call getOrCreateStandardPipeline(bindings, target) for that.
 */
export function getOrCreateStandardBindings(engine: EngineContextInternal, features: number, fragments: ShaderFragment[] = []): StandardBindings {
    const device = engine.device;
    const c = getBindingsCache();
    const cc = getComposedCache();
    if (c.ensureDevice(engine)) {
        cc.clear();
        clearSceneBGLCache();
    }
    const key = cacheKey(features, fragments);
    const cached = c.getOrIncRef(key);
    if (cached) {
        return cached;
    }

    // Compose shader via the generic composer — WGSL + BGL descriptors
    let composed = cc.get(key);
    if (!composed) {
        composed = composeStandardShader(features, fragments);
        cc.set(key, composed);
    }

    const meshBGL = device.createBindGroupLayout({
        label: `std-mesh-f${features}`,
        ...composed.meshBGLDescriptor,
    });

    let shadowBGL: GPUBindGroupLayout | null = null;
    if ((features & RECEIVE_SHADOWS) !== 0 && composed.shadowBGLDescriptor) {
        shadowBGL = device.createBindGroupLayout({
            label: `std-shadow-f${features}`,
            ...composed.shadowBGLDescriptor,
        });
    }

    const bindings: StandardBindings = {
        features,
        composed,
        meshBGL,
        shadowBGL,
        pipelines: new Map(),
        refCount: 1,
    };

    c.set(key, bindings);
    return bindings;
}

/**
 * Get or create a GPURenderPipeline for the given bindings and render-target signature.
 * Pipelines live on the bindings object (no separate cache) — their lifetime follows
 * the bindings'. The pipeline is created lazily per unique target signature the material
 * is drawn into.
 */
export function getOrCreateStandardPipeline(engine: EngineContextInternal, bindings: StandardBindings, target: RenderTargetSignature): GPURenderPipeline {
    const key = `${target.colorFormat}|${target.sampleCount}|${target.depthStencilFormat ?? ""}`;
    const existing = bindings.pipelines.get(key);
    if (existing) {
        return existing;
    }
    const device = engine.device;
    const { features, composed, meshBGL, shadowBGL } = bindings;
    const needsBlend = (features & HAS_OPACITY_TEXTURE) !== 0 || (features & MATERIAL_ALPHA_BLEND) !== 0;
    const doubleSided = (features & DOUBLE_SIDED) !== 0;

    const bgls: GPUBindGroupLayout[] = [getSceneBindGroupLayout(engine), meshBGL];
    if (shadowBGL) {
        bgls.push(shadowBGL);
    }

    const vertModule = device.createShaderModule({ code: composed.vertexWGSL, label: `std-vert-f${features}` });
    const fragModule = device.createShaderModule({ code: composed.fragmentWGSL, label: `std-frag-f${features}` });

    const colorTarget: GPUColorTargetState = needsBlend
        ? {
              format: target.colorFormat,
              blend: {
                  color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
                  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              },
          }
        : { format: target.colorFormat };

    const pipeline = device.createRenderPipeline({
        label: `standard-pipeline-f${features}:${key}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: bgls }),
        vertex: { module: vertModule, entryPoint: "main", buffers: composed.vertexBufferLayouts as GPUVertexBufferLayout[] },
        fragment: { module: fragModule, entryPoint: "main", targets: [colorTarget] },
        depthStencil: {
            format: target.depthStencilFormat ?? "depth24plus-stencil8",
            depthCompare: "less-equal",
            depthWriteEnabled: !needsBlend,
        },
        multisample: { count: target.sampleCount },
        primitive: { topology: "triangle-list", cullMode: doubleSided ? "none" : "back", frontFace: target.flipY ? "cw" : "ccw" },
    });
    bindings.pipelines.set(key, pipeline);
    return pipeline;
}

// ─── Per-Mesh Bind Group ────────────────────────────────────────────

export { LIGHTS_UBO_SIZE, writeLightsUBO, refreshLightsUBO };

/** Build the per-mesh bind group (group 1) for a Standard material.
 *  The caller owns the meshUBO/materialUBO/uvUBO lifecycle. */
export function createStandardMeshBindGroup(
    engine: EngineContextInternal,
    bindings: StandardBindings,
    meshUBO: GPUBuffer,
    materialUBO: GPUBuffer,
    uvUBO: GPUBuffer | null,
    lightsBuffer: GPUBuffer,
    material: StandardMaterialProps
): GPUBindGroup {
    const device = engine.device;
    const features = bindings.features;
    const hasDiffuseTex = (features & HAS_DIFFUSE_TEXTURE) !== 0;

    let nextBinding = 0;
    const meshEntries: GPUBindGroupEntry[] = [
        { binding: nextBinding++, resource: { buffer: meshUBO } },
        { binding: nextBinding++, resource: { buffer: lightsBuffer } },
        { binding: nextBinding++, resource: { buffer: materialUBO } },
    ];

    if (hasDiffuseTex) {
        const tex = material.diffuseTexture!;
        meshEntries.push({ binding: nextBinding++, resource: tex.texture.createView() }, { binding: nextBinding++, resource: tex.sampler });
    }

    if (uvUBO) {
        meshEntries.push({ binding: nextBinding++, resource: { buffer: uvUBO } });
    }

    // Fragment-contributed bindings — iterate ext registry in alphabetical id order
    // to match composer's fragment sort order.
    const sortedExts = _getStdExtsSorted();
    for (const ext of sortedExts) {
        if (features & ext.feature && ext.bind) {
            nextBinding = ext.bind(material, meshEntries, nextBinding);
        }
    }

    return device.createBindGroup({ layout: bindings.meshBGL, entries: meshEntries });
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
