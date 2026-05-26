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
import type { EngineContextInternal } from "../engine/engine.js";
import { getTextureImageIndex, resolveImage } from "./gltf-parser.js";

/** Per-load context handed to each material extension's `applyMaterial()`. */
export interface GltfMatExtCtx {
    /** Internal engine access for dynamic-only texture extensions that must upload directly. */
    _engine: EngineContextInternal;
    /** Fetch + upload a texture from a glTF textureInfo object.
     *  Returns undefined if texInfo is null/undefined. */
    _texture(texInfo: unknown, sRGB: boolean): Promise<Texture2D | undefined>;
    /** Upload an arbitrary ImageBitmap (e.g. composited bitmap from an ext). */
    _uploadImage(bitmap: ImageBitmap, sRGB: boolean): Texture2D;
}

/** Parsed core PBR material data. */
export interface GltfMaterialData {
    _baseColorFactor: [number, number, number, number];
    _metallicFactor: number;
    _roughnessFactor: number;
    _emissiveFactor: [number, number, number];
    _baseColorImage: ImageBitmap | null;
    _metallicRoughnessImage: ImageBitmap | null;
    _normalImage: ImageBitmap | null;
    /** glTF normalTexture.scale (default 1.0). */
    _normalScale: number;
    /** glTF occlusionTexture.texCoord (default 0). */
    _occlusionTexCoord: number;
    _occlusionImage: ImageBitmap | null;
    _emissiveImage: ImageBitmap | null;
    /** Whether material is double-sided. */
    _doubleSided: boolean;
    /** glTF alphaMode: "OPAQUE" (default), "BLEND", or "MASK". */
    _alphaMode: string;
    /** glTF alphaCutoff for MASK mode (default 0.5). */
    _alphaCutoff: number;
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
            _baseColorFactor: [1, 1, 1, 1],
            _metallicFactor: 1,
            _roughnessFactor: 1,
            _emissiveFactor: [0, 0, 0],
            _baseColorImage: null,
            _metallicRoughnessImage: null,
            _normalImage: null,
            _normalScale: 1,
            _occlusionTexCoord: 0,
            _occlusionImage: null,
            _emissiveImage: null,
            _doubleSided: false,
            _alphaMode: "OPAQUE",
            _alphaCutoff: 0.5,
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
        _baseColorFactor: pbr.baseColorFactor ?? [1, 1, 1, 1],
        _metallicFactor: pbr.metallicFactor ?? 1,
        _roughnessFactor: pbr.roughnessFactor ?? 1,
        _emissiveFactor: mat.emissiveFactor ?? [0, 0, 0],
        _baseColorImage: baseColorImg,
        _metallicRoughnessImage: mrImg,
        _normalImage: normalImg,
        _normalScale: typeof mat.normalTexture?.scale === "number" ? mat.normalTexture.scale : 1,
        _occlusionTexCoord: typeof mat.occlusionTexture?.texCoord === "number" ? mat.occlusionTexture.texCoord : 0,
        _occlusionImage: occlusionImg,
        _emissiveImage: emissiveImg,
        _doubleSided: !!mat.doubleSided,
        _alphaMode: mat.alphaMode ?? "OPAQUE",
        _alphaCutoff: mat.alphaCutoff ?? 0.5,
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
        const imgIdx: number = getTextureImageIndex(json.textures[texInfo.index]);
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
