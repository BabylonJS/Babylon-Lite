/**
 * KHR_materials_variants — glTF parsing + GPU upload for variant materials.
 *
 * Dynamically imported by load-gltf.ts ONLY when the extension is present.
 * This keeps variant code fully tree-shaken from bundles that don't use it.
 */

import type { Mesh } from "../mesh/mesh.js";
import type { PbrMaterialPropsInternal } from "../material/pbr/pbr-material.js";
import { pbrGroupBuilder } from "../material/pbr/pbr-material.js";
import type { GltfMaterialData } from "./gltf-material.js";
import { assembleMaterial } from "./gltf-material.js";
import type { MaterialVariantData, VariantMeshEntry } from "./material-variants.js";
import type { EngineContextInternal } from "../engine/engine.js";
import { getOrCreateSampler } from "../resource/gpu-pool.js";
import { mipLevelCount } from "../texture/mip-count.js";
import { linearToSrgbByte } from "../color/color.js";

let _generateMipmaps: ((engine: EngineContextInternal, texture: GPUTexture) => void) | null = null;

function uploadTex(engine: EngineContextInternal, bitmap: ImageBitmap | null, srgb: boolean, sampler: GPUSampler, fallback?: Uint8Array) {
    const device = engine.device;
    const w = bitmap?.width ?? 1;
    const h = bitmap?.height ?? 1;
    const fmt: GPUTextureFormat = srgb ? "rgba8unorm-srgb" : "rgba8unorm";
    const mips = bitmap ? mipLevelCount(w, h) : 1;
    const tex = device.createTexture({
        size: { width: w, height: h },
        format: fmt,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
        mipLevelCount: mips,
    });
    if (bitmap) {
        device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: tex, premultipliedAlpha: false }, { width: w, height: h });
        _generateMipmaps!(engine, tex);
    } else {
        device.queue.writeTexture({ texture: tex }, (fallback ?? new Uint8Array([255, 255, 255, 255])) as Uint8Array<ArrayBuffer>, { bytesPerRow: 4 }, { width: 1, height: 1 });
    }
    return { texture: tex, view: tex.createView(), sampler, width: w, height: h };
}

async function buildPbr(engine: EngineContextInternal, mat: GltfMaterialData, sampler: GPUSampler): Promise<PbrMaterialPropsInternal> {
    const baseColorTexture = mat.baseColorImage
        ? uploadTex(engine, mat.baseColorImage, true, sampler)
        : (() => {
              const f = mat.baseColorFactor;
              return uploadTex(
                  engine,
                  null,
                  true,
                  sampler,
                  new Uint8Array([linearToSrgbByte(f[0]), linearToSrgbByte(f[1]), linearToSrgbByte(f[2]), Math.round(Math.max(0, Math.min(1, f[3])) * 255)])
              );
          })();
    const normalTexture = mat.normalImage ? uploadTex(engine, mat.normalImage, false, sampler) : undefined;
    const emissiveTexture = mat.emissiveImage ? uploadTex(engine, mat.emissiveImage, true, sampler) : undefined;
    const specGlossTexture = mat.specGlossImage ? uploadTex(engine, mat.specGlossImage, true, sampler) : undefined;

    // ORM
    const mrImg = mat.metallicRoughnessImage;
    const occImg = mat.occlusionImage;
    let ormTexture;
    if (mrImg && occImg && mrImg !== occImg) {
        const { compositeOrm } = await import("./gltf-orm-composite.js");
        const bmp = await compositeOrm(mrImg, occImg);
        ormTexture = uploadTex(engine, bmp, false, sampler);
    } else if (mrImg ?? occImg) {
        ormTexture = uploadTex(engine, (mrImg ?? occImg)!, false, sampler);
    } else {
        const clamp = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
        ormTexture = uploadTex(engine, null, false, sampler, new Uint8Array([255, clamp(mat.roughnessFactor), clamp(mat.metallicFactor), 255]));
    }

    return {
        baseColorTexture,
        normalTexture,
        ormTexture,
        emissiveTexture,
        specGlossTexture,
        doubleSided: mat.doubleSided,
        occlusionStrength: mat.occlusionImage ? 1.0 : 0,
        enableSpecularAA: true,
        ...(mat.alphaMode === "BLEND" ? { alphaBlend: true, alpha: mat.baseColorFactor[3] } : undefined),
        _buildGroup: pbrGroupBuilder,
    } satisfies PbrMaterialPropsInternal;
}

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
    engine: EngineContextInternal
): Promise<MaterialVariantData> {
    // Ensure mipmap module is loaded
    if (!_generateMipmaps) {
        _generateMipmaps = (await import("../texture/generate-mipmaps.js")).generateMipmaps;
    }

    const sampler = getOrCreateSampler(engine, {
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
        addressModeU: "repeat",
        addressModeV: "repeat",
        maxAnisotropy: 4,
    });

    // Cache for assembled glTF materials (by material index)
    const matCache = new Map<number, Promise<GltfMaterialData>>();
    const imageCache = new Map<number, Promise<ImageBitmap>>();
    const getMat = (matIdx: number): Promise<GltfMaterialData> => {
        let p = matCache.get(matIdx);
        if (!p) {
            p = assembleMaterial(json, binChunk, matIdx, baseUrl, imageCache);
            matCache.set(matIdx, p);
        }
        return p;
    };

    // Cache for uploaded PBR materials (by GltfMaterialData identity)
    const pbrCache = new Map<GltfMaterialData, Promise<PbrMaterialPropsInternal>>();
    const getPbr = (gltfMat: GltfMaterialData): Promise<PbrMaterialPropsInternal> => {
        let p = pbrCache.get(gltfMat);
        if (!p) {
            p = buildPbr(engine, gltfMat, sampler);
            pbrCache.set(gltfMat, p);
        }
        return p;
    };

    const originals: VariantMeshEntry[] = [];
    const variants: Record<string, VariantMeshEntry[]> = {};
    for (const name of variantNames) {
        variants[name] = [];
    }

    // Walk meshDatas to find which primitives have variant extensions
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
