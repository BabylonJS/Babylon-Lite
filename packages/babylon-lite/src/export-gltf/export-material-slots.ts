/** Shared helpers for exporting material texture slots and factors. Used by the PBR core, the
 *  Standard conversion and every material extension writer. */

import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import type { Texture2D } from "../texture/texture-2d.js";
import { getTextureCoordinateIndex, getTextureTransform } from "../texture/texture-metadata.js";
import type { ExportContext, PendingSlot, SlotTransform, UvState } from "./export-context.js";
import type { GltfJsonObject } from "./export-gltf-types.js";
import { nearlyEqual, OMIT_EPSILON } from "./export-handedness.js";
import { captureTextureSlot } from "./export-textures.js";

/** @internal One PBR texture slot to capture. */
export interface PbrSlotRequest {
    /** Member name in the owner object, e.g. "clearcoatTexture". */
    readonly key: string;
    readonly texture: Texture2D | null | undefined;
    /** Whether Lite's shader applies this slot's `KHR_texture_transform` (the slot's gate). */
    readonly transform: boolean;
    /** Whether Lite samples this slot from the second UV set (before the mesh's UV state applies). */
    readonly uv1?: boolean;
    /** Extra textureInfo members (`scale`, `strength`). */
    readonly extra?: Readonly<Record<string, number>>;
    /** How a linear-format color texture is decoded before glTF sRGB encoding. */
    readonly colorDecode?: "linear" | "gamma";
    /** Keeps `-srgb` bytes without `colorDecode`: a color slot, or a slot that reads only alpha
     *  (which decoding leaves unchanged, so it can share the undecoded image). Slots with neither are
     *  data: an `-srgb` source exports the linear bytes the GPU samples. */
    readonly color?: boolean;
}

/** @internal The material's name as used in warnings. */
export function materialLabel(material: { name?: string }): string {
    return material.name ?? "";
}

/** @internal The texture's `KHR_texture_transform` in glTF terms, or undefined when the wrapper
 *  carries none (identity, or a texture that does not support transforms). `uAng` holds the glTF
 *  rotation verbatim. */
export function textureTransformOf(tex: Texture2D): SlotTransform | undefined {
    const t = getTextureTransform(tex);
    if (!t || (t.uOffset === 0 && t.vOffset === 0 && t.uScale === 1 && t.vScale === 1 && t.uAng === 0)) {
        return undefined;
    }
    return { offset: [t.uOffset, t.vOffset], scale: [t.uScale, t.vScale], rotation: t.uAng };
}

/** @internal Whether a texture wrapper carries the loader's per-texture transform stamp (`_hasTx`). */
export function hasTx(tex: Texture2D | null | undefined): boolean {
    return !!(tex as { _hasTx?: boolean } | null | undefined)?._hasTx;
}

/** @internal Whether a texture wrapper selects the second UV set (the loader's `_texCoord` stamp). */
export function samplesUv1(tex: Texture2D | null | undefined): boolean {
    return !!tex && getTextureCoordinateIndex(tex) === 1;
}

/** @internal The texCoord a UV1-selected slot exports with, for the mesh's UV state: 1 in `"uv1"`,
 *  0 in `"uv0"` (Lite's PBR shader samples UV0 when the mesh has no UV2 buffer), or null in
 *  `"lost"`, after logging the lost-UV1 warning. */
export function pbrUv1TexCoord(ctx: ExportContext, uvState: UvState, materialName: string): 0 | 1 | null {
    if (uvState === "uv1") {
        return 1;
    }
    if (uvState === "lost") {
        warnLostUv1(ctx, materialName);
        return null;
    }
    return 0;
}

/** @internal Log the warning for a UV1-selected slot on a mesh whose second UV set does not export. */
export function warnLostUv1(ctx: ExportContext, materialName: string): void {
    ctx.warn(`Material "${materialName}" samples TEXCOORD_1 on a mesh whose second UV set is on the GPU only; exporting that mesh's material without its UV1 textures.`);
}

/** @internal Capture one PBR texture slot into `owner[req.key]`: storage row order, no channel
 *  inversion, texCoord from the slot's UV selection and the mesh's UV state, and the texture's
 *  transform when the slot's gate is on. Returns the pending slot, or null when nothing was
 *  captured (`req.texture` unset, UV1 lost, or the texture unreadable). */
