/** Standard material export: the Babylon.js Standard → metallic-roughness conversion. */

import type { StandardMaterialProps } from "../material/standard/standard-material.js";
import type { Texture2D } from "../texture/texture-2d.js";
import { getTextureTransform } from "../texture/texture-metadata.js";
import type { ExportContext, SlotMapping, SlotTransform, UvState } from "./export-context.js";
import { attachExtension } from "./export-context.js";
import type { GltfJsonObject, GltfMaterial } from "./export-gltf-types.js";
import { gammaToLinear } from "./export-images.js";
import { clampFactors, isSrgb, materialLabel, warnLostUv1, writeBaseColorFactor } from "./export-material-slots.js";
import { captureTextureSlot } from "./export-textures.js";

/** @internal Whether any exported Standard slot samples the second UV set. */
export function standardSelectsUv1(m: StandardMaterialProps): boolean {
    return (!!m.diffuseTexture && m.diffuseCoordIndex === 1) || (!!m._ambientTexture && m.ambientCoordIndex === 1);
}

/** @internal Emit the Standard conversion onto `out`. */
export function exportStandardMaterial(ctx: ExportContext, m: StandardMaterialProps, out: GltfMaterial, uvState: UvState): void {
    const name = materialLabel(m);
    const obj = out as unknown as GltfJsonObject;
    const pmr: GltfJsonObject = {};
    out.pbrMetallicRoughness = pmr;
    const alpha = m.alpha ?? 1;
    const diffuse = m.diffuseColor ?? [1, 1, 1];
    const emissive = m.emissiveColor ?? [0, 0, 0];
    const unlit = m.disableLighting === true;
    if (unlit) {
        // The unlit Standard shader outputs clamp(emissive × diffuse) × diffuseTexture, in gamma space.
        const c = [0, 1, 2].map((i) => gammaToLinear(Math.min(Math.max(emissive[i]! * diffuse[i]!, 0), 1)));
        writeBaseColorFactor(ctx, pmr, [c[0]!, c[1]!, c[2]!, alpha], name);
        attachExtension(ctx, out, "KHR_materials_unlit", {});
        if (m._emissiveTexture) {
            ctx.warn(`Material "${name}" is unlit with an emissive texture, which KHR_materials_unlit cannot represent; exporting it without the texture.`);
        }
    } else {
        // Babylon.js's Blinn-Phong → metallic-roughness approximation.
        writeBaseColorFactor(ctx, pmr, [gammaToLinear(diffuse[0]) * 0.5, gammaToLinear(diffuse[1]) * 0.5, gammaToLinear(diffuse[2]) * 0.5, alpha], name);
        pmr.metallicFactor = 0;
        const roughness = specularPowerToRoughness(Math.min(Math.max(m.specularPower ?? 64, 0), 1024));
        if (roughness !== 1) {
            pmr.roughnessFactor = roughness;
        }
    }

    const flippedMaterialWide = isStandardUvInverted(m);
    const slot = (owner: GltfJsonObject, key: string, tex: Texture2D | null | undefined, coordIndex: number, bump: boolean, extra?: Readonly<Record<string, number>>): void => {
        if (!tex) {
            return;
        }
        const mapping = standardMapping(ctx, m, tex, coordIndex === 1, flippedMaterialWide, bump, uvState, name);
        if (mapping) {
            captureTextureSlot(ctx, owner, key, tex, mapping, name, extra);
        }
    };
    slot(pmr, "baseColorTexture", m.diffuseTexture, m.diffuseCoordIndex ?? 0, false);
    if (!unlit) {
        const bumpLevel = m.bumpLevel ?? 1;
        slot(obj, "normalTexture", m._bumpTexture, 0, true, bumpLevel !== 1 ? { scale: bumpLevel } : undefined);
        slot(obj, "occlusionTexture", m._ambientTexture, m.ambientCoordIndex ?? 0, false);
        slot(obj, "emissiveTexture", m._emissiveTexture, 0, false);
        // Emissive: the texture alone needs a white factor; a non-black color (added in gamma space
        // by the Standard shader) overrides it, converted to linear.
        if (emissive[0] !== 0 || emissive[1] !== 0 || emissive[2] !== 0) {
            out.emissiveFactor = clampFactors(ctx, [gammaToLinear(emissive[0]), gammaToLinear(emissive[1]), gammaToLinear(emissive[2])], name);
        } else if (m._emissiveTexture) {
            out.emissiveFactor = [1, 1, 1];
        }
    }

    // Alpha. Lite's alpha test runs only on the diffuse texture's alpha, and its output alpha is the
    // material alpha (times an opacity texture), so MASK is exact only for an opaque textured material.
    const cutoff = m.alphaCutOff ?? 0;
    const blends = alpha < 1 || !!m._opacityTexture;
    if (cutoff > 0 && m.diffuseTexture && !blends) {
        out.alphaMode = "MASK";
        if (cutoff !== 0.5) {
            out.alphaCutoff = cutoff;
        }
    } else if (blends) {
        out.alphaMode = "BLEND";
        if (cutoff > 0 && m.diffuseTexture) {
            ctx.warn(`Material "${name}" both alpha-tests and blends, which glTF cannot represent; exporting it as BLEND.`);
        }
    }
    if (m.backFaceCulling === false) {
        out.doubleSided = true;
    }
}

