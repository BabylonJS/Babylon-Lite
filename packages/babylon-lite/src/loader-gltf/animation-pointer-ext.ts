/** KHR_animation_pointer — material factor / extension pointer writers + seeding.
 *
 *  Holds the metallic / normalScale / occlusion / transmission / IOR / volume /
 *  iridescence pointer writers and the load-time material seeding they need. This
 *  module is dynamic-imported by the animation-pointer feature ONLY when a channel
 *  targets one of these material pointers, so scenes that animate just node TRS /
 *  visibility / base-color / UV transforms / lights never pay for it. On import it
 *  appends its handlers to the shared resolver registry. */
import { _appendPointerHandlers, type PointerFactory, type PointerMaterial } from "./animation-pointer.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import type { setPbrMetallicReflectance } from "../material/pbr/set-metallic-reflectance.js";

/** Seeds load-time material state for one asset's material-extension pointers. Returned by
 *  {@link prepareExtMaterials}, which is the only way to obtain one — so the async setup it
 *  depends on is a data dependency rather than a call-order convention. `map` is indexed by
 *  glTF material index. */
export type ExtMaterialSeeder = (map: (PointerMaterial | undefined)[]) => void;

interface AnimatedExtTargets {
    occlusionStrength: Set<number>;
    transmission: Set<number>;
    ior: Set<number>;
    volumeThickness: Set<number>;
    volumeTint: Set<number>;
}

/** Scan the asset's pointer channels for the material-extension families this module seeds. */
function animatedTargets(json: any): AnimatedExtTargets {
    const occlusionStrength = new Set<number>();
    const transmission = new Set<number>();
    const ior = new Set<number>();
    const volumeThickness = new Set<number>();
    const volumeTint = new Set<number>();
    for (const anim of json.animations ?? []) {
        for (const ch of anim.channels ?? []) {
            const ptr = ch.target?.extensions?.KHR_animation_pointer?.pointer as string | undefined;
            if (!ptr) {
                continue;
            }
            const os = /^\/materials\/(\d+)\/occlusionTexture\/strength$/.exec(ptr);
            if (os) {
                occlusionStrength.add(+os[1]!);
            }
            const tr = /^\/materials\/(\d+)\/extensions\/KHR_materials_transmission\/transmissionFactor$/.exec(ptr);
            if (tr) {
                transmission.add(+tr[1]!);
            }
            const io = /^\/materials\/(\d+)\/extensions\/KHR_materials_ior\/ior$/.exec(ptr);
            if (io) {
                ior.add(+io[1]!);
            }
            const vt = /^\/materials\/(\d+)\/extensions\/KHR_materials_volume\/thicknessFactor$/.exec(ptr);
            if (vt) {
                volumeThickness.add(+vt[1]!);
            }
            const vc = /^\/materials\/(\d+)\/extensions\/KHR_materials_volume\/(attenuationColor|attenuationDistance)$/.exec(ptr);
            if (vc) {
                volumeTint.add(+vc[1]!);
            }
        }
    }
    return { occlusionStrength, transmission, ior, volumeThickness, volumeTint };
}

/** Scan one asset's material-extension pointers, fetch the opt-in setters its seeding needs,
 *  and return the seeder bound to both. Awaited by the feature's `preParse`; the returned
 *  function is then called synchronously from `materialMap`.
 *
 *  `setPbrMetallicReflectance` statically imports the reflectance fragment, so it is fetched
 *  only for assets that animate occlusion strength or IOR — the two seeding paths that must
 *  force-activate the reflectance ext even at its default values. An asset animating only
 *  transmission or volume pays nothing for it. */
export async function prepareExtMaterials(json: any): Promise<ExtMaterialSeeder> {
    const animated = animatedTargets(json);
    const needsReflectance = animated.occlusionStrength.size > 0 || animated.ior.size > 0;
    const setReflectance = needsReflectance ? (await import("../material/pbr/set-metallic-reflectance.js")).setPbrMetallicReflectance : null;
    return (map) => seedExtMaterials(json, map, animated, setReflectance);
}

