import type { Material } from "../material.js";
import { getMaterialSource } from "../material-view.js";
import type { StandardMaterialProps } from "../standard/standard-material.js";
import type { PbrMaterialProps } from "../pbr/pbr-material.js";
import type { NodeMaterial } from "../node/node-material.js";
import type { ShaderMaterial } from "../shader/shader-material.js";
import type { Texture2D } from "../../texture/texture-2d.js";
import { MATERIAL_ALPHA_BLEND } from "../standard/standard-flags.js";
import { PBR_HAS_ALPHA_BLEND } from "../pbr/pbr-flag-bits.js";

/** Reusable glow color; native callbacks mutate these fields rather than allocating colors. */
export interface GlowColor {
    r: number;
    g: number;
    b: number;
    a: number;
}

/** @internal Effective surface inputs, independent of a forward material's lighting features. */
export interface GlowSurface {
    source: Material;
    /** PBR surfaces own glTF primitive state (topology and mirrored winding). */
    pbr: boolean;
    /** Rendered by its own NodeMaterial shader, outputting the graph's glow input. */
    own: boolean;
    /** No emissive source: the task's neutral color applies, as for Babylon materials without `emissiveColor`. */
    neutral: boolean;
    /** Babylon alpha mode used when `alphaBlend` is set. */
    alphaMode: number;
    /** 0 triangle-list, 1 line-list, 2 point-list. */
    topology: number;
    color: GlowColor;
    textures: [Texture2D | null, Texture2D | null, Texture2D | null];
    uvChannels: [number, number, number];
    alphaTest: boolean;
    alphaBlend: boolean;
    doubleSided: boolean;
    opacityFromRGB: boolean;
    opacityLevel: number;
    uvScaleX: number;
    uvScaleY: number;
    uvOffsetX: number;
    uvOffsetY: number;
}

