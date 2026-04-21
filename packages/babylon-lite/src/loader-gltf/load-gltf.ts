import type { Mat4 } from "../math/types.js";
import { computeAabb } from "../math/aabb.js";
import type { EngineContext } from "../engine/engine.js";
import type { EngineContextInternal } from "../engine/engine.js";
import type { TransformNode } from "../scene/transform-node.js";
import type { AssetContainer } from "../asset-container.js";
import { createTransformNode } from "../scene/transform-node.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { PbrMaterialPropsInternal } from "../material/pbr/pbr-material.js";
import type { Mesh, MeshGPU, MeshInternal } from "../mesh/mesh.js";
import { initMeshTransform } from "../mesh/mesh.js";
import { getOrCreateSampler } from "../resource/gpu-pool.js";
import { createMappedBuffer } from "../resource/gpu-buffers.js";
import { parseGlbContainer, resolveAccessor, buildParentMap, computeNodeWorldMatrix } from "./gltf-parser.js";
import type { GltfMaterialData, GltfMatExtCtx } from "./gltf-material.js";
import { assembleMaterial, makeImageFetcher } from "./gltf-material.js";
import type { DecodedPrimitive, GltfFeature, GltfLoadCtx } from "./gltf-feature.js";
import { assemblePbrProps, buildDefaultPbrTextures, runMatExts, uploadTex } from "./gltf-pbr-builder.js";

/** Parsed mesh data ready for GPU upload. */
export interface GltfMeshData {
    positions: Float32Array;
    normals: Float32Array;
    tangents: Float32Array | null;
    uvs: Float32Array;
    indices: Uint16Array | Uint32Array;
    vertexCount: number;
    indexCount: number;
    worldMatrix: Mat4;
    material: GltfMaterialData;
    /** glTF node index this mesh came from (for hierarchy reconstruction
     *  and for features that need to resolve skin/morph data lazily). */
    nodeIndex: number;
    /** Raw primitive definition — features (skeleton, morph, …) read their
     *  own attributes/targets from here without bloating core extraction. */
    _primitive: any;
    /** Pre-decoded primitive (Draco et al.) if a preMesh feature produced one. */
    _decoded?: DecodedPrimitive;
}

/** Options for loadGltf. */
/**
 * Load a .glb or .gltf file, parse it, and upload mesh + material data to GPU.
 * Supports both binary GLB and separate .gltf + .bin + image files.
 * Registers a deferred PBR renderable builder.
 * Automatically parses glTF animations if present.
 *
 * Returns a AssetContainer. Pass it to addToScene() which adds the hierarchy,
 * registers animation ticks, and applies any scene-level settings.
 */
export async function loadGltf(engine: EngineContext, url: string): Promise<AssetContainer> {
    const { json, binChunk, baseUrl } = await fetchGltfAsset(url);

    // Build parent map + world-matrix cache once for O(n) hierarchy traversal
    const parentMap = buildParentMap(json);
    const worldMatrixCache = new Map<number, Mat4>();

    // Discover every triggered feature (material exts, skeleton, morph,
    // animations, variants, …) and dynamic-import them concurrently with
    // mesh extraction. Core loader knows zero feature names.
    const features = await loadGltfFeatures(json);
    const matExts: GltfFeature[] = features.filter((f) => f.applyMaterial);

    // Run every feature's pre-mesh hook (e.g. Draco decompression) and merge
    // their primitive-keyed decode caches. Features without `preMesh` contribute
    // nothing; the map stays empty when no primitive-level feature triggered.
    const decodedPrimitives = new Map<unknown, DecodedPrimitive>();
    for (const frag of await Promise.all(features.flatMap((f) => (f.preMesh ? [f.preMesh(json, binChunk)] : [])))) {
        for (const [k, v] of frag) {
            decodedPrimitives.set(k, v);
        }
    }

    const meshDatas = await extractAllMeshes(json, binChunk, baseUrl, parentMap, worldMatrixCache, decodedPrimitives);

    const ctx: GltfLoadCtx = {
        engine: engine as EngineContextInternal,
        json,
        binChunk,
        baseUrl,
        parentMap,
        worldMatrixCache,
        matExts,
    };

    const meshes = await uploadMeshes(meshDatas, features, ctx);

    // Build TransformNode hierarchy from glTF nodes. Returns both the synthetic root
    // and a glTF-node-index → SceneNode map (used by node-visibility + animation-pointer).
    const { root, nodeMap } = buildNodeHierarchy(json, meshes, meshDatas);
    ctx.nodeMap = nodeMap;

    // Run every feature's per-asset hook (animations, variants, …) and merge
    // the returned AssetContainer fragments. `entities` is appended (never
    // overwritten) so features like KHR_lights_punctual can contribute lights
    // without trampling the root TransformNode.
    const assetFragments = await Promise.all(features.flatMap((f) => (f.applyAsset ? [f.applyAsset(meshes, root, ctx)] : [])));
    const container: AssetContainer = { entities: [root] };
    for (const frag of assetFragments) {
        if (frag.entities?.length) {
            container.entities.push(...frag.entities);
        }
        const { entities: _ignored, ...rest } = frag;
        void _ignored;
        Object.assign(container, rest);
    }
    return container;
}

