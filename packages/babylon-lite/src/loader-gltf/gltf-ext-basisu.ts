/** KHR_texture_basisu glTF texture-source extension.
 *
 *  The extension redirects textureInfos whose glTF texture declares
 *  `extensions.KHR_texture_basisu.source` to the referenced KTX2 image and
 *  uploads it through the lazily fetched KTX2 decoder. Core glTF
 *  material parsing remains extension-agnostic: this module only loads when the
 *  asset lists KHR_texture_basisu in `extensionsUsed`.
 */

import type { GltfMatExtCtx } from "./gltf-material.js";
import type { GltfFeature } from "./gltf-feature.js";
import type { DecodedPrimitive } from "./gltf-feature.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import type { Texture2D } from "../texture/texture-2d.js";
import { resolveAccessor } from "./gltf-parser.js";
import { decodeKtx2ImageBitmapFromBuffer, uploadKtx2Texture2D } from "../texture/ktx2-loader.js";

const NAME = "KHR_texture_basisu";
const FLOAT = 5126;
const TYPE_SIZES: Record<string, number> = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16,
};
const BASISU_MATERIAL_DATA = "__basisuMaterialData";

interface BasisuMaterialData {
    json: any;
    binChunk: DataView;
    baseUrl: string;
    baseColorTexture?: any;
    metallicRoughnessTexture?: any;
    normalTexture?: any;
    occlusionTexture?: any;
    emissiveTexture?: any;
    bitmaps?: Map<number, Promise<ImageBitmap>>;
    textures?: Map<string, Texture2D>;
}

function basisSourceIndex(tex: unknown): number | null {
    const source = (tex as { extensions?: { KHR_texture_basisu?: { source?: unknown } } } | undefined)?.extensions?.KHR_texture_basisu?.source;
    return typeof source === "number" ? source : null;
}

function textureIndex(texInfo: unknown): number | null {
    const index = (texInfo as { index?: unknown } | undefined)?.index;
    return typeof index === "number" ? index : null;
}

function textureUsesBasisu(json: any, texInfo: unknown): boolean {
    const index = textureIndex(texInfo);
    return index !== null && basisSourceIndex(json.textures?.[index]) !== null;
}

function stripBasisuTexture(json: any, owner: any, slot: keyof BasisuMaterialData, data: BasisuMaterialData): boolean {
    if (!textureUsesBasisu(json, owner?.[slot])) {
        return false;
    }
    data[slot] = owner[slot];
    delete owner[slot];
    return true;
}

function prepareBasisuMaterials(json: any, binChunk: DataView, baseUrl: string): void {
    for (const mat of json.materials ?? []) {
        const data: BasisuMaterialData = { json, binChunk, baseUrl };
        const pbr = mat.pbrMetallicRoughness ?? {};
        let hasBasisu = stripBasisuTexture(json, pbr, "baseColorTexture", data);
        hasBasisu = stripBasisuTexture(json, pbr, "metallicRoughnessTexture", data) || hasBasisu;
        hasBasisu = stripBasisuTexture(json, mat, "normalTexture", data) || hasBasisu;
        hasBasisu = stripBasisuTexture(json, mat, "occlusionTexture", data) || hasBasisu;
        hasBasisu = stripBasisuTexture(json, mat, "emissiveTexture", data) || hasBasisu;
        if (hasBasisu) {
            Object.defineProperty(mat, BASISU_MATERIAL_DATA, { value: data });
        }
    }
}

async function resolveImageBuffer(ctx: BasisuMaterialData, imageIdx: number): Promise<ArrayBuffer> {
    const image = ctx.json.images?.[imageIdx];
    if (!image) {
        throw new Error(`${NAME}: image ${imageIdx} not found`);
    }
    if (image.bufferView !== undefined) {
        const bv = ctx.json.bufferViews?.[image.bufferView];
        if (!bv) {
            throw new Error(`${NAME}: bufferView ${image.bufferView} not found`);
        }
        const offset = ctx.binChunk.byteOffset + (bv.byteOffset ?? 0);
        const copy = new Uint8Array(bv.byteLength);
        copy.set(new Uint8Array(ctx.binChunk.buffer, offset, bv.byteLength));
        return copy.buffer;
    }
    if (image.uri) {
        const url = new URL(image.uri, ctx.baseUrl + "x").href;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`${NAME}: failed to load image ${response.status} ${response.statusText}`);
        }
        return response.arrayBuffer();
    }
    throw new Error(`${NAME}: image has neither bufferView nor uri`);
}

