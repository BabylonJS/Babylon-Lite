import type { PbrMaterialProps } from "./pbr-material.js";
import { hasTextureTransform } from "../../texture/texture-metadata.js";
import { createMeshLoDError } from "../../mesh-lod/mesh-lod-errors.js";
import { getPbrMetallicReflectance } from "./pbr-material-accessors.js";

/** Reject unsupported features at both scene registration and material build. */
export function validateMeshLoDMaterial(material: PbrMaterialProps): void {
    const reject = (feature: string): never => {
        throw createMeshLoDError("MLOD_UNSUPPORTED_MATERIAL", `MeshLoD v1 does not support ${feature}`, { expected: "opaque metallic-roughness", actual: feature });
    };
    if (material.alphaBlend === true) {
        reject("alpha blending");
    }
    if (material._alphaCutOff !== undefined) {
        reject("alpha masking");
    }
    if (material._gammaAlbedo) {
        reject("gamma-albedo decoding");
    }
    if (material.lightmapTexture) {
        reject("lightmaps");
    }
    if (getPbrMetallicReflectance(material) !== undefined) {
        reject("dielectric-reflectance extensions");
    }
    if (material._transmissive) {
        reject("transmission");
    }
    if (material._clearCoat) {
        reject("clearcoat");
    }
    if (material._sheen) {
        reject("sheen");
    }
    if (material._iridescence) {
        reject("iridescence");
    }
    if (material._anisotropy) {
        reject("anisotropy");
    }
    if (material._subsurface) {
        reject("subsurface");
    }
    if (material.specGlossTexture) {
        reject("specular-glossiness");
    }
    if (material.plugins?.length) {
        reject("material plugins");
    }
    if (material.occlusionTexCoord === 1 || material._uv2Mask) {
        reject("a second UV set");
    }
    if (
        material._hasUvTx ||
        [material.baseColorTexture, material.normalTexture, material.ormTexture, material.emissiveTexture].some(
            (texture) => texture && (hasTextureTransform(texture) || texture.invertY === true)
        )
    ) {
        reject("per-texture UV transforms");
    }
    if (material._shadowOnly || material._skyboxMode) {
        reject("shadow-only or skybox materials");
    }
}
