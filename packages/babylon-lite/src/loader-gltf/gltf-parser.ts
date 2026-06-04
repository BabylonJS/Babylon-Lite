/**
 * Low-level glTF/GLB parsing helpers:
 * - Accessor resolution (buffer views → typed arrays)
 * - Image extraction (embedded or external)
 * - Node hierarchy traversal with memoized world-matrix computation
 */
import type { Mat4 } from "../math/types.js";
import { mat4ComposeInto } from "../math/mat4-compose-into.js";
import { mat4MultiplyInto } from "../math/mat4-multiply-into.js";
import type { Mat4Storage } from "../math/types.js";
import { getLoaderTmpLocal } from "./_loader-scratch.js";

// glTF 2.0 component types
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const UNSIGNED_BYTE = 5121;

// glTF accessor type → component count
export const TYPE_SIZES: Record<string, number> = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16,
};

// --- Accessor Resolution ---

export interface AccessorView {
    /** @internal */
    _data: ArrayBufferView;
    /** @internal */
    _count: number;
    /** @internal */
    _componentCount: number;
}

export function resolveAccessor(json: any, binChunk: DataView, accessorIdx: number): AccessorView {
    const accessor = json.accessors[accessorIdx];
    const bufferView = json.bufferViews[accessor.bufferView];
    const componentCount = TYPE_SIZES[accessor.type] ?? 1;
    const byteOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const count = accessor.count;

    const baseOffset = binChunk.byteOffset + byteOffset;
    const ab = binChunk.buffer;

    switch (accessor.componentType) {
        case FLOAT:
            return { _data: new Float32Array(ab, baseOffset, count * componentCount), _count: count, _componentCount: componentCount };
        case UNSIGNED_SHORT:
            return { _data: new Uint16Array(ab, baseOffset, count * componentCount), _count: count, _componentCount: componentCount };
        case UNSIGNED_INT:
            return { _data: new Uint32Array(ab, baseOffset, count * componentCount), _count: count, _componentCount: componentCount };
        case UNSIGNED_BYTE:
            return { _data: new Uint8Array(ab, baseOffset, count * componentCount), _count: count, _componentCount: componentCount };
        default:
            throw new Error(`Unsupported component type: ${accessor.componentType}`);
    }
}

// --- Image Extraction ---

/** Resolve the image index for a glTF texture, honoring alternate-source
 *  extensions such as EXT_texture_webp (WebP decode is native in
 *  createImageBitmap, so no extra module is required — we only need to
 *  pick the correct image source). */
export function getTextureImageIndex(tex: any): number {
    return tex.extensions?.EXT_texture_webp?.source ?? tex.source;
}

// --- Optional-feature detection (shared by the core loader gate and the
//     dynamically-imported feature registry) ---

/** Returns true if any mesh primitive in the asset matches `pred`. */
export function anyPrimitive(json: any, pred: (p: any) => boolean): boolean {
    for (const m of json.meshes ?? []) {
        for (const p of m.primitives ?? []) {
            if (pred(p)) {
                return true;
            }
        }
    }
    return false;
}

/** Asset has at least one material that needs ORM compositing
 *  (separate metallicRoughnessTexture + occlusionTexture pointing at different images). */
export function needsOrmComposite(json: any): boolean {
    const mats = json.materials ?? [];
    const textures = json.textures ?? [];
    for (const m of mats) {
        const mr = m.pbrMetallicRoughness?.metallicRoughnessTexture;
        const occ = m.occlusionTexture;
        if (mr && occ && textures[mr.index] && textures[occ.index] && getTextureImageIndex(textures[mr.index]) !== getTextureImageIndex(textures[occ.index])) {
            return true;
        }
    }
    return false;
}