async function loadBasisuBitmap(data: BasisuMaterialData, texInfo: unknown): Promise<ImageBitmap | null> {
    const index = textureIndex(texInfo);
    if (index === null) {
        return null;
    }
    const source = basisSourceIndex(data.json.textures?.[index]);
    if (source === null) {
        return null;
    }
    data.bitmaps ??= new Map();
    let bitmap = data.bitmaps.get(index);
    if (!bitmap) {
        bitmap = resolveImageBuffer(data, source).then(decodeKtx2ImageBitmapFromBuffer);
        data.bitmaps.set(index, bitmap);
    }
    return bitmap;
}

async function uploadBasisuTexture(data: BasisuMaterialData, ctx: GltfMatExtCtx, texInfo: unknown, sRGB: boolean): Promise<Texture2D | undefined> {
    const index = textureIndex(texInfo);
    if (index === null) {
        return undefined;
    }
    data.textures ??= new Map();
    const key = `${index}:${sRGB ? 1 : 0}`;
    let tex = data.textures.get(key);
    if (!tex) {
        const source = basisSourceIndex(data.json.textures?.[index]);
        if (source === null) {
            return undefined;
        }
        tex = await uploadKtx2Texture2D(ctx._engine, await resolveImageBuffer(data, source), sRGB);
        data.textures.set(key, tex);
    }
    return tex;
}

async function compositeOrm(mr: ImageBitmap, occ: ImageBitmap): Promise<ImageBitmap> {
    const w = mr.width;
    const h = mr.height;
    const c1 = new OffscreenCanvas(w, h);
    const x1 = c1.getContext("2d")!;
    x1.drawImage(mr, 0, 0, w, h);
    const d1 = x1.getImageData(0, 0, w, h);
    const c2 = new OffscreenCanvas(w, h);
    const x2 = c2.getContext("2d")!;
    x2.drawImage(occ, 0, 0, w, h);
    const d2 = x2.getImageData(0, 0, w, h);
    for (let j = 0; j < d1.data.length; j += 4) {
        d1.data[j] = d2.data[j]!;
    }
    x1.putImageData(d1, 0, 0);
    return createImageBitmap(c1);
}

async function uploadOrmTexture(data: BasisuMaterialData, ctx: GltfMatExtCtx): Promise<Texture2D | undefined> {
    const mrInfo = data.metallicRoughnessTexture;
    const occInfo = data.occlusionTexture;
    const mrIndex = textureIndex(mrInfo);
    const occIndex = textureIndex(occInfo);
    if (mrIndex === null && occIndex === null) {
        return undefined;
    }
    if (mrIndex === null || occIndex === null || mrIndex === occIndex) {
        return uploadBasisuTexture(data, ctx, mrInfo ?? occInfo, false);
    }
    data.textures ??= new Map();
    const key = `orm:${mrIndex}:${occIndex}`;
    let tex = data.textures.get(key);
    if (!tex) {
        const [mr, occ] = await Promise.all([loadBasisuBitmap(data, mrInfo), loadBasisuBitmap(data, occInfo)]);
        if (!mr || !occ) {
            return undefined;
        }
        tex = ctx._uploadImage(await compositeOrm(mr, occ), false);
        data.textures.set(key, tex);
    }
    return tex;
}

