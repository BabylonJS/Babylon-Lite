/** Material export: family dispatch, the PBR core, the Standard→metallic-roughness conversion, the
 *  extension writer sweep, and 1×1 factor-fold resolution. */

import type { Material } from "../material/material.js";
import { getMaterialFamily } from "../material/material-family.js";
import { getMaterialSource } from "../material/material-view.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import type { StandardMaterialProps } from "../material/standard/standard-material.js";
import { linearToSrgbByte, srgbByteToLinear } from "../math/color.js";
import type { Texture2D } from "../texture/texture-2d.js";
import { getTextureTransform } from "../texture/texture-metadata.js";
import type { ExportContext, MaterialExtensionWriter, PendingFold, PendingSlot, SlotMapping, SlotTransform, UvState } from "./export-context.js";
import { attachExtension, snapshotExtras } from "./export-context.js";
import type { GltfJsonObject, GltfMaterial } from "./export-gltf-types.js";
import { nearlyEqual, OMIT_EPSILON } from "./export-handedness.js";
import { gammaToLinear, requestPixels, textureReadIssue } from "./export-images.js";
import {
    capturePbrSlot,
    isOneByOne,
    materialLabel,
    pbrCoreSlot,
    samplesUv1,
    UV2_BASE_COLOR,
    UV2_EMISSIVE,
    UV2_NORMAL,
    UV2_OCCLUSION,
    UV2_ORM,
    UV2_SPEC_GLOSS,
    warnLostUv1,
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

/** @internal Return the glTF material index for a mesh's material in the mesh's UV state, emitting the
 *  material on first use. Returns undefined, with a warning, for families glTF cannot express. */
export function exportMaterial(ctx: ExportContext, material: Material | null | undefined, uvState: UvState): number | undefined {
    if (!material) {
        return undefined;
    }
    const source = getMaterialSource(material);
    const family = getMaterialFamily(source);
    if (family !== "pbr" && family !== "standard") {
        ctx.warn(`Material "${source.name ?? ""}" of family "${family ?? "unknown"}" is not mapped to glTF; exporting the primitive without a material.`);
        return undefined;
    }
    // A material none of whose slots selects UV1 exports identically in every UV state.
    const selectsUv1 = family === "pbr" ? pbrSelectsUv1(source as PbrMaterialProps) : standardSelectsUv1(source as StandardMaterialProps);
    const key: UvState = selectsUv1 ? uvState : "uv0";
    let byState = ctx.materialIndex.get(source);
    if (!byState) {
        byState = new Map();
        ctx.materialIndex.set(source, byState);
    }
    let index = byState.get(key);
    if (index === undefined) {
        const out: GltfMaterial = {};
        if (source.name) {
            out.name = source.name;
        }
        index = ctx.doc.materials.push(out) - 1;
        byState.set(key, index);
        const firstSlot = ctx.slots.length;
        if (family === "pbr") {
            exportPbrMaterial(ctx, source as PbrMaterialProps, out, key);
        } else {
            exportStandardMaterial(ctx, source as StandardMaterialProps, out, key);
        }
        if (ctx.slots.slice(firstSlot).some((slot) => slot.mapping.texCoord === 0)) {
            ctx.materialsUsingUv0.add(index);
        }
        const extras = snapshotExtras(ctx, source.metadata?.gltf?.extras, source.name);
        if (extras !== undefined) {
            out.extras = extras;
        }
    }
    return index;
}

function pbrSelectsUv1(m: PbrMaterialProps): boolean {
    const iri = m._iridescence;
    return ((m._uv2Mask ?? 0) & EXPORTED_UV2_BITS) !== 0 || samplesUv1(iri?.texture) || samplesUv1(iri?.thicknessTexture);
}

function standardSelectsUv1(m: StandardMaterialProps): boolean {
    return (!!m.diffuseTexture && m.diffuseCoordIndex === 1) || (!!m._ambientTexture && m.ambientCoordIndex === 1);
}

function exportPbrMaterial(ctx: ExportContext, m: PbrMaterialProps, out: GltfMaterial, uvState: UvState): void {
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
        const decode = tex.texture.format.endsWith("-srgb") ? "srgb" : m._gammaAlbedo ? "gamma" : "linear";
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
        recordFold(ctx, pmr, "metallicRoughness", orm, [metallic, roughness], name, "linear", { fallbackSlots: ormFallback });
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
                    captureTextureSlot(ctx, obj, "occlusionTexture", m.occlusionTexture, { texCoord: 1, rowOrder: "storage" }, name, strengthExtra(occlusionStrength));
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

function strengthExtra(strength: number): Readonly<Record<string, number>> | undefined {
    return strength !== 1 ? { strength } : undefined;
}

/** Clamp material factors to glTF's [0, 1] range, warning when any was outside it. */
function clampFactors(ctx: ExportContext, values: readonly number[], name: string): number[] {
    const out = values.map((v) => Math.min(Math.max(v, 0), 1));
    if (out.some((v, i) => v !== values[i])) {
        ctx.warn(`Material "${name}" has factors outside [0, 1], which glTF cannot represent; exporting them clamped.`);
    }
    return out;
}

function writeBaseColorFactor(ctx: ExportContext, pmr: GltfJsonObject, factor: readonly number[], name: string): void {
    const clamped = clampFactors(ctx, factor, name);
    if (!nearlyEqual(clamped, [1, 1, 1, 1], OMIT_EPSILON)) {
        pmr.baseColorFactor = clamped;
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
        writeMetallicRoughness(ctx, fold.owner, onBakeGrid(metallic! * (t[2]! / 255), byte), onBakeGrid(roughness! * (t[1]! / 255), byte), fold.materialName);
    }
}

/** Snap an in-range folded factor; out-of-range values pass through so the writers clamp and warn. */
function onBakeGrid(v: number, snap: (v: number) => number): number {
    return v >= 0 && v <= 1 ? snap(v) : v;
}

/** @internal Remove `pbrMetallicRoughness` objects that ended up with no members (after every slot,
 *  fold and `afterResolve` callback ran). */
export function finalizeMaterials(ctx: ExportContext): void {
    for (const material of ctx.doc.materials) {
        const pmr = material.pbrMetallicRoughness;
        if (pmr && Object.values(pmr).every((v) => v === undefined)) {
            delete material.pbrMetallicRoughness;
        }
    }
}

function exportStandardMaterial(ctx: ExportContext, m: StandardMaterialProps, out: GltfMaterial, uvState: UvState): void {
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
    };
    return mapping;
}
