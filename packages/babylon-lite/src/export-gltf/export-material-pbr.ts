/** PBR material export: the core metallic-roughness mapping, the extension writer sweep, and 1×1
 *  factor folds. */

import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import { linearToSrgbByte, srgbByteToLinear } from "../math/color.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { ExportContext, MaterialExtensionWriter, PendingFold, PendingSlot, UvState } from "./export-context.js";
import type { GltfJsonObject, GltfMaterial } from "./export-gltf-types.js";
import { nearlyEqual, OMIT_EPSILON } from "./export-handedness.js";
import { gammaToLinear, requestPixels, textureReadIssue } from "./export-images.js";
import {
    capturePbrSlot,
    clampFactors,
    isOneByOne,
    isSrgb,
    materialLabel,
    pbrCoreSlot,
    samplesUv1,
    strengthExtra,
    UV2_BASE_COLOR,
    UV2_EMISSIVE,
    UV2_NORMAL,
    UV2_OCCLUSION,
    UV2_ORM,
    UV2_SPEC_GLOSS,
    warnLostUv1,
    writeBaseColorFactor,
} from "./export-material-slots.js";
import { captureTextureSlot } from "./export-textures.js";
import { anisotropyWriter } from "./ext/export-ext-anisotropy.js";
import { clearcoatWriter } from "./ext/export-ext-clearcoat.js";
import { diffuseTransmissionWriter } from "./ext/export-ext-diffuse-transmission.js";
import { dispersionWriter } from "./ext/export-ext-dispersion.js";
import { emissiveStrengthWriter } from "./ext/export-ext-emissive-strength.js";
import { iorWriter } from "./ext/export-ext-ior.js";
import { iridescenceWriter } from "./ext/export-ext-iridescence.js";
import { sheenWriter } from "./ext/export-ext-sheen.js";
import { specGlossWriter } from "./ext/export-ext-spec-gloss.js";
import { specularWriter } from "./ext/export-ext-specular.js";
import { transmissionWriter } from "./ext/export-ext-transmission.js";
import { unlitWriter } from "./ext/export-ext-unlit.js";
import { volumeWriter } from "./ext/export-ext-volume.js";

/** The material extension writers, in output-contract order: it fixes the member order of each
 *  material's `extensions` object and the order of `afterResolve` callbacks. */
const MATERIAL_EXTENSION_WRITERS: readonly MaterialExtensionWriter[] = [
    unlitWriter,
    emissiveStrengthWriter,
    clearcoatWriter,
    sheenWriter,
    iridescenceWriter,
    anisotropyWriter,
    iorWriter,
    specularWriter,
    transmissionWriter,
    volumeWriter,
    dispersionWriter,
    diffuseTransmissionWriter,
    specGlossWriter,
];

/** `_uv2Mask` bits for exported slots (bit 64, the lightmap, does not export). */
const EXPORTED_UV2_BITS = UV2_BASE_COLOR | UV2_ORM | UV2_NORMAL | UV2_EMISSIVE | UV2_SPEC_GLOSS | UV2_OCCLUSION;

/** @internal Whether any exported PBR slot samples the second UV set. */
export function pbrSelectsUv1(m: PbrMaterialProps): boolean {
    const iri = m._iridescence;
    return ((m._uv2Mask ?? 0) & EXPORTED_UV2_BITS) !== 0 || samplesUv1(iri?.texture) || samplesUv1(iri?.thicknessTexture);
}