function readStridedFloat(json: any, binChunk: DataView, accessorIdx: number): Float32Array {
    const accessor = json.accessors[accessorIdx];
    const bufferView = json.bufferViews[accessor.bufferView];
    if (accessor.componentType !== FLOAT) {
        throw new Error(`${NAME}: strided accessor ${accessorIdx} uses unsupported component type: ${accessor.componentType}`);
    }
    const componentCount = TYPE_SIZES[accessor.type] ?? 1;
    const elementBytes = componentCount * 4;
    const byteStride = bufferView.byteStride ?? elementBytes;
    if (byteStride < elementBytes) {
        throw new Error(`${NAME}: invalid accessor stride ${byteStride} for accessor ${accessorIdx}`);
    }
    const baseOffset = binChunk.byteOffset + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const view = new DataView(binChunk.buffer);
    const out = new Float32Array(accessor.count * componentCount);
    for (let i = 0, o = 0; i < accessor.count; i++) {
        const src = baseOffset + i * byteStride;
        for (let c = 0; c < componentCount; c++, o++) {
            out[o] = view.getFloat32(src + c * 4, true);
        }
    }
    return out;
}

const ext: GltfFeature = {
    id: NAME,
    async preMesh(json, binChunk, baseUrl) {
        const gltf = json as any;
        prepareBasisuMaterials(gltf, binChunk, baseUrl);
        const decoded = new Map<unknown, DecodedPrimitive>();
        for (const mesh of gltf.meshes ?? []) {
            for (const primitive of mesh.primitives ?? []) {
                const attrs = primitive.attributes ?? {};
                const strided = Object.keys(attrs).some((name) => gltf.bufferViews?.[gltf.accessors?.[attrs[name]]?.bufferView]?.byteStride !== undefined);
                if (!strided) {
                    continue;
                }
                const attributes = new Map<string, Float32Array>();
                for (const name of Object.keys(attrs)) {
                    const accessorIdx = attrs[name];
                    const accessor = gltf.accessors[accessorIdx];
                    if (gltf.bufferViews?.[accessor.bufferView]?.byteStride !== undefined) {
                        attributes.set(name, readStridedFloat(gltf, binChunk, accessorIdx));
                    }
                }
                const posAcc = gltf.accessors[attrs.POSITION];
                const idx =
                    primitive.indices === undefined
                        ? new Uint32Array(0)
                        : new Uint32Array(resolveAccessor(gltf, binChunk, primitive.indices)._data as Uint16Array | Uint32Array | Uint8Array);
                decoded.set(primitive, {
                    _attributes: attributes,
                    _indices: idx,
                    _vertexCount: posAcc.count,
                    _indexCount: idx.length,
                });
            }
        }
        return decoded;
    },
    async applyMaterial(mat, ctx) {
        const data = mat._rawMatDef?.[BASISU_MATERIAL_DATA] as BasisuMaterialData | undefined;
        if (!data) {
            return null;
        }
        const [baseColorTexture, ormTexture, normalTexture, emissiveTexture] = await Promise.all([
            uploadBasisuTexture(data, ctx, data.baseColorTexture, true),
            uploadOrmTexture(data, ctx),
            uploadBasisuTexture(data, ctx, data.normalTexture, false),
            uploadBasisuTexture(data, ctx, data.emissiveTexture, true),
        ]);
        const out: Partial<PbrMaterialProps> = {
            ...(baseColorTexture ? { baseColorTexture } : undefined),
            ...(ormTexture
                ? {
                      ormTexture,
                      ...(data.metallicRoughnessTexture ? { metallicFactor: mat._metallicFactor, roughnessFactor: mat._roughnessFactor } : undefined),
                      ...(data.occlusionTexture ? { occlusionStrength: 1.0, occlusionTexCoord: data.occlusionTexture.texCoord ?? 0 } : undefined),
                  }
                : undefined),
            ...(normalTexture ? { normalTexture, normalTextureScale: data.normalTexture?.scale ?? 1 } : undefined),
            ...(emissiveTexture ? { emissiveTexture } : undefined),
        };
        if (!out.baseColorTexture && !out.ormTexture && !out.normalTexture && !out.emissiveTexture) {
            return null;
        }
        return out;
    },
};

export default ext;
