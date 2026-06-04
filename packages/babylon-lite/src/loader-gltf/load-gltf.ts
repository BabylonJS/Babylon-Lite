import type { Mat4 } from "../math/types.js";
import { computeAabb } from "../math/compute-aabb.js";
import type { EngineContext } from "../engine/engine.js";
import type { TransformNode } from "../scene/transform-node.js";
import type { AssetContainer } from "../asset-container.js";
import { createTransformNode } from "../scene/transform-node.js";
import { createSceneNodeFromMatrix } from "../scene/scene-node.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { PbrMaterialProps } from "../material/pbr/pbr-material.js";
import type { Mesh, MeshGPU } from "../mesh/mesh.js";
import { initMeshTransform } from "../mesh/mesh.js";
import { getOrCreateSampler } from "../resource/gpu-pool.js";
import { createMappedBuffer } from "../resource/gpu-buffers.js";
import { resolveAccessor, buildParentMap, computeNodeWorldMatrix, getTextureImageIndex, TYPE_SIZES } from "./gltf-parser.js";
import type { AccessorView } from "./gltf-parser.js";
import type { GltfVb } from "./gltf-interleave.js";
import type { GltfMaterialData, GltfMatExtCtx } from "./gltf-material.js";
import { assembleMaterial, makeImageFetcher } from "./gltf-material.js";
import type { DecodedPrimitive, GltfFeature, GltfLoadCtx } from "./gltf-feature.js";
import type { TextureWrapFn } from "./gltf-pbr-builder.js";
import { assemblePbrProps, buildDefaultPbrTextures, identityTexWrap, runMatExts, uploadTex } from "./gltf-pbr-builder.js";
import type * as GltfPbrBuilderExt from "./gltf-pbr-builder-ext.js";

/** Dynamically-imported interleave module — loaded only when an asset actually
 *  contains a strided bufferView, so non-interleaved scenes pay zero cost. */
type InterleaveModule = typeof import("./gltf-interleave.js");
let _interleavePromise: Promise<InterleaveModule> | undefined;
function loadInterleave(): Promise<InterleaveModule> {
    return (_interleavePromise ??= import("./gltf-interleave.js"));
}