/** `PointerMaterial` is the loader's structural view of the same PBR material object; its
 *  texture fields are the loader's wrapped handles, so bridge to the setter's props type. */
function asPbrProps(m: PointerMaterial): Partial<PbrMaterialProps> {
    return m as unknown as Partial<PbrMaterialProps>;
}

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
            const refr = mat?._subsurface?.refraction;
            if (!mat || !refr) {
                return null;
            }
            return {
                arity: 1,
                writer: (out, off) => {
                    mat._transmissive = true;
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
                    if (mat._subsurface?.refraction) {
                        mat._subsurface.refraction.indexOfRefraction = ior;
                    }
                    mat._metallicF0Factor = iorToF0Factor(ior);
                    mat._specularWeight = 1.0;
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
            if (!mat?._subsurface) {
                return null;
            }
            return {
                arity: m[2] === "attenuationColor" ? 3 : 1,
                writer: (out, off) => {
                    const ss = mat._subsurface!;
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
            const iri = mat?._iridescence;
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
    // ext, which the seeding path below registers; this writer only updates the
    // `occlusionStrength` UBO slot that ext owns — zero core shader cost.
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
 *  value nothing samples. Reached only through the seeder {@link prepareExtMaterials}
 *  returns, so `animated` and `setReflectance` always match the asset being seeded. */
function seedExtMaterials(json: any, map: (PointerMaterial | undefined)[], animated: AnimatedExtTargets, setReflectance: typeof setPbrMetallicReflectance | null): void {
    for (let matIdx = 0; matIdx < map.length; matIdx++) {
        const pm = map[matIdx];
        if (!pm) {
            continue;
        }
        const def = json.materials?.[matIdx];
        // An animated occlusionTexture.strength is applied through the reflectance ext
        // (mix(1, orm.r, strength)). Register that ext with no factor overrides so it
        // activates even though the load-time strength may still be its default 1.0
        // (the ext's default-factor F0 path is identical to the base template).
        if (animated.occlusionStrength.has(matIdx)) {
            pm.occlusionStrength = def?.occlusionTexture?.strength ?? 1;
            setReflectance?.(asPbrProps(pm), {});
            (pm as { _occlStrengthAnimated?: boolean })._occlStrengthAnimated = true;
        }
        if (animated.transmission.has(matIdx)) {
            pm._transmissive = true;
            pm._subsurface ??= {};
            pm._subsurface.refraction ??= {
                intensity: def?.extensions?.KHR_materials_transmission?.transmissionFactor ?? 0,
                indexOfRefraction: def?.extensions?.KHR_materials_ior?.ior ?? 1.5,
            };
        }
        if (animated.ior.has(matIdx)) {
            pm._subsurface ??= {};
            pm._subsurface.refraction ??= { intensity: 0, indexOfRefraction: def?.extensions?.KHR_materials_ior?.ior ?? 1.5 };
            const ior = def?.extensions?.KHR_materials_ior?.ior ?? 1.5;
            // Registers the reflectance ext even at the default IOR 1.5, since the pointer
            // writer can animate it away from the default at any time.
            setReflectance?.(asPbrProps(pm), { f0Factor: iorToF0Factor(ior), specularWeight: 1.0 });
        }
        if (animated.volumeThickness.has(matIdx) || animated.volumeTint.has(matIdx)) {
            pm._subsurface ??= {};
            const eVol = def?.extensions?.KHR_materials_volume;
            if (animated.volumeThickness.has(matIdx)) {
                pm._subsurface.thickness ??= { min: 0, max: eVol?.thicknessFactor ?? 0, useGlTFChannel: true };
                if (pm._subsurface.refraction) {
                    pm._subsurface.refraction.useThicknessAsDepth = true;
                }
            }
            if (animated.volumeTint.has(matIdx)) {
                pm._subsurface.tint ??= { color: eVol?.attenuationColor ?? [1, 1, 1], atDistance: eVol?.attenuationDistance ?? 1 };
            }
        }
    }
}
