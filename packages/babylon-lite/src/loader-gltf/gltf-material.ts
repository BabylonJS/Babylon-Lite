/**
 * glTF core PBR material assembly:
 * - Extracts core PBR properties (baseColor, MR, normal, ORM, emissive)
 * - Handles alpha modes and double-sided flag
 *
 * All KHR material extensions (clearcoat, sheen, anisotropy, spec-gloss, ...)
 * are handled by separate `gltf-ext-*.ts` modules driven by the GltfFeature
 * registry in load-gltf.ts. This core file knows ZERO extension names.
 */
import type { Texture2D } from "../texture/texture-2d.js";
import { getTextureImageIndex, resolveImage } from "./gltf-parser.js";

/** Per-load context handed to each material extension's `applyMaterial()`. */
export interface GltfMatExtCtx {
    /** Fetch + upload a texture from a glTF textureInfo object.
     *  Returns undefined if texInfo is null/undefined. */
    texture(texInfo: unknown, sRGB: boolean): Promise<Texture2D | undefined>;
    /** Upload an arbitrary ImageBitmap (e.g. composited bitmap from an ext). */
    uploadImage(bitmap: ImageBitmap, sRGB: boolean): Texture2D;
}

/** Parsed core PBR material data. */
export interface GltfMaterialData {
    baseColorFactor: [number, number, number, number];
    metallicFactor: number;
    roughnessFactor: number;
    emissiveFactor: [number, number, number];
    baseColorImage: ImageBitmap | null;
    metallicRoughnessImage: ImageBitmap | null;
    normalImage: ImageBitmap | null;
    /** glTF normalTexture.scale (default 1.0). */
    normalScale: number;
    /** glTF occlusionTexture.texCoord (default 0). */
    occlusionTexCoord: number;
    occlusionImage: ImageBitmap | null;
    emissiveImage: ImageBitmap | null;
    /** Whether material is double-sided. */
    doubleSided: boolean;
    /** glTF alphaMode: "OPAQUE" (default), "BLEND", or "MASK". */
    alphaMode: string;
    /** glTF alphaCutoff for MASK mode (default 0.5). */
    alphaCutoff: number;
    /** Raw glTF material definition. Always set so ext modules can read raw
     *  extension data + KHR_texture_transform from texture infos. */
    _rawMatDef?: any;
}

/** Assemble core PBR material data from a glTF material definition.
 *
 *  Per-material extension parsing/fetching is handled by load-gltf.ts using
 *  the GltfMatExt registry — this function only fills in the spec-baseline
 *  PBR properties shared by every material. */
export async function assembleMaterial(
    json: any,
    binChunk: DataView,
    materialIdx: number,
    baseUrl: string,
    imageCache?: Map<number, Promise<ImageBitmap>>
): Promise<GltfMaterialData> {
    const mat = json.materials?.[materialIdx];
    if (!mat) {
        return {
            baseColorFactor: [1, 1, 1, 1],
            metallicFactor: 1,
            roughnessFactor: 1,
            emissiveFactor: [0, 0, 0],
            baseColorImage: null,
            metallicRoughnessImage: null,
            normalImage: null,
            normalScale: 1,
            occlusionTexCoord: 0,
            occlusionImage: null,
            emissiveImage: null,
            doubleSided: false,
            alphaMode: "OPAQUE",
            alphaCutoff: 0.5,
        };
    }

    const pbr = mat.pbrMetallicRoughness ?? {};
    const fetchImg = makeImageFetcher(json, binChunk, baseUrl, imageCache);

    const [baseColorImg, mrImg, normalImg, occlusionImg, emissiveImg] = await Promise.all([
        fetchImg(pbr.baseColorTexture),
        fetchImg(pbr.metallicRoughnessTexture),
        fetchImg(mat.normalTexture),
        fetchImg(mat.occlusionTexture),
        fetchImg(mat.emissiveTexture),
    ]);

    return {
        baseColorFactor: pbr.baseColorFactor ?? [1, 1, 1, 1],
        metallicFactor: pbr.metallicFactor ?? 1,
        roughnessFactor: pbr.roughnessFactor ?? 1,
        emissiveFactor: mat.emissiveFactor ?? [0, 0, 0],
        baseColorImage: baseColorImg,
        metallicRoughnessImage: mrImg,
        normalImage: normalImg,
        normalScale: typeof mat.normalTexture?.scale === "number" ? mat.normalTexture.scale : 1,
        occlusionTexCoord: typeof mat.occlusionTexture?.texCoord === "number" ? mat.occlusionTexture.texCoord : 0,
        occlusionImage: occlusionImg,
        emissiveImage: emissiveImg,
        doubleSided: !!mat.doubleSided,
        alphaMode: mat.alphaMode ?? "OPAQUE",
        alphaCutoff: mat.alphaCutoff ?? 0.5,
        _rawMatDef: mat,
    };
}

/** Build a per-load image fetcher that decodes glTF texture references via
 *  the shared image cache. Used by both core assembleMaterial and the ext
 *  driver in load-gltf.ts. */
export function makeImageFetcher(json: any, binChunk: DataView, baseUrl: string, imageCache?: Map<number, Promise<ImageBitmap>>): (texInfo: any) => Promise<ImageBitmap | null> {
    return (texInfo: any): Promise<ImageBitmap | null> => {
        if (!texInfo) {
            return Promise.resolve(null);
        }
        const tex = json.textures[texInfo.index];
        const imgIdx: number = getTextureImageIndex(tex);
        if (imageCache) {
            let cached = imageCache.get(imgIdx);
            if (!cached) {
                cached = resolveImage(json, binChunk, imgIdx, baseUrl);
                imageCache.set(imgIdx, cached);
            }
            return cached;
        }
        return resolveImage(json, binChunk, imgIdx, baseUrl);
    };
}