/** @internal Refresh a draw's preallocated source description. */
export function readGlowSurface(material: Material, out: GlowSurface, vertexAlpha = false): void {
    const source = material;
    out.source = source;
    out.pbr = out.own = out.neutral = false;
    out.alphaMode = 2;
    out.topology = 0;
    const family = getMaterialSource(source)._buildGroup._materialFamily;
    if (family === "standard") {
        const mat = source as StandardMaterialProps;
        out.color.r = mat.emissiveColor[0];
        out.color.g = mat.emissiveColor[1];
        out.color.b = mat.emissiveColor[2];
        out.color.a = mat.alpha;
        // Standard has no alpha-from-diffuse mode: diffuse alpha only feeds the alpha test, which needs that texture.
        out.alphaTest = mat.alphaCutOff > 0 && !!mat.diffuseTexture;
        out.alphaBlend = vertexAlpha || !!mat._opacityTexture || (mat._renderFeatures ? !!(mat._renderFeatures.features & MATERIAL_ALPHA_BLEND) : mat.alpha < 1);
        out.doubleSided = !mat.backFaceCulling;
        out.textures[0] = out.alphaTest ? mat.diffuseTexture : null;
        out.textures[1] = mat._opacityTexture ?? null;
        out.textures[2] = mat._emissiveTexture ?? null;
        out.uvChannels[0] = mat.diffuseCoordIndex;
        out.uvChannels[1] = out.uvChannels[2] = 0;
        out.opacityFromRGB = mat.opacityFromRGB;
        out.opacityLevel = mat.opacityLevel;
        out.uvScaleX = mat.uvScale[0];
        out.uvScaleY = mat.uvScale[1];
        out.uvOffsetX = mat.uvOffset?.[0] ?? 0;
        out.uvOffsetY = mat.uvOffset?.[1] ?? 0;
    } else if (family === "pbr") {
        const mat = source as PbrMaterialProps;
        const factor = mat._emissiveColor;
        const neutral = mat.emissiveTexture ? 1 : 0;
        const cutoff = (mat._alphaCutOff ?? 0) > 0;
        out.pbr = true;
        out.color.r = factor?.[0] ?? neutral;
        out.color.g = factor?.[1] ?? neutral;
        out.color.b = factor?.[2] ?? neutral;
        out.color.a = (mat.alpha ?? 1) * (mat.baseColorFactor?.[3] ?? 1);
        out.alphaTest = cutoff && !!mat.baseColorTexture;
        out.alphaBlend = vertexAlpha || (mat._renderFeatures ? !!(mat._renderFeatures.features & PBR_HAS_ALPHA_BLEND) : !cutoff && (!!mat.alphaBlend || out.color.a < 1));
        out.doubleSided = !!mat.doubleSided;
        out.textures[0] = out.alphaTest || out.alphaBlend ? (mat.baseColorTexture ?? null) : null;
        out.textures[1] = null;
        out.textures[2] = mat.emissiveTexture ?? null;
        out.uvChannels[0] = (mat._uv2Mask ?? 0) & 1 ? 1 : 0;
        out.uvChannels[1] = 0;
        out.uvChannels[2] = (mat._uv2Mask ?? 0) & 8 ? 1 : 0;
        out.opacityFromRGB = false;
        out.opacityLevel = 1;
        out.uvScaleX = out.uvScaleY = 1;
        out.uvOffsetX = out.uvOffsetY = 0;
    } else if (family === "node" || family === "shader") {
        // Babylon renders materials without `emissiveColor` in the neutral color; a NodeMaterial whose glow input is
        // connected renders through its own shader instead. Both still occlude.
        let doubleSided: boolean;
        if (family === "node") {
            // Glow programs belong to the source material, whichever view the mesh renders.
            const mat = getMaterialSource(source) as NodeMaterial;
            out.source = mat;
            out.own = !!mat._state._glowOutput;
            out.alphaMode = mat._graph.alphaMode || 2;
            out.alphaBlend = vertexAlpha || mat._needsAlphaBlending;
            doubleSided = !mat._graph.backFaceCulling;
        } else {
            const mat = source as ShaderMaterial;
            out.alphaMode = mat.blendMode === "additive" ? 1 : 2;
            out.alphaBlend = vertexAlpha || mat.needAlphaBlending;
            out.topology = mat._topology === "line-list" ? 1 : mat._topology === "point-list" ? 2 : 0;
            doubleSided = !mat.backFaceCulling;
        }
        out.neutral = true;
        out.alphaTest = out.opacityFromRGB = false;
        out.doubleSided = doubleSided;
        out.textures[0] = out.textures[1] = out.textures[2] = null;
        out.uvChannels[0] = out.uvChannels[1] = out.uvChannels[2] = 0;
        out.opacityLevel = 1;
        out.uvScaleX = out.uvScaleY = 1;
        out.uvOffsetX = out.uvOffsetY = 0;
    } else {
        throw new Error(`GlowPostProcessTask does not support material family "${family ?? "unknown"}". Exclude that mesh or provide a supported material.`);
    }
}

/** @internal Write the native affine UV convention into two vec4 rows; returns whether a value changed. */
export function writeGlowUv(data: Float32Array, offset: number, texture: Texture2D, surface: GlowSurface, channel: number): boolean {
    const angle = texture.uAng ?? 0;
    const c = angle ? Math.cos(angle) : 1;
    const s = angle ? Math.sin(angle) : 0;
    const sx = texture.uScale ?? 1;
    const sy = texture.vScale ?? 1;
    const bx = channel ? 1 : surface.uvScaleX;
    const by = channel ? 1 : surface.uvScaleY;
    const ox = channel ? 0 : surface.uvOffsetX;
    const oy = channel ? 0 : surface.uvOffsetY;
    const flip = texture.invertY ? -1 : 1;
    const u0 = data[offset];
    const u1 = data[offset + 1];
    const u2 = data[offset + 2];
    const v0 = data[offset + 4];
    const v1 = data[offset + 5];
    const v2 = data[offset + 6];
    data[offset] = c * sx * bx;
    data[offset + 1] = s * sy * by;
    data[offset + 2] = c * sx * ox + s * sy * oy + (texture.uOffset ?? 0);
    data[offset + 4] = -s * sx * bx * flip;
    data[offset + 5] = c * sy * by * flip;
    data[offset + 6] = (-s * sx * ox + c * sy * oy + (texture.vOffset ?? 0)) * flip + (texture.invertY ? 1 : 0);
    // Compare after float32 storage rounding.
    return data[offset] !== u0 || data[offset + 1] !== u1 || data[offset + 2] !== u2 || data[offset + 4] !== v0 || data[offset + 5] !== v1 || data[offset + 6] !== v2;
}