/** @internal Emit the PBR core and every extension writer's payload onto `out`. */
export function exportPbrMaterial(ctx: ExportContext, m: PbrMaterialProps, out: GltfMaterial, uvState: UvState): void {
    const name = materialLabel(m);
    const obj = out as unknown as GltfJsonObject;
    const pmr: GltfJsonObject = {};
    out.pbrMetallicRoughness = pmr;

    // Base color. A 1×1 base color folds into the factor; the shader computes
    // sample.rgb × f.rgb and sample.a × f.a × alpha.
    const f = m.baseColorFactor ?? [1, 1, 1, 1];
    const alpha = m.alpha ?? 1;
    const cutoff = m._alphaCutOff ?? 0;
    const alphaMode = cutoff > 0 ? "MASK" : m.alphaBlend === true || alpha < 1 ? "BLEND" : undefined;
    const baseFactor = [f[0], f[1], f[2], f[3] * alpha];
    if (isOneByOne(m.baseColorTexture)) {
        const tex = m.baseColorTexture!;
        const decode = isSrgb(tex) ? "srgb" : m._gammaAlbedo ? "gamma" : "linear";
        recordFold(ctx, pmr, "baseColor", tex, baseFactor, name, decode, { opaque: !alphaMode });
    } else {
        capturePbrSlot(ctx, m, uvState, pmr, {
            ...pbrCoreSlot(m, "baseColorTexture", m.baseColorTexture, UV2_BASE_COLOR),
            colorDecode: m._gammaAlbedo ? "gamma" : "linear",
        });
        writeBaseColorFactor(ctx, pmr, baseFactor, name);
    }

    // Metallic-roughness from ORM (G roughness, B metallic). The spec-gloss shader path takes both
    // from the spec-gloss texture instead, so its ORM never exports as metallicRoughness.
    const metallic = m.metallicFactor ?? 1;
    const roughness = m.roughnessFactor ?? 1;
    const occlusionStrength = m.occlusionStrength ?? 1;
    const orm = m.specGlossTexture ? undefined : m.ormTexture;
    let ormFallback: PendingSlot[] | undefined;
    if (orm && isOneByOne(orm)) {
        // The 1×1 ORM folds when its R byte is 255 or occlusion does not read it; that is decided
        // once the texel is read back, so the image slots are captured as fallbacks.
        const occlusionReadsOrm = occlusionStrength !== 0 && !m.occlusionTexture;
        ormFallback = [];
        if (occlusionReadsOrm && textureReadIssue(ctx, orm) === null) {
            const mr = capturePbrSlot(ctx, m, uvState, pmr, pbrCoreSlot(m, "metallicRoughnessTexture", orm, UV2_ORM));
            const occ = capturePbrSlot(ctx, m, uvState, obj, pbrCoreSlot(m, "occlusionTexture", orm, UV2_ORM, strengthExtra(occlusionStrength)));
            for (const slot of [mr, occ]) {
                if (slot) {
                    ormFallback.push(slot);
                }
            }
        }
        recordFold(ctx, pmr, "metallicRoughness", orm, [metallic, roughness], name, isSrgb(orm) ? "srgb" : "linear", { fallbackSlots: ormFallback });
    } else {
        if (orm) {
            capturePbrSlot(ctx, m, uvState, pmr, pbrCoreSlot(m, "metallicRoughnessTexture", orm, UV2_ORM));
        }
        writeMetallicRoughness(ctx, pmr, metallic, roughness, name);
    }

    const normalScale = m.normalTextureScale ?? 1;
    capturePbrSlot(ctx, m, uvState, obj, pbrCoreSlot(m, "normalTexture", m.normalTexture, UV2_NORMAL, normalScale !== 1 ? { scale: normalScale } : undefined));

    // Occlusion (strength 0 disables it in the shader).
    if (occlusionStrength !== 0) {
        if (m.occlusionTexture) {
            if (((m._uv2Mask ?? 0) & UV2_OCCLUSION) !== 0) {
                // A UV1 occlusion texture: sampled from raw input.uv2 with no transform, and not at all
                // when the mesh has no UV2 buffer.
                if (uvState === "uv1") {
                    captureTextureSlot(
                        ctx,
                        obj,
                        "occlusionTexture",
                        m.occlusionTexture,
                        { texCoord: 1, rowOrder: "storage", srgbData: isSrgb(m.occlusionTexture) },
                        name,
                        strengthExtra(occlusionStrength)
                    );
                } else if (uvState === "lost") {
                    warnLostUv1(ctx, name);
                }
            } else {
                // The loader's ORM carrier on UV0, transformed like a core slot.
                capturePbrSlot(ctx, m, uvState, obj, { key: "occlusionTexture", texture: m.occlusionTexture, transform: !!m._hasUvTx, extra: strengthExtra(occlusionStrength) });
            }
        } else if (m.ormTexture && !ormFallback) {
            // glTF ORM assets share one image between metallicRoughness and occlusion. The spec-gloss
            // path still reads occlusion from the ORM's R channel.
            capturePbrSlot(ctx, m, uvState, obj, pbrCoreSlot(m, "occlusionTexture", m.ormTexture, UV2_ORM, strengthExtra(occlusionStrength)));
        }
    }

    // Emissive. A peak above 1 inverts the loader's emissive-strength premultiplication; the
    // emissive-strength writer emits the peak.
    capturePbrSlot(ctx, m, uvState, obj, { ...pbrCoreSlot(m, "emissiveTexture", m.emissiveTexture, UV2_EMISSIVE), colorDecode: "linear" });
    const e = m._emissiveColor;
    if (e) {
        const peak = Math.max(e[0], e[1], e[2]);
        const factor = (peak > 1 ? [e[0] / peak, e[1] / peak, e[2] / peak] : [e[0], e[1], e[2]]).map((c) => Math.max(c, 0));
        if (!nearlyEqual(factor, [0, 0, 0], OMIT_EPSILON)) {
            out.emissiveFactor = factor;
        }
    } else if (m.emissiveTexture) {
        out.emissiveFactor = [1, 1, 1];
    }

    if (alphaMode) {
        out.alphaMode = alphaMode;
    }
    if (alphaMode === "MASK" && cutoff !== 0.5) {
        out.alphaCutoff = cutoff;
    }
    if (m.doubleSided === true) {
        out.doubleSided = true;
    }

    for (const writer of MATERIAL_EXTENSION_WRITERS) {
        writer(ctx, m, out, uvState);
    }
}

