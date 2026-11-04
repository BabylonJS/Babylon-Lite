/** Combined loader for the glTF extensions commonly used together for
 *  dielectric / glass-like materials — KHR_materials_ior, _specular,
 *  _transmission, _volume, and _dispersion.
 *
 *  All four are consolidated into a single ext so:
 *   - the three that populate `subsurface` (ior + volume + transmission)
 *     don't need a deep-merge in `runMatExts` (each would otherwise overwrite
 *     the others' subsurface contributions);
 *   - load-gltf.ts pays only one registration-table entry for the whole set.
 *
 *  Loaded when ANY of the four extensions is declared in extensionsUsed.
 *  Only fields actually declared on each material are populated.
 *
 *  KHR_materials_ior:
 *    ior → subsurface.refraction.indexOfRefraction
 *        + base-layer F0 remap (F0 = ((ior-1)/(ior+1))^2).
 *
 *  KHR_materials_specular:
 *    specularFactor        → metallicF0Factor (scalar F0 multiplier)
 *    specularColorFactor   → metallicReflectanceColor (dielectric tint)
 *    specularTexture       → metallicReflectanceTexture (A=F0 scalar)
 *                             (useOnlyMetallicFromMetallicReflectanceTexture=true)
 *    specularColorTexture  → reflectanceTexture (RGB=dielectric tint)
 *
 *  KHR_materials_volume:
 *    thicknessFactor/Texture → subsurface.thickness (G-channel per spec)
 *    attenuationColor/Distance → subsurface.tint
 *
 *  KHR_materials_transmission:
 *    transmissionFactor/Texture → subsurface.refraction.intensity/texture
 *
 *  PR 1 wires the data only — the PBR refraction shader path lands in PR 2.
 *  Until then, transmissive materials render as opaque. */
import type { GltfFeature } from "./gltf-feature.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import type { MetallicReflectanceOptions } from "../material/pbr/set-metallic-reflectance.js";