export async function resolveImage(json: any, binChunk: DataView, imageIdx: number, baseUrl: string): Promise<ImageBitmap> {
    const image = json.images[imageIdx];

    if (image.bufferView !== undefined) {
        // Embedded in binary chunk (GLB)
        const bv = json.bufferViews[image.bufferView];
        const offset = binChunk.byteOffset + (bv.byteOffset ?? 0);
        const slice = binChunk.buffer.slice(offset, offset + bv.byteLength);
        const blob = new Blob([slice as ArrayBuffer], { type: image.mimeType ?? "image/png" });
        return createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    }

    if (image.uri) {
        // External URI (relative to .gltf base URL)
        const imageUrl = new URL(image.uri, baseUrl + "x").href;
        const response = await fetch(imageUrl);
        if (!response.ok) {
            throw new Error(`Failed to load image: ${response.status} ${response.statusText}`);
        }
        const blob = await response.blob();
        const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
        return bmp;
    }

    throw new Error("Image has neither bufferView nor uri");
}

// --- Node Hierarchy → World Matrix (Memoized) ---

// Babylon.js RH→LH root: rotation [0,1,0,0] + scale [1,1,-1] = diag(-1,1,1,1)
// prettier-ignore
const RH_TO_LH_ROOT = new Float32Array([-1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1]) as unknown as Mat4;

/** Build a parent index map by scanning node.children arrays once. O(n). */
export function buildParentMap(json: any): Map<number, number> {
    const parentMap = new Map<number, number>();
    const nodes = json.nodes ?? [];
    for (let i = 0; i < nodes.length; i++) {
        const children = nodes[i].children;
        if (children) {
            for (const childIdx of children) {
                parentMap.set(childIdx as number, i);
            }
        }
    }
    return parentMap;
}

/** Look up a node's parent using the pre-built parent map. O(1). */
export function findParent(parentMap: Map<number, number>, childIdx: number): number {
    return parentMap.get(childIdx) ?? -1;
}

/**
 * Compute world matrix for a glTF node with memoization.
 * Uses parentMap for O(1) parent lookup and cache for O(1) repeat queries.
 * Total cost across all nodes: O(n) instead of O(n²).
 *
 * Zero-alloc path for the TRS case (common): `local` is composed into a shared
 * scratch via `mat4ComposeInto`, then multiplied into the freshly-allocated
 * `world` via `mat4MultiplyInto`. Only one Float32Array allocation per node
 * (the cached world matrix itself) instead of two. Recursion always resolves
 * `parentWorld` before touching the scratch, so the shared buffer is safe.
 */
export function computeNodeWorldMatrix(json: any, nodeIdx: number, parentMap: Map<number, number>, cache: Map<number, Mat4>): Mat4 {
    const cached = cache.get(nodeIdx);
    if (cached) {
        return cached;
    }

    const node = json.nodes[nodeIdx];
    const parentIdx = findParent(parentMap, nodeIdx);
    // Resolve parent FIRST so any recursive call can safely reuse the shared scratch below.
    const parentWorld: Mat4 = parentIdx !== -1 ? computeNodeWorldMatrix(json, parentIdx, parentMap, cache) : RH_TO_LH_ROOT;

    let localBuf: import("../math/types.js").Mat4Storage;
    if (node.matrix) {
        // Pre-built matrix — copy into a fresh Float32Array (cannot alias scratch safely across calls).
        localBuf = new Float32Array(node.matrix);
    } else {
        const t = node.translation ?? [0, 0, 0];
        const r = node.rotation ?? [0, 0, 0, 1];
        const s = node.scale ?? [1, 1, 1];
        const local = getLoaderTmpLocal() as unknown as Mat4Storage;
        mat4ComposeInto(local, 0, t[0], t[1], t[2], r[0], r[1], r[2], r[3], s[0], s[1], s[2]);
        localBuf = local;
    }

    // Per-node world is allocated fresh because recursion mutates the parser's
    // scratch; it cannot alias the per-call `tmpLocal`. The result is then
    // stashed in the per-load `cache` (Map<nodeIdx, Mat4>) and never shared
    // across loadGltf calls. Allocates F32 directly here — these loader-local
    // world matrices are throwaway intermediaries used only during parsing;
    // mesh runtime world-matrix caches are separately allocated via
    // `allocateMat4()` in `initMeshTransform` and pick up whatever precision
    // the process-global allocator was set to.
    const world = new Float32Array(16) as unknown as Mat4;
    mat4MultiplyInto(world as unknown as Mat4Storage, 0, parentWorld as unknown as Mat4Storage, 0, localBuf, 0);

    cache.set(nodeIdx, world);
    return world;
}