// --- glTF Feature Driver ---

/** A glTF feature: per-asset gating + dynamic-import of a `GltfFeature` module.
 *  Unknown features contribute zero bytes when their `needs(json)` returns false.
 *  Stored as a tuple [needs, load] for bundle-size reasons. */
type GltfFeatureLoader = [(json: any) => boolean, () => Promise<{ default: GltfFeature }>];

/** Fetch + parse a .glb or .gltf asset. Returns the JSON, binary chunk, and base URL. */
async function fetchGltfAsset(url: string): Promise<{ json: any; binChunk: DataView; baseUrl: string }> {
    const baseUrl = url.substring(0, url.lastIndexOf("/") + 1);
    if (url.toLowerCase().endsWith(".glb")) {
        const buffer = await fetch(url).then((r) => r.arrayBuffer());
        const { json, binChunk } = parseGlbContainer(buffer);
        return { json, binChunk, baseUrl };
    }
    const json = await fetch(url).then((r) => r.json());
    const bufferDef = json.buffers?.[0];
    let binChunk: DataView;
    if (bufferDef?.uri) {
        const binUrl = new URL(bufferDef.uri, baseUrl + "x").href;
        const binBuffer = await fetch(binUrl).then((r) => r.arrayBuffer());
        binChunk = new DataView(binBuffer);
    } else {
        binChunk = new DataView(new ArrayBuffer(0));
    }
    return { json, binChunk, baseUrl };
}

/** Returns true if any mesh primitive in the asset matches `pred`. */
function anyPrimitive(json: any, pred: (p: any) => boolean): boolean {
    for (const m of json.meshes ?? []) {
        for (const p of m.primitives ?? []) {
            if (pred(p)) {
                return true;
            }
        }
    }
    return false;
}

const _MAT_EXT = "KHR_materials_";
const hasMatExt =
    (suffix: string) =>
    (json: any): boolean =>
        json.extensionsUsed?.includes(_MAT_EXT + suffix);
const hasExt =
    (name: string) =>
    (json: any): boolean =>
        json.extensionsUsed?.includes(name);

/** Asset has at least one material that needs ORM compositing
 *  (separate metallicRoughnessTexture + occlusionTexture pointing at different images). */
function needsOrmComposite(json: any): boolean {
    const mats = json.materials ?? [];
    const textures = json.textures ?? [];
    for (const m of mats) {
        const mr = m.pbrMetallicRoughness?.metallicRoughnessTexture;
        const occ = m.occlusionTexture;
        if (mr && occ && textures[mr.index]?.source !== textures[occ.index]?.source) {
            return true;
        }
    }
    return false;
}

const _features: GltfFeatureLoader[] = [
    // Pre-mesh features (geometry decompression)
    [hasExt("KHR_draco_mesh_compression"), () => import("./gltf-feature-draco.js")],
    // Material extensions
    [hasMatExt("clearcoat"), () => import("./gltf-ext-clearcoat.js")],
    [hasMatExt("emissive_strength"), () => import("./gltf-ext-emissive-strength.js")],
    [hasMatExt("sheen"), () => import("./gltf-ext-sheen.js")],
    [hasMatExt("anisotropy"), () => import("./gltf-ext-anisotropy.js")],
    [hasMatExt("unlit"), () => import("./gltf-ext-unlit.js")],
    [hasMatExt("pbrSpecularGlossiness"), () => import("./gltf-ext-spec-gloss.js")],
    // Dielectric cluster (ior/specular/transmission/volume) — any of the four triggers the loader;
    // refraction render path is wired via fragments/refraction-fragment.ts (env-only V1).
    [(j) => ["transmission", "volume", "ior", "specular"].some((e) => hasMatExt(e)(j)), () => import("./gltf-ext-dielectric.js")],
    [hasExt("KHR_texture_transform"), () => import("./gltf-ext-uv-transform.js")],
    [needsOrmComposite, () => import("./gltf-ext-orm.js")],
    // Per-mesh features (predicates inlined to avoid eager imports)
    [(json) => !!json.skins?.length && anyPrimitive(json, (p) => p.attributes?.JOINTS_0 !== undefined), () => import("./gltf-feature-skeleton.js")],
    [(json) => anyPrimitive(json, (p) => !!p.targets?.length), () => import("./gltf-feature-morph.js")],
    // Per-asset features
    [hasExt("KHR_lights_punctual"), () => import("./gltf-feature-lights-punctual.js")],
    [(json) => !!json.animations?.length, () => import("./gltf-feature-animations.js")],
    [hasMatExt("variants"), () => import("./gltf-feature-variants.js")],
    [hasExt("KHR_node_visibility"), () => import("./gltf-ext-node-visibility.js")],
    [hasExt("KHR_animation_pointer"), () => import("./gltf-feature-animation-pointer.js")],
    [hasExt("EXT_mesh_gpu_instancing"), () => import("./gltf-feature-gpu-instancing.js")],
];

