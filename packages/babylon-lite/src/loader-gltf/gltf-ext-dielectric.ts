/** Combined loader for the four glTF extensions commonly used together for
 *  dielectric / glass-like materials — KHR_materials_ior, _specular,
 *  _transmission, and _volume.
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
import type { PbrMaterialProps, RefractionProps } from "../material/pbr/pbr-material.js";

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
        if (!eIor && !eSp && !eVol && !eTx) {
            return null;
        }

        const [specTex, specColTex, thickTex, transTex] = await Promise.all([
            ctx._texture(eSp?.specularTexture, false),
            ctx._texture(eSp?.specularColorTexture, true),
            ctx._texture(eVol?.thicknessTexture, false),
            ctx._texture(eTx?.transmissionTexture, false),
        ]);

        const out: Partial<PbrMaterialProps> = {};
        const subsurface: NonNullable<PbrMaterialProps["subsurface"]> = {};

        if (eIor) {
            const ior: number = typeof eIor.ior === "number" ? eIor.ior : 1.5;
            // Skip writing metallicF0Factor at default IOR 1.5 (F0=0.04 → factor=1).
            // JS floats compute ((0.5/2.5)^2)/0.04 as 1.0000000000000002, which
            // would trigger the reflectance-factor code path and pull in the
            // reflectance fragment for every KHR_materials_ior scene with
            // default IOR. Only write when the factor meaningfully differs.
            if (ior !== 1.5) {
                out.metallicF0Factor = ((ior - 1) / (ior + 1)) ** 2 / 0.04;
                (out as { _hasReflExt?: boolean })._hasReflExt = true;
            }
            subsurface.refraction = { indexOfRefraction: ior };
        }

        if (eSp) {
            // specularFactor replaces the base dielectric F0 scalar. When ior was
            // also specified, this overrides it (spec says specular wins).
            if (typeof eSp.specularFactor === "number") {
                if (Math.abs(eSp.specularFactor - 1) > 1e-6) {
                    out.metallicF0Factor = eSp.specularFactor;
                    (out as { _hasReflExt?: boolean })._hasReflExt = true;
                } else {
                    delete out.metallicF0Factor;
                }
            }
            if (Array.isArray(eSp.specularColorFactor) && eSp.specularColorFactor.length === 3) {
                if (eSp.specularColorFactor[0] !== 1 || eSp.specularColorFactor[1] !== 1 || eSp.specularColorFactor[2] !== 1) {
                    out.metallicReflectanceColor = [eSp.specularColorFactor[0], eSp.specularColorFactor[1], eSp.specularColorFactor[2]];
                    (out as { _hasReflExt?: boolean })._hasReflExt = true;
                }
            }
            if (specTex) {
                out.metallicReflectanceTexture = specTex;
                out.useOnlyMetallicFromMetallicReflectanceTexture = true;
            }
            if (specColTex) {
                out.reflectanceTexture = specColTex;
            }
        }

        if (eVol) {
            const thicknessFactor: number = typeof eVol.thicknessFactor === "number" ? eVol.thicknessFactor : 0;
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
            }
        }

        if (eTx) {
            const intensity: number = typeof eTx.transmissionFactor === "number" ? eTx.transmissionFactor : 0;
            if (intensity > 0 || transTex) {
                out.transmissive = true;
                const refraction: RefractionProps = {
                    ...(subsurface.refraction ?? {}),
                    intensity,
                    useThicknessAsDepth: !!subsurface.thickness,
                    ...(transTex ? { texture: transTex } : undefined),
                };
                subsurface.refraction = refraction;
            }
        }

        if (Object.keys(subsurface).length > 0) {
            out.subsurface = subsurface;
        }
        return Object.keys(out).length > 0 ? out : null;
    },
};
export default ext;
