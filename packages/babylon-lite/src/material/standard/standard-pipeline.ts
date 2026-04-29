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
import type { RenderTargetSignature } from "../../engine/render-target.js";
import { LIGHTS_UBO_SIZE, getLightsUboSize, writeLightsUBO, refreshLightsUBO } from "../../render/lights-ubo.js";
import type { StandardMaterialProps } from "./standard-material.js";
import { getSceneBindGroupLayout, clearSceneBGLCache } from "../../render/scene-helpers.js";
import { createStandardTemplate } from "./standard-template.js";
import { composeShader } from "../../shader/shader-composer.js";
import type { ComposedShader, ShaderFragment } from "../../shader/fragment-types.js";
import { createUniformBuffer } from "../../resource/gpu-buffers.js";
import { targetSignatureKey } from "../../engine/render-target.js";
import {
    AMBIENT_USES_UV2,
    DIFFUSE_USES_UV2,
    DISABLE_LIGHTING,
    DOUBLE_SIDED,
    HAS_AMBIENT_TEXTURE,
    HAS_BUMP_TEXTURE,
    HAS_CUBE_REFLECTION,
    HAS_DIFFUSE_TEXTURE,
    HAS_EMISSIVE_TEXTURE,
    HAS_LIGHTMAP_TEXTURE,
    HAS_OPACITY_TEXTURE,
    HAS_REFLECTION_TEXTURE,
    HAS_SPECULAR_TEXTURE,
    LIGHTMAP_USES_UV2,
    MATERIAL_ALPHA_BLEND,
    NEEDS_UV,
    NEEDS_UV2,
    OPACITY_FROM_RGB,
    PCF_SHADOWS,
    RECEIVE_SHADOWS,
    SPECULAR_USES_UV2,
    _getStdExtsSorted,
} from "./standard-flags.js";

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

// ─── Shader Bindings (sig-independent) ──────────────────────────────

/** Cached per-(features, fragments) shader bindings: BGLs + composed shader +
 *  per-sig pipeline cache. Created once at renderable build time, shared across
 *  all sig-specific pipelines. */
export interface StandardShaderBindings {
    features: number;
    meshBGL: GPUBindGroupLayout;
    shadowBGL: GPUBindGroupLayout | null;
    composed: ComposedShader;
    /** Per-sig pipeline cache. Key = `targetSignatureKey(sig)`. */
    pipelines: Map<string, GPURenderPipeline>;
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

function ensureDevice(engine: EngineContextInternal): void {
    if (_cachedDevice !== engine.device) {
        _bindingsCache.clear();
        _composedCache?.clear();
        clearSceneBGLCache();
        _cachedDevice = engine.device;
    }
}

/** Clear the pipeline cache. Must be called when a GPU device is destroyed. */
export function clearStandardPipelineCache(): void {
    _bindingsCache.clear();
    _composedCache?.clear();
    clearSceneBGLCache();
    _cachedDevice = null;
}

function fragmentKey(fragments: ShaderFragment[]): string {
    return fragments.length === 0
        ? ""
        : fragments
              .map((f) => f.id)
              .sort()
              .join(",");
}

/** Get-or-build the sig-independent shader bindings for a given feature/fragment set.
 *  Used at renderable build time so per-mesh bind groups can be created BEFORE the
 *  first bind() call (when sig is known). */
export function getOrCreateStandardBindings(engine: EngineContextInternal, features: number, fragments: ShaderFragment[] = []): StandardShaderBindings {
    ensureDevice(engine);
    const fk = fragmentKey(fragments);
    const key = fk ? `${features}:${fk}` : `${features}`;
    const cached = _bindingsCache.get(key);
    if (cached) {
        return cached;
    }

    const cc = getComposedCache();
    let composed = cc.get(key);
    if (!composed) {
        composed = composeStandardShader(features, fragments);
        cc.set(key, composed);
    }

    const device = engine.device;
    const meshBGL = device.createBindGroupLayout(composed.meshBGLDescriptor);
    let shadowBGL: GPUBindGroupLayout | null = null;
    const hasShadow = (features & RECEIVE_SHADOWS) !== 0;
    if (hasShadow && composed.shadowBGLDescriptor) {
        shadowBGL = device.createBindGroupLayout(composed.shadowBGLDescriptor);
    }

    const bindings: StandardShaderBindings = {
        features,
        meshBGL,
        shadowBGL,
        composed,
        pipelines: new Map(),
    };
    _bindingsCache.set(key, bindings);
    return bindings;
}

/** Get-or-build a sig-specific pipeline on top of a shader bindings. Called at bind() time. */
export function getOrCreateStandardPipeline(engine: EngineContextInternal, sig: RenderTargetSignature, bindings: StandardShaderBindings): GPURenderPipeline {
    ensureDevice(engine);
    const key = targetSignatureKey(sig);
    const cached = bindings.pipelines.get(key);
    if (cached) {
        return cached;
    }

    const device = engine.device;
    const composed = bindings.composed;
    const features = bindings.features;
    const sceneBGL = getSceneBindGroupLayout(engine);
    const bgls: GPUBindGroupLayout[] = bindings.shadowBGL ? [sceneBGL, bindings.meshBGL, bindings.shadowBGL] : [sceneBGL, bindings.meshBGL];

    const vertModule = device.createShaderModule({ code: composed.vertexWGSL });
    const fragModule = device.createShaderModule({ code: composed.fragmentWGSL });

    const needsBlend = (features & HAS_OPACITY_TEXTURE) !== 0 || (features & MATERIAL_ALPHA_BLEND) !== 0;
    const colorTarget: GPUColorTargetState = needsBlend
        ? {
              format: sig.colorFormat,
              blend: {
                  color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
                  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              },
          }
        : { format: sig.colorFormat };

    const pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: bgls }),
        vertex: { module: vertModule, entryPoint: "main", buffers: composed.vertexBufferLayouts },
        fragment: { module: fragModule, entryPoint: "main", targets: [colorTarget] },
        ...(sig.depthStencilFormat ? { depthStencil: { format: sig.depthStencilFormat, depthCompare: "less-equal" as GPUCompareFunction, depthWriteEnabled: !needsBlend } } : {}),
        multisample: { count: sig.sampleCount },
        primitive: { topology: "triangle-list", cullMode: features & DOUBLE_SIDED ? "none" : "back", frontFace: sig.flipY ? "cw" : "ccw" },
    });

    bindings.pipelines.set(key, pipeline);
    return pipeline;
}