export function capturePbrSlot(ctx: ExportContext, material: PbrMaterialProps, uvState: UvState, owner: GltfJsonObject, req: PbrSlotRequest): PendingSlot | null {
    const tex = req.texture;
    if (!tex) {
        return null;
    }
    const name = materialLabel(material);
    let texCoord: 0 | 1 = 0;
    if (req.uv1) {
        const resolved = pbrUv1TexCoord(ctx, uvState, name);
        if (resolved === null) {
            return null;
        }
        texCoord = resolved;
    }
    const transform = req.transform ? textureTransformOf(tex) : undefined;
    const srgb = isSrgb(tex);
    const colorDecode = srgb ? undefined : req.colorDecode;
    const srgbData = srgb && !req.colorDecode && !req.color;
    return captureTextureSlot(ctx, owner, req.key, tex, { texCoord, transform, rowOrder: "storage", colorDecode, srgbData }, name, req.extra);
}

/** @internal Whether the texture's GPU format is sRGB-encoded (the sampler decodes it to linear). */
export function isSrgb(tex: Texture2D): boolean {
    return tex.texture.format.endsWith("-srgb");
}

/** @internal Set `owner[key] = value` unless `value` equals `omitAt` exactly. */
export function setUnlessDefault(owner: GltfJsonObject, key: string, value: number, omitAt: number): void {
    if (value !== omitAt) {
        owner[key] = value;
    }
}

/** @internal Set `owner[key]` to a copy of `value` unless every component equals `omitAt`'s. */
export function setVecUnlessDefault(owner: GltfJsonObject, key: string, value: readonly number[], omitAt: readonly number[]): void {
    for (let i = 0; i < omitAt.length; i++) {
        if (value[i] !== omitAt[i]) {
            owner[key] = Array.from(value);
            return;
        }
    }
}

/** @internal Whether a texture is a 1×1 image (a factor-fold candidate for base color and ORM). */
export function isOneByOne(tex: Texture2D | null | undefined): boolean {
    return !!tex && tex.width === 1 && tex.height === 1;
}

/** @internal `_uv2Mask` bits for the PBR core slots (`pbr-template-ext.ts` decode). */
export const UV2_BASE_COLOR = 1;
export const UV2_ORM = 2;
export const UV2_NORMAL = 4;
export const UV2_EMISSIVE = 8;
export const UV2_SPEC_GLOSS = 16;
export const UV2_OCCLUSION = 32;

/** @internal A core-slot request: UV1-selected by the slot's `_uv2Mask` bit, transformed only
 *  when the material has `_hasUvTx`. */
export function pbrCoreSlot(
    material: PbrMaterialProps,
    key: string,
    texture: Texture2D | null | undefined,
    uv2Bit: number,
    extra?: Readonly<Record<string, number>>
): PbrSlotRequest {
    return { key, texture, transform: !!material._hasUvTx, uv1: ((material._uv2Mask ?? 0) & uv2Bit) !== 0, extra };
}

/** @internal A textureInfo `strength` extra, omitted at 1. */
export function strengthExtra(strength: number): Readonly<Record<string, number>> | undefined {
    return strength !== 1 ? { strength } : undefined;
}

/** @internal Clamp material factors to glTF's [0, 1] range, warning when any was outside it. */
export function clampFactors(ctx: ExportContext, values: readonly number[], name: string): number[] {
    const out = values.map((v) => Math.min(Math.max(v, 0), 1));
    if (out.some((v, i) => v !== values[i])) {
        ctx.warn(`Material "${name}" has factors outside [0, 1], which glTF cannot represent; exporting them clamped.`);
    }
    return out;
}

/** @internal Write `baseColorFactor` clamped to [0, 1], omitted at `[1, 1, 1, 1]`. */
export function writeBaseColorFactor(ctx: ExportContext, pmr: GltfJsonObject, factor: readonly number[], name: string): void {
    const clamped = clampFactors(ctx, factor, name);
    if (!nearlyEqual(clamped, [1, 1, 1, 1], OMIT_EPSILON)) {
        pmr.baseColorFactor = clamped;
    }
}