/** Parsed mesh data ready for GPU upload. */
export interface GltfMeshData {
    /** @internal Tight CPU positions, or null when sourced from an interleaved
     *  bufferView (in which case `_vb._p` holds the strided source for lazy de-striding). */
    _positions: Float32Array | null;
    /** @internal */
    _normals: Float32Array | null;
    /** @internal */
    _tangents: Float32Array | null;
    /** @internal */
    _uvs: Float32Array | null;
    /** @internal */
    _uv2s: Float32Array | null;
    /** @internal */
    _colors: Float32Array | null;
    /** @internal */
    _indices: Uint16Array | Uint32Array;
    /** @internal */
    _vertexCount: number;
    /** @internal */
    _indexCount: number;
    /** @internal */
    _worldMatrix: Mat4;
    /** @internal */
    _material: GltfMaterialData;
    /** @internal Interleaved vertex sources (genuine GPU interleaving + lazy CPU de-stride).
     *  Absent → all tight. */
    _vb?: GltfVb;
    /** @internal glTF node index this mesh came from (for hierarchy reconstruction
     *  and for features that need to resolve skin/morph data lazily). */
    _nodeIndex: number;
    /** @internal Raw primitive definition — features (skeleton, morph, …) read their
     *  own attributes/targets from here without bloating core extraction. */
    _primitive: any;
    /** @internal Pre-decoded primitive (Draco et al.) if a preMesh feature produced one. */
    _decoded?: DecodedPrimitive;
}

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

    // Pre-parse hooks (EXT_meshopt_compression decompression, KHR_mesh_quantization
    // dequantization) may rewrite bufferViews/accessors and hand back a replacement
    // binary chunk. Run sequentially in registry order so later features see earlier
    // rewrites. No-op (and zero cost) when no triggered feature defines preParse.
    let activeBin = binChunk;
    for (const f of features) {
        if (f.preParse) {
            const replacement = await f.preParse(json, activeBin);
            if (replacement) {
                activeBin = replacement;
            }
        }
    }

    const matExts: GltfFeature[] = features.filter((f) => f.applyMaterial);
    // Compose every feature's wrapTexture hook into a single function. Identity
    // when no feature contributes one (common case) — keeps the hot path free
    // of per-texture work and lets bundlers tree-shake the helpers.
    const texWraps = features.filter((f) => f.wrapTexture).map((f) => f.wrapTexture!);
    const wrapTex: TextureWrapFn = !texWraps.length ? identityTexWrap : (tex, ti) => texWraps.reduce((acc, w) => w(acc, ti), tex);

    // Run every feature's pre-mesh hook (e.g. Draco decompression) and merge
    // their primitive-keyed decode caches. Features without `preMesh` contribute
    // nothing; the map stays empty when no primitive-level feature triggered.
    const decodedPrimitives = new Map<unknown, DecodedPrimitive>();
    for (const frag of await Promise.all(features.flatMap((f) => (f.preMesh ? [f.preMesh(json, activeBin, baseUrl)] : [])))) {
        for (const [k, v] of frag) {
            decodedPrimitives.set(k, v);
        }
    }

    const meshDatas = await extractAllMeshes(json, activeBin, baseUrl, parentMap, worldMatrixCache, decodedPrimitives);

    const ctx: GltfLoadCtx = {
        _engine: engine,
        _json: json,
        _binChunk: activeBin,
        _baseUrl: baseUrl,
        _parentMap: parentMap,
        _worldMatrixCache: worldMatrixCache,
        _matExts: matExts,
        _wrapTex: wrapTex,
    };

    const meshes = await uploadMeshes(meshDatas, features, ctx);

    // Build TransformNode hierarchy from glTF nodes. Returns both the synthetic root
    // and a glTF-node-index → SceneNode map (used by node-visibility + animation-pointer).
    const { root, nodeMap } = buildNodeHierarchy(json, meshes, meshDatas);
    ctx._nodeMap = nodeMap;

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
        const { parseGlbContainer } = await import("./gltf-glb-parser.js");
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
        if (mr && occ && textures[mr.index] && textures[occ.index] && getTextureImageIndex(textures[mr.index]) !== getTextureImageIndex(textures[occ.index])) {
            return true;
        }
    }
    return false;
}

