/** glTF KHR_materials_diffuse_transmission extension.
 *
 *  Maps onto the engine's subsurface translucency model (BJS PBRSubSurface
 *  isTranslucencyEnabled):
 *    diffuseTransmissionFactor       → translucency.intensity
 *    diffuseTransmissionColorFactor  → translucency.color (linear RGB)
 *    diffuseTransmissionColorTexture → translucency.colorTexture (sRGB, RGB)
 *    diffuseTransmissionTexture      → translucency.intensityTexture (A channel)
 *
 *  No KHR_materials_volume is required: the translucency path uses the default
 *  unit thickness so a thin surface diffusely transmits the back-hemisphere
 *  irradiance, tinted by the transmission color. */
import type { GltfFeature } from "./gltf-feature.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";

const ext: GltfFeature = {
    id: "KHR_materials_diffuse_transmission",
    async applyMaterial(mat, ctx) {
        const e = mat._rawMatDef?.extensions?.KHR_materials_diffuse_transmission;
        if (!e) {
            return null;
        }
        const intensity: number = typeof e.diffuseTransmissionFactor === "number" ? e.diffuseTransmissionFactor : 0;
        const [colorTex, intensityTex] = await Promise.all([ctx._texture(e.diffuseTransmissionColorTexture, true), ctx._texture(e.diffuseTransmissionTexture, false)]);
        if (intensity <= 0 && !colorTex && !intensityTex) {
            return null;
        }
        const cf = Array.isArray(e.diffuseTransmissionColorFactor) && e.diffuseTransmissionColorFactor.length === 3 ? e.diffuseTransmissionColorFactor : [1, 1, 1];
        const out: Partial<PbrMaterialProps> = {
            subsurface: {
                translucency: {
                    intensity,
                    color: [cf[0], cf[1], cf[2]],
                    ...(colorTex ? { colorTexture: colorTex } : undefined),
                    ...(intensityTex ? { intensityTexture: intensityTex } : undefined),
                },
                // Thin-surface diffuse transmission has no volume: BJS sets
                // min = max = 0 so the Burley transmittance collapses to exactly
                // the tint color (thickness clamps to epsilon, temp → 1).
                thickness: { min: 0, max: 0 },
            },
        };
        return out;
    },
};
export default ext;