const ext: GltfFeature = {
    id: "KHR_materials_dielectric",
    async applyMaterial(mat, ctx) {
        const exts = mat._rawMatDef?.extensions;
        if (!exts) {
            return null;
        }
        const eIor = exts.KHR_materials_ior;
        const eSp = exts.KHR_materials_specular;
        const eVol = exts.KHR_materials_volume;
        const eTx = exts.KHR_materials_transmission;
        const eDisp = exts.KHR_materials_dispersion;
        if (!eIor && !eSp && !eVol && !eTx && !eDisp) {
            return null;
        }

        // Each setter statically imports its extension implementation — that is exactly how
        // the opt-in pattern works, and it is why they must NOT be imported statically here.
        // A static import makes every asset that merely *declares* a dielectric extension
        // (KHR_materials_ior/_specular are near-universal in modern exporters) pay for the
        // whole refraction/transmission stack: this handler is ~1 KB, but the chunk a static
        // import dragged in was ~21 KB, charged even to assets with no transmissive material.
        //
        // This differs from the probe-style dynamic imports removed from pbr-renderable.ts,
        // where the probe itself was the cost being eliminated. Here the decision is genuinely
        // asset-driven and only knowable at runtime, so a dynamic import is the right tool.
        //
        // The predicates below read the raw extension JSON so each fetch starts as soon as we
        // know it is needed: the imports are issued alongside the texture loads and overlap
        // with them, rather than serialising after the textures resolve.
        //
        // INVARIANT: every `needs*` predicate must remain a SUPERSET of the guard at its call
        // site. They test whether a texture is *declared*, while the guards test whether it
        // actually loaded. Being over-eager costs at most one unused fetch; being under-eager
        // would silently skip the setter.
        const ior: number = typeof eIor?.ior === "number" ? eIor.ior : 1.5;
        const intensity: number = typeof eTx?.transmissionFactor === "number" ? eTx.transmissionFactor : 0;
        const thicknessFactor: number = typeof eVol?.thicknessFactor === "number" ? eVol.thicknessFactor : 0;
        const dispersion: number = typeof eDisp?.dispersion === "number" ? eDisp.dispersion : 0;
        const specColFactor = eSp?.specularColorFactor;

        const needsTransmission = !!eTx && (intensity > 0 || !!eTx.transmissionTexture);
        // NOTE: `subsurface.refraction` is set either by the `eIor` block below OR by
        // setPbrTransmission itself (set-transmission.ts does `(mat._subsurface ??= {}).refraction = ...`
        // and mutates `subsurface` in place), so dispersion must account for both paths.
        const needsDispersion = dispersion > 0 && (!!eIor || needsTransmission) && !!eVol && (thicknessFactor > 0 || !!eVol.thicknessTexture);
        const needsReflectance =
            !!eSp?.specularTexture ||
            !!eSp?.specularColorTexture ||
            (!!eIor && ior !== 1.5) ||
            (typeof eSp?.specularFactor === "number" && Math.abs(eSp.specularFactor - 1) > 1e-6) ||
            (Array.isArray(specColFactor) && specColFactor.length === 3 && (specColFactor[0] !== 1 || specColFactor[1] !== 1 || specColFactor[2] !== 1));

        const [specTex, specColTex, thickTex, transTex, transmissionMod, dispersionMod, reflectanceMod] = await Promise.all([
            ctx._texture(eSp?.specularTexture, false),
            // specularColorTexture is sRGB-encoded, but the reflectance shader applies its
            // own pow(2.2) (matching BJS toLinearSpace on a gammaSpace texture). Load it as
            // a LINEAR-format texture so the GPU does NOT also sRGB-decode on sample — else
            // the dielectric tint is gamma-decoded twice (too dark/saturated), as seen on
            // AnimationPointerUVs col4 specularColorTexture spheres.
            ctx._texture(eSp?.specularColorTexture, false),
            ctx._texture(eVol?.thicknessTexture, false),
            ctx._texture(eTx?.transmissionTexture, false),
            needsTransmission ? import("../material/pbr/set-transmission.js") : undefined,
            needsDispersion ? import("../material/pbr/set-dispersion.js") : undefined,
            needsReflectance ? import("../material/pbr/set-metallic-reflectance.js") : undefined,
        ]);

        const out: Partial<PbrMaterialProps> = {};
        const subsurface: NonNullable<PbrMaterialProps["_subsurface"]> = {};
        // Dielectric-reflectance fields are collected here and applied once at the end via
        // setPbrMetallicReflectance, which writes them onto `out` AND registers the
        // reflectance ext (fragment statically imported by the setter). `hasRefl` mirrors
        // the old `_hasReflExt` flag: it forces registration for factor-only cases (no
        // texture) such as a non-default IOR.
        const reflOpts: MetallicReflectanceOptions = {};
        let hasRefl = false;

        if (eIor) {
            // Skip writing metallicF0Factor at default IOR 1.5 (F0=0.04 → factor=1).
            // JS floats compute ((0.5/2.5)^2)/0.04 as 1.0000000000000002, which
            // would trigger the reflectance-factor code path and pull in the
            // reflectance fragment for every KHR_materials_ior scene with
            // default IOR. Only write when the factor meaningfully differs.
            if (ior !== 1.5) {
                reflOpts.f0Factor = ((ior - 1) / (ior + 1)) ** 2 / 0.04;
                reflOpts.specularWeight = 1.0;
                hasRefl = true;
            }
            subsurface.refraction = { indexOfRefraction: ior };
        }

        if (eSp) {
            // specularFactor replaces the base dielectric F0 scalar. When ior was
            // also specified, this overrides it (spec says specular wins).
            if (typeof eSp.specularFactor === "number") {
                if (Math.abs(eSp.specularFactor - 1) > 1e-6) {
                    reflOpts.f0Factor = eSp.specularFactor;
                    reflOpts.specularWeight = eSp.specularFactor;
                    hasRefl = true;
                } else {
                    delete reflOpts.f0Factor;
                    delete reflOpts.specularWeight;
                }
            }
            if (Array.isArray(eSp.specularColorFactor) && eSp.specularColorFactor.length === 3) {
                if (eSp.specularColorFactor[0] !== 1 || eSp.specularColorFactor[1] !== 1 || eSp.specularColorFactor[2] !== 1) {
                    reflOpts.color = [eSp.specularColorFactor[0], eSp.specularColorFactor[1], eSp.specularColorFactor[2]];
                    hasRefl = true;
                }
            }
            if (specTex) {
                reflOpts.texture = specTex;
                reflOpts.useOnlyMetallicFromTexture = true;
            }
            if (specColTex) {
                reflOpts.reflectanceTexture = specColTex;
            }
        }

        if (eVol) {
            if (thicknessFactor > 0 || thickTex) {
                subsurface.thickness = {
                    min: 0,
                    max: thicknessFactor || 1,
                    useGlTFChannel: true,
                    ...(thickTex ? { texture: thickTex } : undefined),
                };
            }
            const color = Array.isArray(eVol.attenuationColor) && eVol.attenuationColor.length === 3 ? (eVol.attenuationColor as [number, number, number]) : undefined;
            const atDistance: number | undefined = typeof eVol.attenuationDistance === "number" ? eVol.attenuationDistance : undefined;
            if (color || atDistance !== undefined) {
                subsurface.tint = {
                    ...(color ? { color } : undefined),
                    ...(atDistance !== undefined ? { atDistance } : undefined),
                };
            } else if (subsurface.thickness) {
                // KHR_materials_volume without attenuation: spec defaults to white at
                // infinite distance (no absorption), but the thickness is a real local
                // depth that must engage the volume path so it is world-scaled (else it
                // overshoots on non-unit-scaled models, e.g. MosquitoInAmber). White tint
                // gives volumeParams = log(1)/dist = 0 → ab = exp(0) = 1 (no tint).
                subsurface.tint = { color: [1, 1, 1], atDistance: 1 };
            }
        }

        // `transmissionMod` is non-undefined exactly when `needsTransmission` held, which is a
        // superset of this guard (it accepts a declared transmissionTexture that failed to load).
        if (transmissionMod && (intensity > 0 || transTex)) {
            // Route through the setter so the transmission scene hook (frame-graph
            // rewiring + refraction ext) gets registered. Publishing `subsurface` onto
            // `out` first lets the setter mutate it in place — the tail assignment
            // below is then a no-op.
            out._subsurface = subsurface;
            transmissionMod.setPbrTransmission(out, {
                ...(subsurface.refraction ?? {}),
                intensity,
                useThicknessAsDepth: !!subsurface.thickness,
                ...(transTex ? { texture: transTex } : undefined),
            });
        }

        // KHR_materials_dispersion: per-channel chromatic refraction. Only meaningful on
        // a volumetric transmissive material (the extension requires KHR_materials_volume).
        // The shader spread uses Babylon's empirical dispersion strength with a fixed Abbe
        // number of 20, so the glTF dispersion value maps to strength = 20 / dispersion
        // (larger glTF dispersion ⇒ larger Abbe ⇒ weaker chromatic spread).
        if (dispersionMod && subsurface.refraction && subsurface.thickness) {
            out._subsurface = subsurface;
            dispersionMod.setPbrDispersion(out, 20.0 / dispersion);
        }

        if (Object.keys(subsurface).length > 0) {
            out._subsurface = subsurface;
        }
        // Apply the reflectance ext when any dielectric-reflectance field was populated.
        // setPbrMetallicReflectance writes the fields onto `out` and registers the ext.
        // Refraction/volume subsurface data does NOT register the reflectance ext.
        if (reflectanceMod && (reflOpts.texture || reflOpts.reflectanceTexture || hasRefl)) {
            reflectanceMod.setPbrMetallicReflectance(out, reflOpts);
        }
        return Object.keys(out).length > 0 ? out : null;
    },
};
export default ext;