// ─── Per-Mesh GPU Setup ─────────────────────────────────────────────

export { LIGHTS_UBO_SIZE, getLightsUboSize, writeLightsUBO, refreshLightsUBO };

/** Build the per-mesh material/lights bind group (group 1). The mesh UBO,
 *  material UBO, and lights buffer are created/owned by the caller — this
 *  function only assembles the bind group entries that match the composer's
 *  binding layout.
 *
 *  Mirrors `createPbrMeshBindGroup` in pbr-pipeline.ts. */
export function createStandardMeshBindGroup(
    engine: EngineContextInternal,
    bindings: StandardShaderBindings,
    meshUBO: GPUBuffer,
    materialUBO: GPUBuffer,
    lightsBuffer: GPUBuffer,
    material: StandardMaterialProps
): GPUBindGroup {
    const device = engine.device;
    const features = bindings.features;
    const hasShadow = (features & RECEIVE_SHADOWS) !== 0;
    const needsUV = (features & NEEDS_UV) !== 0;
    const hasDiffuseTex = (features & HAS_DIFFUSE_TEXTURE) !== 0;

    // Sequential numbering matches composer output.
    let nextBinding = 0;
    const entries: GPUBindGroupEntry[] = [
        { binding: nextBinding++, resource: { buffer: meshUBO } },
        { binding: nextBinding++, resource: { buffer: lightsBuffer } },
        { binding: nextBinding++, resource: { buffer: materialUBO } },
    ];

    if (hasDiffuseTex) {
        const tex = material.diffuseTexture!;
        entries.push({ binding: nextBinding++, resource: tex.texture.createView() }, { binding: nextBinding++, resource: tex.sampler });
    }

    // UV params UBO (always when UV or shadow is needed).
    if (hasShadow || needsUV) {
        const uvData = new Float32Array(4);
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

    // Fragment-contributed bindings — iterate ext registry in alphabetical id order
    // to match composer's fragment sort order.
    const sortedExts = _getStdExtsSorted();
    for (const ext of sortedExts) {
        if (features & ext.feature && ext.bind) {
            nextBinding = ext.bind(material, entries, nextBinding);
        }
    }

    return device.createBindGroup({ layout: bindings.meshBGL, entries });
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