const _features: GltfFeatureLoader[] = [
    // Pre-parse features (buffer-level): order matters — meshopt decompresses
    // bufferViews first, then quantization dequantizes the resulting accessors.
    [hasExt("EXT_meshopt_compression"), () => import("./gltf-feature-meshopt.js")],
    [hasExt("KHR_mesh_quantization"), () => import("./gltf-ext-quantization.js")],
    // Pre-mesh features (geometry decompression)
    [hasExt("KHR_draco_mesh_compression"), () => import("./gltf-feature-draco.js")],
    // Material extensions
    [hasMatExt("clearcoat"), () => import("./gltf-ext-clearcoat.js")],
    [hasMatExt("iridescence"), () => import("./gltf-ext-iridescence.js")],
    [hasMatExt("emissive_strength"), () => import("./gltf-ext-emissive-strength.js")],
    [hasMatExt("sheen"), () => import("./gltf-ext-sheen.js")],
    [hasMatExt("anisotropy"), () => import("./gltf-ext-anisotropy.js")],
    [hasMatExt("unlit"), () => import("./gltf-ext-unlit.js")],
    [hasMatExt("pbrSpecularGlossiness"), () => import("./gltf-ext-spec-gloss.js")],
    // Dielectric cluster (ior/specular/transmission/volume) — any of the four triggers the loader;
    // transmission refraction is wired dynamically by the PBR material path when the loaded material needs it.
    [(j) => ["transmission", "volume", "ior", "specular", "dispersion"].some((e) => hasMatExt(e)(j)), () => import("./gltf-ext-dielectric.js")],
    [hasExt("KHR_texture_transform"), () => import("./gltf-ext-uv-transform.js")],
    [hasExt("KHR_texture_basisu"), () => import("./gltf-ext-basisu.js")],
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
    [hasExt("KHR_xmp_json_ld"), () => import("./gltf-feature-xmp.js")],
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
        const ni = meshDatas[i]!._nodeIndex;
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
        const name = node.name ?? `node_${nodeIdx}`;
        let tn: TransformNode;
        if (node.matrix) {
            tn = createSceneNodeFromMatrix(name, node.matrix as Mat4);
        } else {
            const t = node.translation ?? [0, 0, 0];
            const r = node.rotation ?? [0, 0, 0, 1];
            const s = node.scale ?? [1, 1, 1];
            tn = createTransformNode(name, t[0], t[1], t[2], r[0], r[1], r[2], r[3], s[0], s[1], s[2]);
        }
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
    const partials: Array<Omit<GltfMeshData, "_material">> = [];
    const matPromises: Promise<GltfMaterialData>[] = [];

    // Genuine GPU interleaving is the ONLY reason to touch the interleave module.
    // Many exporters declare `byteStride` even on tightly-packed bufferViews, and a
    // preMesh feature (e.g. the basisu extension's readStridedFloat path) may already
    // de-stride a primitive — so we load the module only for a primitive that is
    // genuinely over-strided AND not already decoded. Other scenes pay zero cost: the
    // module is fetched lazily on the first such primitive (memoized), never before.
    const _accs = json.accessors as any[];
    const _bvs = json.bufferViews as any[] | undefined;
    const _strided = (p: any): boolean => {
        for (const k in p.attributes) {
            const a = _accs[p.attributes[k]];
            const s = _bvs?.[a?.bufferView]?.byteStride;
            if (
                s !== undefined &&
                s !== (TYPE_SIZES[a.type] ?? 1) * (a.componentType === 5126 || a.componentType === 5125 ? 4 : a.componentType === 5123 || a.componentType === 5122 ? 2 : 1)
            ) {
                return true;
            }
        }
        return false;
    };

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

            // Genuine GPU interleaving: only a primitive that genuinely sources ≥1
            // attribute from an over-strided bufferView (and was not already decoded
            // by a preMesh feature) takes this path. The module is imported lazily on
            // first need — non-interleaved assets never fetch it. Tight primitives
            // fall through to the path below (byte-identical to non-interleaved).
            if (!decoded && _strided(primitive)) {
                const ip = (await loadInterleave()).buildInterleavedPartial(json, binChunk, primitive, worldMatrix, nodeIdx);
                if (ip) {
                    matPromises.push(getMat(primitive.material));
                    partials.push(ip);
                    continue;
                }
            }

            const resolveAttr = (name: string): AccessorView | null => {
                if (decoded && decoded._attributes.has(name)) {
                    const data = decoded._attributes.get(name)!;
                    const componentCount = data.length / decoded._vertexCount;
                    return { _data: data, _count: decoded._vertexCount, _componentCount: componentCount };
                }
                const idx = attrs[name];
                return idx !== undefined ? resolveAccessor(json, binChunk, idx) : null;
            };
            const posData = resolveAttr("POSITION")!;
            const normData = resolveAttr("NORMAL")!;
            const uvData = resolveAttr("TEXCOORD_0");
            const uv2Data = resolveAttr("TEXCOORD_1");
            const tanData = resolveAttr("TANGENT");
            const colorData = resolveAttr("COLOR_0");
            const idxData = decoded
                ? { _data: decoded._indices, _count: decoded._indexCount, _componentCount: 1 }
                : primitive.indices !== undefined
                  ? resolveAccessor(json, binChunk, primitive.indices)
                  : null;

            // Keep vertex data as-is from glTF — RH→LH conversion handled by root world matrix
            const indices = idxData
                ? idxData._data instanceof Uint32Array
                    ? new Uint32Array(idxData._data as Uint32Array)
                    : idxData._data instanceof Uint8Array
                      ? Uint16Array.from(idxData._data as Uint8Array)
                      : new Uint16Array(idxData._data!.buffer, idxData._data!.byteOffset, idxData._count)
                : new Uint16Array(0);

            // Fire material fetch without awaiting — all materials load in parallel
            matPromises.push(getMat(primitive.material));

            partials.push({
                _positions: posData._data as Float32Array,
                _normals: normData._data as Float32Array,
                _tangents: tanData ? (tanData._data as Float32Array) : null,
                _uvs: uvData ? (uvData._data as Float32Array) : new Float32Array(posData._count * 2),
                _uv2s: uv2Data ? (uv2Data._data as Float32Array) : null,
                _colors: colorData ? (colorData._data as Float32Array) : null,
                _indices: indices,
                _vertexCount: posData._count,
                _indexCount: idxData?._count ?? 0,
                _worldMatrix: worldMatrix,
                _nodeIndex: nodeIdx,
                _primitive: primitive,
                _decoded: decoded,
            });
        }
    }

    // Resolve all material fetches in parallel
    const materials = await Promise.all(matPromises);
    return partials.map((p, i) => ({ ...p, _material: materials[i]! }));
}

