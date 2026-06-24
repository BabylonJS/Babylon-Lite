/** KHR_animation_pointer — material factor / extension pointer writers + seeding.
 *
 *  Holds the metallic / normalScale / occlusion / transmission / IOR / volume /
 *  iridescence pointer writers and the load-time material seeding they need. This
 *  module is dynamic-imported by the animation-pointer feature ONLY when a channel
 *  targets one of these material pointers, so scenes that animate just node TRS /
 *  visibility / base-color / UV transforms / lights never pay for it. On import it
 *  appends its handlers to the shared resolver registry. */
import { _appendPointerHandlers, type PointerFactory, type PointerMaterial } from "./animation-pointer.js";

function iorToF0Factor(ior: number): number {
    return ((ior - 1) / (ior + 1)) ** 2 / 0.04;
}

function bump(mat: PointerMaterial): void {
    mat._uboVersion++;
}

const _extHandlers: [RegExp, PointerFactory][] = [
    // BJS 9.5 registers the glTF metallicFactor pointer twice, with the second
    // entry overwriting the first to animate PBRMaterial.roughness. Match that
    // behavior for parity; roughnessFactor itself is not registered by BJS.
    [
        /^\/materials\/(\d+)\/pbrMetallicRoughness\/metallicFactor$/,
        (m, ctx) => {
            const mat = ctx.materials?.[+m[1]!];
            if (!mat) {
                return null;
            }
            return {
                arity: 1,
                writer: (out, off) => {
                    mat.roughnessFactor = out[off]!;
                    mat._uboVersion++;
                },
            };
        },
    ],
    // /materials/{m}/normalTexture/scale — scalar glTF normal-map strength. The
    // shader scale mod is provided by the lazy pbr-template-ext (loaded for materials
    // that already carry a UV transform / vertex colour / UV2), so this writer only
    // updates the existing `normalScale` UBO slot — no core shader path is added.
    [
        /^\/materials\/(\d+)\/normalTexture\/scale$/,
        (m, ctx) => {
            const mat = ctx.materials?.[+m[1]!];
            if (!mat) {
                return null;
            }
            return {
                arity: 1,
                writer: (out, off) => {
                    mat.normalTextureScale = out[off]!;
                    mat._uboVersion++;
                },
            };
        },
    ],
    // /materials/{m}/extensions/KHR_materials_transmission/transmissionFactor
    [
        /^\/materials\/(\d+)\/extensions\/KHR_materials_transmission\/transmissionFactor$/,
        (m, ctx) => {
            const mat = ctx.materials?.[+m[1]!];
            const refr = mat?.subsurface?.refraction;
            if (!mat || !refr) {
                return null;
            }
            return {
                arity: 1,
                writer: (out, off) => {
                    mat.transmissive = true;
                    refr.intensity = out[off]!;
                    bump(mat);
                },
            };
        },
    ],
    // /materials/{m}/extensions/KHR_materials_ior/ior
    [
        /^\/materials\/(\d+)\/extensions\/KHR_materials_ior\/ior$/,
        (m, ctx) => {
            const mat = ctx.materials?.[+m[1]!];
            if (!mat) {
                return null;
            }
            return {
                arity: 1,
                writer: (out, off) => {
                    const ior = out[off]!;
                    if (mat.subsurface?.refraction) {
                        mat.subsurface.refraction.indexOfRefraction = ior;
                    }
                    mat.metallicF0Factor = iorToF0Factor(ior);
                    mat.specularWeight = 1.0;
                    mat._hasReflExt = true;
                    bump(mat);
                },
            };
        },
    ],
    // /materials/{m}/extensions/KHR_materials_volume/{thicknessFactor|attenuationDistance|attenuationColor}
    [
        /^\/materials\/(\d+)\/extensions\/KHR_materials_volume\/(thicknessFactor|attenuationDistance|attenuationColor)$/,
        (m, ctx) => {
            const mat = ctx.materials?.[+m[1]!];
            if (!mat?.subsurface) {
                return null;
            }
            return {
                arity: m[2] === "attenuationColor" ? 3 : 1,
                writer: (out, off) => {
                    const ss = mat.subsurface!;
                    if (m[2] === "thicknessFactor") {
                        ss.thickness ??= { min: 0, max: 0, useGlTFChannel: true };
                        ss.thickness.max = out[off]!;
                        if (ss.refraction) {
                            ss.refraction.useThicknessAsDepth = true;
                        }
                    } else {
                        ss.tint ??= { color: [1, 1, 1], atDistance: 1 };
                        if (m[2] === "attenuationDistance") {
                            ss.tint.atDistance = out[off]!;
                        } else {
                            ss.tint.color = [out[off]!, out[off + 1]!, out[off + 2]!];
                        }
                    }
                    bump(mat);
                },
            };
        },
    ],
    // /materials/{m}/extensions/KHR_materials_iridescence/{iridescenceFactor|iridescenceIor|iridescenceThicknessMaximum}
    [
        /^\/materials\/(\d+)\/extensions\/KHR_materials_iridescence\/(iridescenceFactor|iridescenceIor|iridescenceThicknessMaximum)$/,
        (m, ctx) => {
            const mat = ctx.materials?.[+m[1]!];
            const iri = mat?.iridescence;
            if (!mat || !iri) {
                return null;
            }
            return {
                arity: 1,
                writer: (out, off) => {
                    const v = out[off]!;
                    if (m[2] === "iridescenceFactor") {
                        iri.intensity = v;
                    } else if (m[2] === "iridescenceIor") {
                        iri.indexOfRefraction = v;
                    } else {
                        iri.maximumThickness = v;
                    }
                    bump(mat);
                },
            };
        },
    ],
    // /materials/{m}/occlusionTexture/strength — scalar ambient-occlusion strength.
    // The occlusion mix (mix(1, orm.r, strength)) is supplied by the lazy reflectance
    // ext, which the animation feature activates via `_hasReflExt`; this writer only
    // updates the `occlusionStrength` UBO slot that ext owns — zero core shader cost.
    [
        /^\/materials\/(\d+)\/occlusionTexture\/strength$/,
        (m, ctx) => {
            const mat = ctx.materials?.[+m[1]!];
            if (!mat) {
                return null;
            }
            return {
                arity: 1,
                writer: (out, off) => {
                    mat.occlusionStrength = out[off]!;
                    mat._uboVersion++;
                },
            };
        },
    ],
];