/** Dynamic-import every feature the asset triggers. */
async function loadGltfFeatures(json: any): Promise<GltfFeature[]> {
    const mods = await Promise.all(_features.flatMap(([needs, load]) => (needs(json) ? [load()] : [])));
    return mods.map((m) => m.default);
}

// --- Hierarchy Reconstruction ---

/** Build a TransformNode tree mirroring the glTF node hierarchy.
 *  Meshes are attached as children. Non-mesh nodes become
 *  pure TransformNodes preserving TRS for cloning/repositioning.
 *  Parent links are set by addToScene() when the tree is added to the scene.
 *  Also returns a glTF-node-index → SceneNode map used by per-asset features
 *  (KHR_node_visibility, KHR_animation_pointer) to address specific nodes. */
function buildNodeHierarchy(json: any, meshes: Mesh[], meshDatas: GltfMeshData[]): { root: TransformNode; nodeMap: (TransformNode | undefined)[] } {
    // Map nodeIndex → uploaded Mesh[]
    const nodeToMeshes = new Map<number, Mesh[]>();
    for (let i = 0; i < meshDatas.length; i++) {
        const ni = meshDatas[i]!.nodeIndex;
        let arr = nodeToMeshes.get(ni);
        if (!arr) {
            arr = [];
            nodeToMeshes.set(ni, arr);
        }
        arr.push(meshes[i]!);
    }

    const nodeMap: (TransformNode | undefined)[] = new Array(json.nodes?.length ?? 0);

    // Recursive builder
    function buildNode(nodeIdx: number): TransformNode {
        const node = json.nodes[nodeIdx];
        const t = node.translation ?? [0, 0, 0];
        const r = node.rotation ?? [0, 0, 0, 1];
        const s = node.scale ?? [1, 1, 1];
        const tn = createTransformNode(node.name ?? `node_${nodeIdx}`, t[0], t[1], t[2], r[0], r[1], r[2], r[3], s[0], s[1], s[2]);
        nodeMap[nodeIdx] = tn;
        if (node.children) {
            for (const childIdx of node.children) {
                tn.children.push(buildNode(childIdx));
            }
        }
        const nodeMeshes = nodeToMeshes.get(nodeIdx) ?? [];
        tn.children.push(...nodeMeshes);
        return tn;
    }

    // Synthetic root (like BJS __root__) — applies RH→LH conversion via scale
    // BJS: rotation [0,1,0,0] + scale [1,1,-1] = diag(-1, 1, 1, 1)
    const sceneRoots: number[] = json.scenes?.[json.scene ?? 0]?.nodes ?? [];
    const rootChildren = sceneRoots.map((ni: number) => buildNode(ni));
    const root = createTransformNode("__root__", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
    root.children.push(...rootChildren);
    return { root, nodeMap };
}

// --- Mesh Extraction ---

async function extractAllMeshes(
    json: any,
    binChunk: DataView,
    baseUrl: string,
    parentMap: Map<number, number>,
    worldMatrixCache: Map<number, Mat4>,
    decodedPrimitives: Map<unknown, DecodedPrimitive>
): Promise<GltfMeshData[]> {
    // Per-load image cache — avoids decoding the same glTF image index multiple times
    const imageCache = new Map<number, Promise<ImageBitmap>>();

    // Cache material assembly by glTF material index — avoids duplicate image fetches
    const matCache = new Map<number, Promise<GltfMaterialData>>();
    const getMat = (matIdx: number): Promise<GltfMaterialData> => {
        const key = matIdx ?? -1;
        let p = matCache.get(key);
        if (!p) {
            p = assembleMaterial(json, binChunk, matIdx, baseUrl, imageCache);
            matCache.set(key, p);
        }
        return p;
    };

    // First pass: do all sync work, fire all material fetches concurrently
    const partials: Array<Omit<GltfMeshData, "material">> = [];
    const matPromises: Promise<GltfMaterialData>[] = [];

    for (let nodeIdx = 0; nodeIdx < json.nodes.length; nodeIdx++) {
        const node = json.nodes[nodeIdx];
        if (node.mesh === undefined) {
            continue;
        }

        const mesh = json.meshes[node.mesh];
        const worldMatrix = computeNodeWorldMatrix(json, nodeIdx, parentMap, worldMatrixCache);

        for (const primitive of mesh.primitives) {
            const attrs = primitive.attributes;
            const decoded = decodedPrimitives.get(primitive);
            const resolveAttr = (name: string): { data: ArrayBufferView; count: number; componentCount: number } | null => {
                if (decoded && decoded.attributes.has(name)) {
                    const data = decoded.attributes.get(name)!;
                    const componentCount = data.length / decoded.vertexCount;
                    return { data, count: decoded.vertexCount, componentCount };
                }
                const idx = attrs[name];
                return idx !== undefined ? resolveAccessor(json, binChunk, idx) : null;
            };
            const posData = resolveAttr("POSITION")!;
            const normData = resolveAttr("NORMAL")!;
            const uvData = resolveAttr("TEXCOORD_0");
            const tanData = resolveAttr("TANGENT");
            const idxData = decoded
                ? { data: decoded.indices, count: decoded.indexCount, componentCount: 1 }
                : primitive.indices !== undefined
                  ? resolveAccessor(json, binChunk, primitive.indices)
                  : null;

            // Keep vertex data as-is from glTF — RH→LH conversion handled by root world matrix
            const indices = idxData
                ? idxData.data instanceof Uint32Array
                    ? new Uint32Array(idxData.data as Uint32Array)
                    : idxData.data instanceof Uint8Array
                      ? Uint16Array.from(idxData.data as Uint8Array)
                      : new Uint16Array(idxData.data.buffer, idxData.data.byteOffset, idxData.count)
                : new Uint16Array(0);

            // Fire material fetch without awaiting — all materials load in parallel
            matPromises.push(getMat(primitive.material));

            partials.push({
                positions: posData.data as Float32Array,
                normals: normData.data as Float32Array,
                tangents: tanData ? (tanData.data as Float32Array) : null,
                uvs: uvData ? (uvData.data as Float32Array) : new Float32Array(posData.count * 2),
                indices: idxData ? indices : new Uint16Array(0),
                vertexCount: posData.count,
                indexCount: idxData?.count ?? 0,
                worldMatrix,
                nodeIndex: nodeIdx,
                _primitive: primitive,
                _decoded: decoded,
            });
        }
    }

    // Resolve all material fetches in parallel
    const materials = await Promise.all(matPromises);
    return partials.map((p, i) => ({ ...p, material: materials[i]! }));
}

// --- GPU Upload ---

// Pre-resolved generateMipmaps function— loaded once before texture uploads
let _generateMipmaps: ((engine: EngineContextInternal, texture: GPUTexture, face?: number) => void) | null = null;

async function ensureMipmapModule(): Promise<void> {
    if (!_generateMipmaps) {
        _generateMipmaps = (await import("../texture/generate-mipmaps.js")).generateMipmaps;
    }
}

function uploadTextureSynced(engine: EngineContextInternal, bitmap: ImageBitmap | null, srgb: boolean, sampler: GPUSampler, fallbackBytes?: Uint8Array): Texture2D {
    return uploadTex(engine, bitmap, srgb, sampler, _generateMipmaps!, fallbackBytes);
}

async function uploadMeshes(meshDatas: GltfMeshData[], features: GltfFeature[], ctx: GltfLoadCtx): Promise<Mesh[]> {
    const { engine, json, binChunk, baseUrl, matExts } = ctx;
    const sampler = getOrCreateSampler(engine, {
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
        addressModeU: "repeat",
        addressModeV: "repeat",
        maxAnisotropy: 4,
    });

    await ensureMipmapModule();
    const meshFeatures = features.filter((f) => f.applyMesh);

    // Texture cache: shared textures uploaded once, keyed by (bitmap, srgb)
    const texCache = new Map<string, Texture2D>();
    let texId = 0;
    const bitmapIds = new Map<ImageBitmap, number>();

    function getCachedTexture(bitmap: ImageBitmap | null, srgb: boolean): Texture2D {
        if (!bitmap) {
            return uploadTextureSynced(engine, null, srgb, sampler);
        }
        let id = bitmapIds.get(bitmap);
        if (id === undefined) {
            id = texId++;
            bitmapIds.set(bitmap, id);
        }
        const key = `${id}:${srgb ? 1 : 0}`;
        let tex = texCache.get(key);
        if (!tex) {
            tex = uploadTextureSynced(engine, bitmap, srgb, sampler);
            texCache.set(key, tex);
        }
        return tex;
    }

    // Per-load image fetcher for ext modules (uses same image cache as core).
    const extImageCache = matExts.length > 0 ? new Map<number, Promise<ImageBitmap>>() : null;
    const extFetchImg = extImageCache ? makeImageFetcher(json, binChunk, baseUrl, extImageCache) : null;
    const extCtx: GltfMatExtCtx = {
        async texture(texInfo, sRGB) {
            if (!texInfo || !extFetchImg) {
                return undefined;
            }
            const img = await extFetchImg(texInfo);
            return img ? getCachedTexture(img, sRGB) : undefined;
        },
        uploadImage(bitmap, sRGB) {
            return uploadTextureSynced(engine, bitmap, sRGB, sampler);
        },
    };

    /** Default ORM upload: single MR-or-occlusion image, or 1×1 fallback baked from
     *  metallicFactor/roughnessFactor. The composite case (MR+occlusion separate) is
     *  handled by the gltf-ext-orm extension which overrides this via `extLayers`. */

    // Build a PbrMaterialPropsInternal from parsed glTF material data.
    // Uses shared texture caches so identical bitmaps are uploaded once.
    const builtMaterialCache = new Map<GltfMaterialData, Promise<PbrMaterialPropsInternal>>();
    async function buildPbrFromGltfMat(mat: GltfMaterialData): Promise<PbrMaterialPropsInternal> {
        let cached = builtMaterialCache.get(mat);
        if (cached) {
            return cached;
        }
        cached = (async () => {
            const tex = buildDefaultPbrTextures(engine, mat, sampler, _generateMipmaps!, getCachedTexture);
            const extLayers = await runMatExts(mat, matExts, extCtx);
            return assemblePbrProps(mat, tex.baseColorTexture, tex.ormTexture, tex.normalTexture, tex.emissiveTexture, extLayers);
        })();
        builtMaterialCache.set(mat, cached);
        return cached;
    }

    const meshes = await Promise.all(
        meshDatas.map(async (m, i): Promise<Mesh> => {
            const material = await buildPbrFromGltfMat(m.material);

            const [boundMin, boundMax] = computeAabb(m.positions, m.worldMatrix);

            const gpu: MeshGPU = {
                positionBuffer: createMappedBuffer(engine, m.positions, GPUBufferUsage.VERTEX),
                normalBuffer: createMappedBuffer(engine, m.normals, GPUBufferUsage.VERTEX),
                tangentBuffer: m.tangents ? createMappedBuffer(engine, m.tangents, GPUBufferUsage.VERTEX) : null,
                uvBuffer: createMappedBuffer(engine, m.uvs, GPUBufferUsage.VERTEX),
                indexBuffer: createMappedBuffer(engine, m.indices, GPUBufferUsage.INDEX),
                indexCount: m.indexCount,
                indexFormat: (m.indices instanceof Uint32Array ? "uint32" : "uint16") as GPUIndexFormat,
            };

            const mesh = {
                name: `gltf_mesh_${i}`,
                material,
                receiveShadows: false,
                boundMin,
                boundMax,
                skeleton: null,
                morphTargets: null,
                _materialDirty: false,
                _gpu: gpu,
            } as unknown as MeshInternal;
            initMeshTransform(mesh);

            // Retain CPU geometry for detailed picking
            mesh._cpuPositions = m.positions;
            mesh._cpuNormals = m.normals;
            mesh._cpuUvs = m.uvs;
            mesh._cpuIndices = m.indices instanceof Uint32Array ? m.indices : new Uint32Array(m.indices);

            // Run all per-mesh feature hooks (skeleton, morph, …) in parallel.
            // Each hook mutates `mesh` directly (e.g. attaches mesh.skeleton).
            if (meshFeatures.length > 0) {
                await Promise.all(meshFeatures.map((f) => f.applyMesh!(m, mesh, ctx)));
            }

            return mesh as Mesh;
        })
    );

    return meshes;
}