/** @internal The Babylon.js Blinn-Phong specular power → roughness approximation. */
export function specularPowerToRoughness(power: number): number {
    const t = Math.pow(power / 1300, 0.333333);
    const u = 1 - t;
    return u * u * u * 1.0 + 3 * u * u * t * 0.1 + 3 * u * t * t * 0.1 + t * t * t * 0.1;
}

/** The Standard shared path's material-wide orientation: the diffuse texture's `invertY`, else the
 *  opacity texture's, else the bump texture's (`isStandardUvInverted` in `standard-pipeline.ts`). */
function isStandardUvInverted(m: StandardMaterialProps): boolean {
    if (m.diffuseTexture) {
        return m.diffuseTexture.invertY === true;
    }
    if (m._opacityTexture) {
        return m._opacityTexture.invertY === true;
    }
    return m._bumpTexture?.invertY === true;
}

/** The mapping for one Standard slot: the exported `KHR_texture_transform` `T` maps glTF UVs onto
 *  rows of the emitted image, which holds reversed rows for a flipped slot. Returns null when the
 *  slot does not export in this UV state. */
function standardMapping(
    ctx: ExportContext,
    m: StandardMaterialProps,
    tex: Texture2D,
    uv1: boolean,
    flippedMaterialWide: boolean,
    bump: boolean,
    uvState: UvState,
    name: string
): SlotMapping | null {
    if (uv1 && uvState !== "uv1") {
        // The Standard shader does not fall back to UV0, so UV1 slots export only with TEXCOORD_1.
        if (uvState === "lost") {
            warnLostUv1(ctx, name);
        }
        return null;
    }
    const S = m.uvScale ?? [1, 1];
    const O = m.uvOffset ?? [0, 0];
    let flipped: boolean;
    let transform: SlotTransform | undefined;
    if (m._hasUvTx !== true) {
        // Shared path: UV0 slots share one varying, flipped before the scale/offset; UV1 slots
        // sample uv2 directly and are never flipped.
        flipped = !uv1 && flippedMaterialWide;
        transform = uv1 ? undefined : { scale: [S[0], S[1]], offset: [O[0], flipped ? 1 - S[1] - O[1] : O[1]], rotation: 0 };
    } else {
        // Per-texture path: A(uv) = M·(S·uv + O) + [uOffset, vOffset] (UV0) or M·uv + [uOffset, vOffset]
        // (UV1), with M = R(uAng)·diag(uScale, vScale); the flip applies after A, so T = A.
        flipped = tex.invertY === true;
        const t = getTextureTransform(tex) ?? { uOffset: 0, vOffset: 0, uScale: 1, vScale: 1, uAng: 0 };
        const c = Math.cos(t.uAng);
        const s = Math.sin(t.uAng);
        if (uv1) {
            transform = { scale: [t.uScale, t.vScale], offset: [t.uOffset, t.vOffset], rotation: t.uAng };
        } else {
            const mo = [c * t.uScale * O[0] + s * t.vScale * O[1], -s * t.uScale * O[0] + c * t.vScale * O[1]];
            transform = { scale: [t.uScale * S[0], t.vScale * S[1]], offset: [mo[0]! + t.uOffset, mo[1]! + t.vOffset], rotation: t.uAng };
        }
    }
    const mapping: SlotMapping = {
        texCoord: uv1 ? 1 : 0,
        transform,
        rowOrder: flipped ? "reversed" : "storage",
        // Lite's perturbNormal frame is (−T₀, −B₀) where the PBR cotangent frame is (T₀, −B₀): invert
        // red always, and green too when the slot is flipped.
        invert: bump ? (flipped ? "rg" : "r") : undefined,
        // The Standard shader uses the sampled value as its byte value, so an -srgb source exports decoded.
        srgbData: isSrgb(tex),
    };
    return mapping;
}
