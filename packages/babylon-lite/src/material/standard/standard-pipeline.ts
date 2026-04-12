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

import type { ShadowGenerator } from "../../shadow/shadow-generator.js";
import { LIGHTS_UBO_SIZE, writeLightsUBO, refreshLightsUBO } from "../../render/lights-ubo.js";
import type { StandardMaterialProps } from "./standard-material.js";
import { getSceneBindGroupLayout, clearSceneBGLCache } from "../../render/scene-helpers.js";
import { createStandardTemplate } from "./standard-template.js";
import { composeShader } from "../../shader/shader-composer.js";
import type { ComposedShader, ShaderFragment } from "../../shader/fragment-types.js";
import { createPipelineCache, releaseVariant } from "../pipeline-cache.js";
import type { PipelineCache } from "../pipeline-cache.js";
// (flags imported from same file)

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

/** Derived: mesh needs UV attribute (any texture present). */
export const NEEDS_UV = HAS_DIFFUSE_TEXTURE | HAS_EMISSIVE_TEXTURE | HAS_BUMP_TEXTURE | HAS_SPECULAR_TEXTURE | HAS_AMBIENT_TEXTURE | HAS_LIGHTMAP_TEXTURE | HAS_OPACITY_TEXTURE;

/** Derived: mesh needs UV2 attribute. */
export const NEEDS_UV2 = LIGHTMAP_USES_UV2 | AMBIENT_USES_UV2 | DIFFUSE_USES_UV2 | SPECULAR_USES_UV2;