// --- GPU Upload ---

// Pre-resolved generateMipmaps function— loaded once before texture uploads
let _generateMipmaps: ((engine: EngineContext, texture: GPUTexture, face?: number) => void) | null = null;

async function ensureMipmapModule(): Promise<void> {
    if (!_generateMipmaps) {
        _generateMipmaps = (await import("../texture/generate-mipmaps.js")).generateMipmaps;
    }
}

async function uploadMeshes(meshDatas: GltfMeshData[], features: GltfFeature[], ctx: GltfLoadCtx): Promise<Mesh[]> {
    const { _engine: engine, _json: json, _binChunk: binChunk, _baseUrl: baseUrl, _matExts: matExts, _wrapTex: wrapTex } = ctx;
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
    const texCache = new Map<number, Texture2D>();
    let texId = 0;
    const bitmapIds = new Map<ImageBitmap, number>();

    function getCachedTexture(bitmap: ImageBitmap, srgb: boolean): Texture2D {
        let id = bitmapIds.get(bitmap);
        if (id === undefined) {
            bitmapIds.set(bitmap, (id = texId++));
        }
        const key = id * 2 + +srgb;
        let tex = texCache.get(key);
        if (!tex) {
            tex = uploadTex(engine, bitmap, srgb, sampler, _generateMipmaps!);
            texCache.set(key, tex);
        }
        return tex;
    }

    // Per-load image fetcher for ext modules (uses same image cache as core).
    const extImageCache = matExts.length ? new Map<number, Promise<ImageBitmap>>() : null;
    const extFetchImg = extImageCache ? makeImageFetcher(json, binChunk, baseUrl, extImageCache) : null;
    const extCtx: GltfMatExtCtx = {
        _engine: engine,
        async _texture(texInfo, sRGB) {
            if (!texInfo || !extFetchImg) {
                return undefined;
            }
            const img = await extFetchImg(texInfo);
            return img ? wrapTex(getCachedTexture(img, sRGB), texInfo) : undefined;
        },
        _uploadImage(bitmap, sRGB) {
            return uploadTex(engine, bitmap, sRGB, sampler, _generateMipmaps!);
        },
    };

    // Slow-path trigger: per-texture UV wrapping (KHR_texture_transform)
    // or any core texture declaring texCoord=1. Scene1 stays identity→fast path.
    let _needsPbrExt = wrapTex !== identityTexWrap;
    if (!_needsPbrExt) {
        const mats = (json as { materials?: unknown[] }).materials;
        if (mats && JSON.stringify(mats).includes('"texCoord":1')) {
            _needsPbrExt = true;
        }
    }
    let _pbrExtPromise: Promise<typeof GltfPbrBuilderExt> | null = null;
    const _ensurePbrExt = () => (_pbrExtPromise ??= import("./gltf-pbr-builder-ext.js"));

    /** Default ORM upload: single MR-or-occlusion image, or 1×1 fallback baked from
     *  metallicFactor/roughnessFactor. The composite case (MR+occlusion separate) is
     *  handled by the gltf-ext-orm extension which overrides this via `extLayers`. */

    // Build a PbrMaterialProps from parsed glTF material data.
    // Uses shared texture caches so identical bitmaps are uploaded once.
    const builtMaterialCache = new Map<GltfMaterialData, Promise<PbrMaterialProps>>();
    async function buildPbrFromGltfMat(mat: GltfMaterialData): Promise<PbrMaterialProps> {
        let cached = builtMaterialCache.get(mat);
        if (cached) {
            return cached;
        }
        cached = (async () => {
            const extLayers = await runMatExts(mat, matExts, extCtx);
            if (_needsPbrExt) {
                const extMod = await _ensurePbrExt();
                const tex = extMod.buildDefaultPbrTexturesExt(engine, mat, sampler, _generateMipmaps!, getCachedTexture, wrapTex);
                return extMod.assemblePbrPropsExt(mat, tex, extLayers);
            }
            const tex = buildDefaultPbrTextures(engine, mat, sampler, _generateMipmaps!, getCachedTexture);
            return assemblePbrProps(mat, tex.baseColorTexture, tex.ormTexture, tex.normalTexture, tex.emissiveTexture, extLayers);
        })();
        builtMaterialCache.set(mat, cached);
        return cached;
    }

    const meshes = await Promise.all(
        meshDatas.map(async (m, i): Promise<Mesh> => {
            const material = await buildPbrFromGltfMat(m._material);

            // Interleaved meshes are fully built by the dynamic module (kept out of
            // this bundle for non-interleaved scenes). The tight path below is
            // byte-identical to the non-interleaved engine.
            let mesh: Mesh;
            if (m._vb) {
                mesh = (await loadInterleave()).buildInterleavedMesh(engine, m, i, material) as Mesh;
            } else {
                const [boundMin, boundMax] = computeAabb(m._positions!, m._worldMatrix);
                const gpu: MeshGPU = {
                    positionBuffer: createMappedBuffer(engine, m._positions!, GPUBufferUsage.VERTEX),
                    normalBuffer: createMappedBuffer(engine, m._normals!, GPUBufferUsage.VERTEX),
                    tangentBuffer: m._tangents ? createMappedBuffer(engine, m._tangents, GPUBufferUsage.VERTEX) : null,
                    uvBuffer: createMappedBuffer(engine, m._uvs!, GPUBufferUsage.VERTEX),
                    uv2Buffer: m._uv2s ? createMappedBuffer(engine, m._uv2s, GPUBufferUsage.VERTEX) : null,
                    colorBuffer: m._colors ? createMappedBuffer(engine, m._colors, GPUBufferUsage.VERTEX) : null,
                    indexBuffer: createMappedBuffer(engine, m._indices, GPUBufferUsage.INDEX),
                    indexCount: m._indexCount,
                    indexFormat: (m._indices instanceof Uint32Array ? "uint32" : "uint16") as GPUIndexFormat,
                };

                mesh = {
                    name: `gltf_mesh_${i}`,
                    material,
                    receiveShadows: false,
                    boundMin,
                    boundMax,
                    skeleton: null,
                    morphTargets: null,
                    _materialDirty: false,
                    _gpu: gpu,
                } as unknown as Mesh;
                initMeshTransform(mesh);

                // Retain CPU geometry for detailed picking.
                mesh._cpuPositions = m._positions!;
                mesh._cpuNormals = m._normals!;
                mesh._cpuUvs = m._uvs!;
                mesh._cpuIndices = m._indices instanceof Uint32Array ? m._indices : new Uint32Array(m._indices);
                engine._dlr?.m(mesh, m._uv2s, m._tangents, m._colors, m._indices, gpu.indexFormat);
            }

            // Run all per-mesh feature hooks (skeleton, morph, …) in parallel.
            // Each hook mutates `mesh` directly (e.g. attaches mesh.skeleton).
            if (meshFeatures.length > 0) {
                await Promise.all(meshFeatures.map((f) => f.applyMesh!(m, mesh, ctx)));
            }

            return mesh;
        })
    );

    return meshes;
}