function writeMetallicRoughness(ctx: ExportContext, pmr: GltfJsonObject, metallic: number, roughness: number, name: string): void {
    const [m, r] = clampFactors(ctx, [metallic, roughness], name);
    if (m !== 1) {
        pmr.metallicFactor = m;
    }
    if (r !== 1) {
        pmr.roughnessFactor = r;
    }
}

/** Record a 1×1 factor fold. Its texel is read back with the other textures; when the texture is
 *  unreadable (null engine), the props' factors are written alone and no fold is recorded. */
function recordFold(
    ctx: ExportContext,
    owner: GltfJsonObject,
    kind: "baseColor" | "metallicRoughness",
    texture: Texture2D,
    factor: number[],
    materialName: string,
    decode: PendingFold["decode"],
    extra?: Pick<PendingFold, "opaque" | "fallbackSlots">
): void {
    if (textureReadIssue(ctx, texture) !== null) {
        ctx.warn(`1×1 factor texture for material "${materialName}" is not readable on this engine; exporting its factors without the texture.`);
        if (kind === "baseColor") {
            writeBaseColorFactor(ctx, owner, factor, materialName);
        } else {
            writeMetallicRoughness(ctx, owner, factor[0]!, factor[1]!, materialName);
        }
        return;
    }
    requestPixels(ctx, texture);
    // Reserve the factor members' position in the JSON key order.
    if (kind === "baseColor") {
        owner.baseColorFactor = undefined;
    } else {
        owner.metallicFactor = undefined;
        owner.roughnessFactor = undefined;
    }
    ctx.folds.push({ owner, kind, gpu: texture.texture, decode, factor, materialName, ...extra });
}

/** @internal Resolve every 1×1 factor fold in capture order (synchronous, after readbacks settle and
 *  before the texture slots resolve). Folded RGB, metallic and roughness snap to the bytes the loader
 *  bakes factors into, so exporting a reload reproduces them (a no-op for the loader's own bakes). */
export function resolveFolds(ctx: ExportContext): void {
    for (const fold of ctx.folds) {
        const t = ctx.resolvedPixels.get(fold.gpu)!.rgba;
        if (fold.kind === "baseColor") {
            const decode = (b: number): number => (fold.decode === "srgb" ? srgbByteToLinear(b) : fold.decode === "gamma" ? gammaToLinear(b / 255) : b / 255);
            const f = fold.factor;
            const rgb = (i: number): number => onBakeGrid(decode(t[i]!) * f[i]!, (v) => srgbByteToLinear(linearToSrgbByte(v)));
            writeBaseColorFactor(ctx, fold.owner, [rgb(0), rgb(1), rgb(2), fold.opaque ? f[3]! : (t[3]! / 255) * f[3]!], fold.materialName);
            continue;
        }
        const [metallic, roughness] = fold.factor;
        if (fold.fallbackSlots && fold.fallbackSlots.length > 0 && t[0] !== 255) {
            // Occlusion reads a non-white R channel, which glTF cannot express as a factor: export
            // the 1×1 ORM as an image and keep the plain factors.
            writeMetallicRoughness(ctx, fold.owner, metallic!, roughness!, fold.materialName);
            continue;
        }
        for (const slot of fold.fallbackSlots ?? []) {
            slot.cancelled = true;
        }
        const byte = (v: number): number => Math.round(v * 255) / 255;
        const decode = (b: number): number => (fold.decode === "srgb" ? srgbByteToLinear(b) : b / 255);
        writeMetallicRoughness(ctx, fold.owner, onBakeGrid(metallic! * decode(t[2]!), byte), onBakeGrid(roughness! * decode(t[1]!), byte), fold.materialName);
    }
}

/** Snap an in-range folded factor; out-of-range values pass through so the writers clamp and warn. */
function onBakeGrid(v: number, snap: (v: number) => number): number {
    return v >= 0 && v <= 1 ? snap(v) : v;
}