/** Compute feature bitmask from a mesh's material + receiveShadows flag. */
export function computeFeatures(material: StandardMaterialProps, receiveShadows: boolean): number {
    let f = 0;
    if (material.diffuseTexture) {
        f |= HAS_DIFFUSE_TEXTURE;
    }
    if (material.emissiveTexture) {
        f |= HAS_EMISSIVE_TEXTURE;
    }
    if (receiveShadows) {
        f |= RECEIVE_SHADOWS;
    }
    if (material.bumpTexture) {
        f |= HAS_BUMP_TEXTURE;
    }
    if (material.specularTexture) {
        f |= HAS_SPECULAR_TEXTURE;
    }
    if (material.ambientTexture) {
        f |= HAS_AMBIENT_TEXTURE;
    }
    if (material.lightmapTexture) {
        f |= HAS_LIGHTMAP_TEXTURE;
    }
    if (material.opacityTexture) {
        f |= HAS_OPACITY_TEXTURE;
    }
    if (material.lightmapTexture && material.lightmapCoordIndex === 1) {
        f |= LIGHTMAP_USES_UV2;
    }
    if (material.ambientTexture && material.ambientCoordIndex === 1) {
        f |= AMBIENT_USES_UV2;
    }
    if (material.diffuseTexture && material.diffuseCoordIndex === 1) {
        f |= DIFFUSE_USES_UV2;
    }
    if (material.specularTexture && material.specularCoordIndex === 1) {
        f |= SPECULAR_USES_UV2;
    }
    if (material.opacityTexture && material.opacityFromRGB) {
        f |= OPACITY_FROM_RGB;
    }
    if (!material.backFaceCulling) {
        f |= DOUBLE_SIDED;
    }
    if (material.reflectionTexture) {
        f |= HAS_REFLECTION_TEXTURE;
    }
    if (material.disableLighting) {
        f |= DISABLE_LIGHTING;
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

// ─── Pipeline Variant ───────────────────────────────────────────────

/** Cached pipeline variant — pipeline + bind group layouts + scene resources. */
export interface PipelineVariant {
    features: number;
    pipeline: GPURenderPipeline;
    sceneBGL: GPUBindGroupLayout;
    meshBGL: GPUBindGroupLayout;
    shadowBGL: GPUBindGroupLayout | null; // only if RECEIVE_SHADOWS
    sceneUBO: GPUBuffer;
    sceneBG: GPUBindGroup;
    meshUboTotalBytes: number;
    refCount: number;
}

/** Per-mesh GPU resources — created per mesh, references a PipelineVariant. */
export interface DynamicMeshGPU {
    meshBG: GPUBindGroup;
    shadowBG: GPUBindGroup | null; // only if RECEIVE_SHADOWS
    meshUBO: GPUBuffer;
    /** Shadow generators referenced by this mesh. */
    shadowGens: ShadowGenerator[];
}

// ─── Pipeline Cache ─────────────────────────────────────────────────

const cache: PipelineCache<PipelineVariant> = createPipelineCache();
const _composedCache = new Map<string, ComposedShader>();
let _sharedSceneUBO: GPUBuffer | null = null;

/** Clear the pipeline cache. Must be called when a GPU device is destroyed. */
export function clearStandardPipelineCache(): void {
    cache.clear();
    _composedCache.clear();
    clearSceneBGLCache();
    _sharedSceneUBO = null;
}

export function releaseStandardPipelineVariant(variant: PipelineVariant): void {
    releaseVariant(variant);
    cache.evictUnused();
}

function fragmentKey(fragments: ShaderFragment[]): string {
    return fragments.length === 0
        ? ""
        : fragments
              .map((f) => f.id)
              .sort()
              .join(",");
}

function cacheKey(features: number, format: GPUTextureFormat, msaa: number, fragments: ShaderFragment[]): string {
    const fk = fragmentKey(fragments);
    return fk ? `${features}:${format}:${msaa}:${fk}` : `${features}:${format}:${msaa}`;
}

/** Get or create a pipeline variant for the given features. */
export function getOrCreatePipeline(device: GPUDevice, format: GPUTextureFormat, msaaSamples: number, features: number, fragments: ShaderFragment[] = []): PipelineVariant {
    if (cache.ensureDevice(device)) {
        _composedCache.clear();
        clearSceneBGLCache();
        _sharedSceneUBO = null;
    }
    const key = cacheKey(features, format, msaaSamples, fragments);
    const cached = cache.getOrIncRef(key);
    if (cached) {
        return cached;
    }

    const hasShadow = (features & RECEIVE_SHADOWS) !== 0;

    // Compose shader via the generic composer — WGSL + BGL descriptors
    const fk = fragmentKey(fragments);
    const composedKey = fk ? `${features}:${fk}` : `${features}`;
    let composed = _composedCache.get(composedKey);
    if (!composed) {
        composed = composeStandardShader(features, fragments);
        _composedCache.set(composedKey, composed);
    }
    const vertSrc = composed.vertexWGSL;
    const fragSrc = composed.fragmentWGSL;

    // ─── Bind Group Layouts (from composer) ──────────────────

    // Group 0: Scene (shared across all variants)
    const sceneBGL = getSceneBindGroupLayout(device);

    // Group 1: Per-mesh (from composer's meshBGLDescriptor)
    const meshBGL = device.createBindGroupLayout({
        label: `std-mesh-f${features}`,
        ...composed.meshBGLDescriptor,
    });

    // Group 2: Shadow map (from composer or fallback for PCF)
    let shadowBGL: GPUBindGroupLayout | null = null;
    const bgls: GPUBindGroupLayout[] = [sceneBGL, meshBGL];

    if (hasShadow && composed.shadowBGLDescriptor) {
        shadowBGL = device.createBindGroupLayout({
            label: `std-shadow-f${features}`,
            ...composed.shadowBGLDescriptor,
        });
        bgls.push(shadowBGL);
    }

    // ─── Vertex Buffers (from composer) ──────────────────────

    const vertexBuffers = composed.vertexBufferLayouts;

    // ─── Pipeline ────────────────────────────────────────────

    const vertModule = device.createShaderModule({ code: vertSrc, label: `std-vert-f${features}` });
    const fragModule = device.createShaderModule({ code: fragSrc, label: `std-frag-f${features}` });

    // Alpha blending for opacity-textured materials (matches BJS transparent group)
    const needsBlend = (features & HAS_OPACITY_TEXTURE) !== 0;
    const colorTarget: GPUColorTargetState = needsBlend
        ? {
              format,
              blend: {
                  color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
                  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              },
          }
        : { format };

    const pipeline = device.createRenderPipeline({
        label: `standard-pipeline-f${features}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: bgls }),
        vertex: { module: vertModule, entryPoint: "main", buffers: vertexBuffers },
        fragment: { module: fragModule, entryPoint: "main", targets: [colorTarget] },
        depthStencil: {
            format: "depth24plus-stencil8",
            depthCompare: "less-equal",
            depthWriteEnabled: !needsBlend,
        },
        multisample: { count: msaaSamples },
        primitive: { topology: "triangle-list", cullMode: features & DOUBLE_SIDED ? "none" : "back", frontFace: "ccw" },
    });

    // ─── Scene UBO + Bind Group (shared across all variants) ───

    if (!_sharedSceneUBO) {
        _sharedSceneUBO = device.createBuffer({
            size: composed.sceneUboSpec.totalBytes,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    }
    const sceneUBO = _sharedSceneUBO;

    const sceneBG = device.createBindGroup({
        layout: sceneBGL,
        entries: [{ binding: 0, resource: { buffer: sceneUBO } }],
    });

    const variant: PipelineVariant = {
        features,
        pipeline,
        sceneBGL,
        meshBGL,
        shadowBGL,
        sceneUBO,
        sceneBG,
        meshUboTotalBytes: composed.meshUboSpec.totalBytes,
        refCount: 1,
    };

    cache.set(key, variant);
    return variant;
}

// ─── Per-Mesh GPU Setup ─────────────────────────────────────────────

export { LIGHTS_UBO_SIZE, writeLightsUBO, refreshLightsUBO };
const MATERIAL_UBO_SIZE = 96; // 24 floats (20 base + reflectionLevel + 3 pad)
const UV_UBO_SIZE = 16;

export function createDynamicMeshGPU(
    device: GPUDevice,
    variant: PipelineVariant,
    opts: {
        worldMatrix: Float32Array;
        material: StandardMaterialProps;
        lightsBuffer: GPUBuffer;
        shadowGenerators?: ShadowGenerator[];
    }
): DynamicMeshGPU {
    const { worldMatrix, material, lightsBuffer, shadowGenerators = [] } = opts;
    const features = variant.features;
    const hasShadow = (features & RECEIVE_SHADOWS) !== 0;
    const needsUV = (features & NEEDS_UV) !== 0;
    const hasDiffuseTex = (features & HAS_DIFFUSE_TEXTURE) !== 0;
    const hasEmissiveTex = (features & HAS_EMISSIVE_TEXTURE) !== 0;
    const hasBumpTex = (features & HAS_BUMP_TEXTURE) !== 0;
    const hasSpecularTex = (features & HAS_SPECULAR_TEXTURE) !== 0;
    const hasAmbientTex = (features & HAS_AMBIENT_TEXTURE) !== 0;
    const hasLightmapTex = (features & HAS_LIGHTMAP_TEXTURE) !== 0;
    const hasOpacityTex = (features & HAS_OPACITY_TEXTURE) !== 0;
    const hasReflectionTex = (features & HAS_REFLECTION_TEXTURE) !== 0;

    // Mesh UBO — size from pipeline variant's composed shader spec
    const meshUBO = createUBO(device, variant.meshUboTotalBytes || 64, worldMatrix);

    // Material UBO
    const textureLevel = needsUV ? 1.0 : 0;
    const materialUBO = writeMaterialUBO(device, material, textureLevel);

    // Build mesh bind group entries — sequential numbering matching composer output
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

    // UV params UBO (always when UV or shadow is needed)
    if (hasShadow || needsUV) {
        const uvData = new Float32Array(4);
        uvData[0] = material.uvScale[0];
        uvData[1] = material.uvScale[1];
        meshEntries.push({ binding: nextBinding++, resource: { buffer: createUBO(device, UV_UBO_SIZE, uvData) } });
    }

    // Fragment-contributed bindings (after all base bindings)
    // Order must match the composer's fragment sorting: alphabetical by fragment ID
    // normal-map (bump), std-ambient, std-emissive, std-lightmap, std-opacity, std-reflection, std-specular
    if (hasBumpTex) {
        const tex = material.bumpTexture!;
        meshEntries.push({ binding: nextBinding++, resource: tex.texture.createView() }, { binding: nextBinding++, resource: tex.sampler });
    }
    if (hasAmbientTex) {
        const tex = material.ambientTexture!;
        meshEntries.push({ binding: nextBinding++, resource: tex.texture.createView() }, { binding: nextBinding++, resource: tex.sampler });
    }
    if (hasEmissiveTex) {
        const tex = material.emissiveTexture!;
        meshEntries.push({ binding: nextBinding++, resource: tex.texture.createView() }, { binding: nextBinding++, resource: tex.sampler });
    }
    if (hasLightmapTex) {
        const tex = material.lightmapTexture!;
        meshEntries.push({ binding: nextBinding++, resource: tex.texture.createView() }, { binding: nextBinding++, resource: tex.sampler });
    }
    if (hasOpacityTex) {
        const tex = material.opacityTexture!;
        meshEntries.push({ binding: nextBinding++, resource: tex.texture.createView() }, { binding: nextBinding++, resource: tex.sampler });
    }
    if (hasReflectionTex) {
        const tex = material.reflectionTexture!;
        meshEntries.push({ binding: nextBinding++, resource: tex.texture.createView() }, { binding: nextBinding++, resource: tex.sampler });
    }
    if (hasSpecularTex) {
        const tex = material.specularTexture!;
        meshEntries.push({ binding: nextBinding++, resource: tex.texture.createView() }, { binding: nextBinding++, resource: tex.sampler });
    }

    const meshBG = device.createBindGroup({ layout: variant.meshBGL, entries: meshEntries });

    // Shadow bind group (group 2) — per-light shadow entries
    // Each shadow light contributes: texture + sampler + shared UBO from the ShadowGenerator
    let shadowBG: GPUBindGroup | null = null;
    if (hasShadow && variant.shadowBGL && shadowGenerators.length > 0) {
        const entries: GPUBindGroupEntry[] = [];
        let b = 0;
        for (const sg of shadowGenerators) {
            entries.push({ binding: b++, resource: sg.blurredTexture.createView() });
            entries.push({ binding: b++, resource: sg.blurredSampler });
            entries.push({ binding: b++, resource: { buffer: sg.shadowUBO } });
        }
        shadowBG = device.createBindGroup({ layout: variant.shadowBGL, entries });
    }

    return { meshBG, shadowBG, meshUBO, shadowGens: shadowGenerators };
}

// ─── Internal Helpers ───────────────────────────────────────────────

function createUBO(device: GPUDevice, size: number, data: Float32Array): GPUBuffer {
    const buf = device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
    return buf;
}

function writeMaterialUBO(device: GPUDevice, mat: StandardMaterialProps, textureLevel: number): GPUBuffer {
    const data = new Float32Array(24);
    data[0] = mat.diffuseColor[0];
    data[1] = mat.diffuseColor[1];
    data[2] = mat.diffuseColor[2];
    data[3] = mat.alpha;
    data[4] = mat.specularColor[0];
    data[5] = mat.specularColor[1];
    data[6] = mat.specularColor[2];
    data[7] = mat.specularPower;
    data[8] = mat.emissiveColor[0];
    data[9] = mat.emissiveColor[1];
    data[10] = mat.emissiveColor[2];
    data[11] = 1.0 / mat.bumpLevel; // bumpScale = 1/level (BJS convention)
    data[12] = mat.ambientColor[0];
    data[13] = mat.ambientColor[1];
    data[14] = mat.ambientColor[2];
    data[15] = textureLevel;
    data[16] = mat.ambientTexLevel;
    data[17] = mat.lightmapLevel;
    data[18] = mat.opacityLevel;
    data[19] = mat.alphaCutOff;
    data[20] = mat.reflectionLevel;
    // Store coordMode as float: 1.0=spherical, 2.0=planar
    data[21] = mat.reflectionCoordMode;
    return createUBO(device, MATERIAL_UBO_SIZE, data);
}