_appendPointerHandlers(_extHandlers);

/** Seed load-time material state so the material-extension pointer writers above have
 *  something to drive. A material whose transmission / IOR / volume / occlusion-strength
 *  is animated from its default (e.g. transmissionFactor 0, occlusionStrength 1) would
 *  otherwise compile without the relevant shader path, so the animation would write a
 *  value nothing samples. Called by the feature's materialMap once this module is loaded;
 *  `map` is indexed by glTF material index. */
export function seedExtMaterials(json: any, map: (PointerMaterial | undefined)[]): void {
    const occlusionStrengthAnimated = new Set<number>();
    const transmissionAnimated = new Set<number>();
    const iorAnimated = new Set<number>();
    const volumeThicknessAnimated = new Set<number>();
    const volumeTintAnimated = new Set<number>();
    for (const anim of json.animations ?? []) {
        for (const ch of anim.channels ?? []) {
            const ptr = ch.target?.extensions?.KHR_animation_pointer?.pointer as string | undefined;
            const os = ptr && /^\/materials\/(\d+)\/occlusionTexture\/strength$/.exec(ptr);
            if (os) {
                occlusionStrengthAnimated.add(+os[1]!);
            }
            const tr = ptr && /^\/materials\/(\d+)\/extensions\/KHR_materials_transmission\/transmissionFactor$/.exec(ptr);
            if (tr) {
                transmissionAnimated.add(+tr[1]!);
            }
            const ior = ptr && /^\/materials\/(\d+)\/extensions\/KHR_materials_ior\/ior$/.exec(ptr);
            if (ior) {
                iorAnimated.add(+ior[1]!);
            }
            const vt = ptr && /^\/materials\/(\d+)\/extensions\/KHR_materials_volume\/thicknessFactor$/.exec(ptr);
            if (vt) {
                volumeThicknessAnimated.add(+vt[1]!);
            }
            const vc = ptr && /^\/materials\/(\d+)\/extensions\/KHR_materials_volume\/(attenuationColor|attenuationDistance)$/.exec(ptr);
            if (vc) {
                volumeTintAnimated.add(+vc[1]!);
            }
        }
    }
    for (let matIdx = 0; matIdx < map.length; matIdx++) {
        const pm = map[matIdx];
        if (!pm) {
            continue;
        }
        const def = json.materials?.[matIdx];
        // An animated occlusionTexture.strength is applied through the lazy reflectance
        // ext (mix(1, orm.r, strength)). Route the material to it via `_hasReflExt` and
        // force activation even though the load-time strength may still be its default 1.0
        // (the ext's default-factor F0 path is identical to the base template).
        if (occlusionStrengthAnimated.has(matIdx)) {
            pm.occlusionStrength = def?.occlusionTexture?.strength ?? 1;
            pm._hasReflExt = true;
            (pm as { _occlStrengthAnimated?: boolean })._occlStrengthAnimated = true;
        }
        if (transmissionAnimated.has(matIdx)) {
            pm.transmissive = true;
            pm.subsurface ??= {};
            pm.subsurface.refraction ??= {
                intensity: def?.extensions?.KHR_materials_transmission?.transmissionFactor ?? 0,
                indexOfRefraction: def?.extensions?.KHR_materials_ior?.ior ?? 1.5,
            };
        }
        if (iorAnimated.has(matIdx)) {
            pm.subsurface ??= {};
            pm.subsurface.refraction ??= { intensity: 0, indexOfRefraction: def?.extensions?.KHR_materials_ior?.ior ?? 1.5 };
            const ior = def?.extensions?.KHR_materials_ior?.ior ?? 1.5;
            pm.metallicF0Factor = iorToF0Factor(ior);
            pm.specularWeight = 1.0;
            pm._hasReflExt = true;
        }
        if (volumeThicknessAnimated.has(matIdx) || volumeTintAnimated.has(matIdx)) {
            pm.subsurface ??= {};
            const eVol = def?.extensions?.KHR_materials_volume;
            if (volumeThicknessAnimated.has(matIdx)) {
                pm.subsurface.thickness ??= { min: 0, max: eVol?.thicknessFactor ?? 0, useGlTFChannel: true };
                if (pm.subsurface.refraction) {
                    pm.subsurface.refraction.useThicknessAsDepth = true;
                }
            }
            if (volumeTintAnimated.has(matIdx)) {
                pm.subsurface.tint ??= { color: eVol?.attenuationColor ?? [1, 1, 1], atDistance: eVol?.attenuationDistance ?? 1 };
            }
        }
    }
}
