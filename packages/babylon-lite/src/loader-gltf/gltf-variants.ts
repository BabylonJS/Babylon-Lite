/**
 * KHR_materials_variants — glTF parsing + GPU upload for variant materials.
 *
 * Dynamically imported by load-gltf.ts ONLY when the extension is present.
 * This keeps variant code fully tree-shaken from bundles that don't use it.
 */

import type { Mesh } from "../mesh/mesh.js";
import type { PbrMaterialPropsInternal } from "../material/pbr/pbr-material.js";
import type { GltfMaterialData, GltfMatExtCtx } from "./gltf-material.js";
import { assembleMaterial, makeImageFetcher } from "./gltf-material.js";
import type { GltfFeature } from "./gltf-feature.js";
import type { MaterialVariantData, VariantMeshEntry } from "./material-variants.js";
import type { EngineContextInternal } from "../engine/engine.js";
import { getOrCreateSampler } from "../resource/gpu-pool.js";
import { runMatExts, uploadTex, type GenerateMipmapsFn, type TextureWrapFn, identityTexWrap } from "./gltf-pbr-builder.js";
import { buildDefaultPbrTexturesExt, assemblePbrPropsExt } from "./gltf-pbr-builder-ext.js";

/**
 * Self-contained variant material loader.
 * Parses variant mappings from glTF JSON primitives, assembles + uploads variant materials,
 * and builds MaterialVariantData. Called only when KHR_materials_variants is present.
 */
export async function loadVariantMaterials(
    json: any,
    binChunk: DataView,
    baseUrl: string,
    variantNames: string[],
    meshes: Mesh[],
    engine: EngineContextInternal,
    exts: GltfFeature[],
    wrapTex: TextureWrapFn = identityTexWrap
): Promise<MaterialVariantData> {
    const generateMipmaps: GenerateMipmapsFn = (await import("../texture/generate-mipmaps.js")).generateMipmaps;

    const sampler = getOrCreateSampler(engine, {
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
        addressModeU: "repeat",
        addressModeV: "repeat",
        maxAnisotropy: 4,
    });

    const matCache = new Map<number, Promise<GltfMaterialData>>();
    const imageCache = new Map<number, Promise<ImageBitmap>>();
    const fetchImg = makeImageFetcher(json, binChunk, baseUrl, imageCache);
    const getCachedTex = (bitmap: ImageBitmap, srgb: boolean) => uploadTex(engine, bitmap, srgb, sampler, generateMipmaps);
    const extCtx: GltfMatExtCtx = {
        _engine: engine,
        async _texture(texInfo, sRGB) {
            if (!texInfo) {
                return undefined;
            }
            const img = await fetchImg(texInfo);
            return img ? wrapTex(uploadTex(engine, img, sRGB, sampler, generateMipmaps), texInfo) : undefined;
        },
        _uploadImage(bitmap, sRGB) {
            return uploadTex(engine, bitmap, sRGB, sampler, generateMipmaps);
        },
    };
    const getMat = (matIdx: number): Promise<GltfMaterialData> => {
        let p = matCache.get(matIdx);
        if (!p) {
            p = assembleMaterial(json, binChunk, matIdx, baseUrl, imageCache);
            matCache.set(matIdx, p);
        }
        return p;
    };

    const pbrCache = new Map<GltfMaterialData, Promise<PbrMaterialPropsInternal>>();
    const getPbr = (gltfMat: GltfMaterialData): Promise<PbrMaterialPropsInternal> => {
        let p = pbrCache.get(gltfMat);
        if (!p) {
            p = (async () => {
                const tex = buildDefaultPbrTexturesExt(engine, gltfMat, sampler, generateMipmaps, getCachedTex, wrapTex);
                const layers = await runMatExts(gltfMat, exts, extCtx);
                return assemblePbrPropsExt(gltfMat, tex, layers);
            })();
            pbrCache.set(gltfMat, p);
        }
        return p;
    };

    const originals: VariantMeshEntry[] = [];
    const variants: Record<string, VariantMeshEntry[]> = {};
    for (const name of variantNames) {
        variants[name] = [];
    }

    let meshIdx = 0;
    for (let nodeIdx = 0; nodeIdx < json.nodes.length; nodeIdx++) {
        const node = json.nodes[nodeIdx];
        if (node.mesh === undefined) {
            continue;
        }
        const gltfMesh = json.meshes[node.mesh];
        for (const primitive of gltfMesh.primitives) {
            const mesh = meshes[meshIdx]!;
            const variantExt = primitive.extensions?.KHR_materials_variants;
            if (variantExt?.mappings) {
                originals.push({ mesh, material: mesh.material });
                for (const mapping of variantExt.mappings as { material: number; variants: number[] }[]) {
                    const gltfMat = await getMat(mapping.material);
                    const pbrMat = await getPbr(gltfMat);
                    for (const vi of mapping.variants) {
                        const name = variantNames[vi];
                        if (name) {
                            variants[name]!.push({ mesh, material: pbrMat });
                        }
                    }
                }
            }
            meshIdx++;
        }
    }

    return { names: variantNames, variants, originals };
}
