import type { Mat4 } from "../math/types.js";
import type { EngineContext } from "../engine/engine.js";
import type { EngineContextInternal } from "../engine/engine.js";
import type { TransformNode } from "../scene/transform-node.js";
import type { AssetContainer } from "../asset-container.js";
import { createTransformNode } from "../scene/transform-node.js";
import type { Texture2D } from "../texture/texture-2d.js";
import type { PbrMaterialPropsInternal } from "../material/pbr/pbr-material.js";
import { pbrGroupBuilder } from "../material/pbr/pbr-material.js";
import type { Mesh, MeshGPU, MeshInternal } from "../mesh/mesh.js";
import { initMeshTransform } from "../mesh/mesh.js";
import { getOrCreateSampler } from "../resource/gpu-pool.js";
import { parseGlbContainer, resolveAccessor, buildParentMap, computeNodeWorldMatrix } from "./gltf-parser.js";
import type { GltfMaterialData } from "./gltf-material.js";
import { assembleMaterial } from "./gltf-material.js";
import type { MaterialVariantData } from "./material-variants.js";

function mipLevelCount(w: number, h: number): number {
    return Math.floor(Math.log2(Math.max(w, h))) + 1;
}

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
    /** Joint indices (4 per vertex), for skeletal animation. */
    joints: Uint16Array | Uint8Array | null;
    /** Joint blend weights (4 per vertex). */
    weights: Float32Array | null;
    /** Extra joint indices for 8-bone skinning (JOINTS_1). */
    joints1: Uint16Array | Uint8Array | null;
    /** Extra blend weights for 8-bone skinning (WEIGHTS_1). */
    weights1: Float32Array | null;
    /** Skin data if this mesh has skeletal deformation. */
    skin: GltfSkinData | null;
    /** Morph target deltas (position + optional normal per target). */
    morphTargets: { positions: Float32Array; normals: Float32Array | null }[] | null;
    /** Initial morph weights (one per target). */
    morphWeights: number[] | null;
    /** glTF node index this mesh came from (for hierarchy reconstruction). */
    nodeIndex: number;
}

/** Parsed skin/skeleton data. */
export interface GltfSkinData {
    /** Node indices of joints in this skin. */
    jointNodes: number[];
    /** Inverse bind matrices — one 4×4 per joint (column-major Float32Array). */
    inverseBindMatrices: Float32Array;
    /** World matrices of each joint at rest pose. */
    jointWorldMatrices: Mat4[];
    /** World matrix of the mesh node that owns this skin. */
    meshWorldMatrix: Mat4;
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
    const isGlb = url.toLowerCase().endsWith(".glb");
    let json: any;
    let binChunk: DataView;
    let baseUrl: string;

    if (isGlb) {
        const buffer = await fetch(url).then((r) => r.arrayBuffer());
        ({ json, binChunk } = parseGlbContainer(buffer));
        baseUrl = url.substring(0, url.lastIndexOf("/") + 1);
    } else {
        // .gltf: fetch JSON, then resolve external buffer
        baseUrl = url.substring(0, url.lastIndexOf("/") + 1);
        json = await fetch(url).then((r) => r.json());
        const bufferDef = json.buffers?.[0];
        if (bufferDef?.uri) {
            const binUrl = new URL(bufferDef.uri, baseUrl + "x").href; // resolve relative to base
            const binBuffer = await fetch(binUrl).then((r) => r.arrayBuffer());
            binChunk = new DataView(binBuffer);
        } else {
            binChunk = new DataView(new ArrayBuffer(0));
        }
    }

    // Build parent map + world-matrix cache once for O(n) hierarchy traversal
    const parentMap = buildParentMap(json);
    const worldMatrixCache = new Map<number, Mat4>();

    // Parse KHR_materials_variants variant names from root extension (if present)
    const variantDefs: { name: string }[] | undefined = json.extensions?.KHR_materials_variants?.variants;
    const variantNames: string[] | undefined = variantDefs?.map((v: { name: string }) => v.name);
    const hasVariants = !!variantNames?.length;

    // Pre-load animation + variant modules in parallel with mesh extraction (dynamic import for tree-shaking)
    const hasAnimations = !!json.animations?.length;
    const animModulePromise = hasAnimations ? Promise.all([import("./gltf-animation.js"), import("../animation/animation-group.js")]) : null;
    const variantModulePromise = hasVariants ? import("./gltf-variants.js") : null;

    const meshDatas = await extractAllMeshes(json, binChunk, baseUrl, parentMap, worldMatrixCache);
    const meshes = await uploadMeshes(engine as EngineContextInternal, meshDatas);

    // Build TransformNode hierarchy from glTF nodes.
    // Hierarchy meshes get their worldMatrix cleared — the tree computes it.
    const root = buildNodeHierarchy(json, meshes, meshDatas);

    // Parse animation data (clips + node hierarchy + skeleton bindings)
    let animationGroups: import("../animation/animation-group.js").AnimationGroup[] | undefined;
    if (hasAnimations) {
        const [{ parseAnimationData }, { createAnimationGroups }] = (await animModulePromise)!;
        const animData = parseAnimationData(json, binChunk, meshes, parentMap, worldMatrixCache);

        if (animData && animData.clips.length > 0 && (animData.skeletons.length > 0 || animData.morphBindings.length > 0)) {
            animationGroups = createAnimationGroups(animData);
        }
    }

    // Build KHR_materials_variants data (fully dynamic — zero overhead for non-variant models)
    let materialVariants: MaterialVariantData | undefined;
    if (hasVariants) {
        const { loadVariantMaterials } = (await variantModulePromise)!;
        materialVariants = await loadVariantMaterials(json, binChunk, baseUrl, variantNames!, meshes, engine as EngineContextInternal);
    }

    // Return AssetContainer — addToScene() handles hierarchy, animation ticks, and clearColor.
    return { entities: [root], animationGroups, materialVariants };
}

// --- Hierarchy Reconstruction ---

/** Build a TransformNode tree mirroring the glTF node hierarchy.
 *  Meshes are attached as children. Non-mesh nodes become
 *  pure TransformNodes preserving TRS for cloning/repositioning.
 *  Parent links are set by addToScene() when the tree is added to the scene. */
function buildNodeHierarchy(json: any, meshes: Mesh[], meshDatas: GltfMeshData[]): TransformNode {
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

    // Recursive builder
    function buildNode(nodeIdx: number): TransformNode {
        const node = json.nodes[nodeIdx];
        const t = node.translation ?? [0, 0, 0];
        const r = node.rotation ?? [0, 0, 0, 1];
        const s = node.scale ?? [1, 1, 1];
        const tn = createTransformNode(node.name ?? `node_${nodeIdx}`, t[0], t[1], t[2], r[0], r[1], r[2], r[3], s[0], s[1], s[2]);
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
    return root;
}

// --- Mesh Extraction ---

async function extractAllMeshes(json: any, binChunk: DataView, baseUrl: string, parentMap: Map<number, number>, worldMatrixCache: Map<number, Mat4>): Promise<GltfMeshData[]> {
    // Pre-load skin extraction once if any node uses a skin (avoids per-primitive dynamic import)
    const needsSkin = json.nodes.some((n: any) => n.skin !== undefined) && !!json.skins;
    const extractSkinFn = needsSkin ? (await import("./gltf-animation.js")).extractSkin : null;

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
            const resolve = (idx: number | undefined) => (idx !== undefined ? resolveAccessor(json, binChunk, idx) : null);

            const posData = resolveAccessor(json, binChunk, attrs.POSITION);
            const normData = resolveAccessor(json, binChunk, attrs.NORMAL);
            const uvData = resolve(attrs.TEXCOORD_0);
            const tanData = resolve(attrs.TANGENT);
            const idxData = resolve(primitive.indices);

            // Keep vertex data as-is from glTF — RH→LH conversion handled by root world matrix
            const indices = idxData
                ? idxData.data instanceof Uint32Array
                    ? new Uint32Array(idxData.data as Uint32Array)
                    : new Uint16Array(idxData.data.buffer, idxData.data.byteOffset, idxData.count)
                : new Uint16Array(0);

            // Joints + weights for skeletal animation (4-bone + optional 8-bone)
            const jointsData = resolve(attrs.JOINTS_0);
            const weightsData = resolve(attrs.WEIGHTS_0);
            const joints1Data = resolve(attrs.JOINTS_1);
            const weights1Data = resolve(attrs.WEIGHTS_1);

            // Skin extraction is synchronous once the module is loaded
            let skin: GltfSkinData | null = null;
            if (node.skin !== undefined && extractSkinFn) {
                skin = extractSkinFn(json, binChunk, node.skin, worldMatrix, parentMap, worldMatrixCache);
            }

            // Morph targets
            let morphTargets: { positions: Float32Array; normals: Float32Array | null }[] | null = null;
            let morphWeights: number[] | null = null;
            if (primitive.targets && primitive.targets.length > 0) {
                morphTargets = [];
                for (const target of primitive.targets) {
                    const posAcc = target.POSITION !== undefined ? resolveAccessor(json, binChunk, target.POSITION) : null;
                    const normAcc = target.NORMAL !== undefined ? resolveAccessor(json, binChunk, target.NORMAL) : null;
                    morphTargets.push({
                        positions: posAcc ? (posAcc.data as Float32Array) : new Float32Array(posData.count * 3),
                        normals: normAcc ? (normAcc.data as Float32Array) : null,
                    });
                }
                morphWeights = mesh.weights ?? new Array(primitive.targets.length).fill(0);
            }

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
                joints: (jointsData?.data ?? null) as Uint16Array | Uint8Array | null,
                weights: (weightsData?.data ?? null) as Float32Array | null,
                joints1: (joints1Data?.data ?? null) as Uint16Array | Uint8Array | null,
                weights1: (weights1Data?.data ?? null) as Float32Array | null,
                skin,
                morphTargets,
                morphWeights,
                nodeIndex: nodeIdx,
            });
        }
    }

    // Resolve all material fetches in parallel
    const materials = await Promise.all(matPromises);
    return partials.map((p, i) => ({ ...p, material: materials[i]! }));
}

// --- GPU Upload ---

function createBufferFromData(engine: EngineContextInternal, data: ArrayBufferView, usage: GPUBufferUsageFlags): GPUBuffer {
    const device = engine.device;
    const size = Math.max(data.byteLength, 4);
    const buffer = device.createBuffer({
        size: (size + 3) & ~3, // align to 4 bytes — required when mappedAtCreation is true
        usage: usage | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true,
    });
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    buffer.unmap();
    return buffer;
}

/** Convert linear [0,1] to sRGB [0,255]. */
function linearToSrgbByte(v: number): number {
    const c = Math.max(0, Math.min(1, v));
    return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
}

// Pre-resolved generateMipmaps function — loaded once before texture uploads
let _generateMipmaps: ((engine: EngineContextInternal, texture: GPUTexture, face?: number) => void) | null = null;

async function ensureMipmapModule(): Promise<void> {
    if (!_generateMipmaps) {
        _generateMipmaps = (await import("../texture/generate-mipmaps.js")).generateMipmaps;
    }
}

function uploadTextureSynced(engine: EngineContextInternal, bitmap: ImageBitmap | null, srgb: boolean, sampler: GPUSampler, fallbackBytes?: Uint8Array): Texture2D {
    const device = engine.device;
    const w = bitmap?.width ?? 1;
    const h = bitmap?.height ?? 1;
    const format: GPUTextureFormat = srgb ? "rgba8unorm-srgb" : "rgba8unorm";
    const mips = bitmap ? mipLevelCount(w, h) : 1;

    const texture = device.createTexture({
        size: { width: w, height: h },
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
        mipLevelCount: mips,
    });

    if (bitmap) {
        device.queue.copyExternalImageToTexture({ source: bitmap }, { texture, premultipliedAlpha: false }, { width: w, height: h });
        _generateMipmaps!(engine, texture);
    } else {
        device.queue.writeTexture({ texture }, (fallbackBytes ?? new Uint8Array([255, 255, 255, 255])) as Uint8Array<ArrayBuffer>, { bytesPerRow: 4 }, { width: 1, height: 1 });
    }

    return { texture, view: texture.createView(), sampler, width: w, height: h };
}

async function uploadMeshes(engine: EngineContextInternal, meshDatas: GltfMeshData[]): Promise<Mesh[]> {
    const sampler = getOrCreateSampler(engine, {
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
        addressModeU: "repeat",
        addressModeV: "repeat",
        maxAnisotropy: 4,
    });

    // Pre-load dynamic imports once before the mesh loop
    const needsSkeleton = meshDatas.some((m) => m.joints && m.weights && m.skin);
    const needsMorph = meshDatas.some((m) => m.morphTargets && m.morphTargets.length > 0);
    const needsOrmComposite = meshDatas.some((m) => {
        const mat = m.material;
        return !!(mat.metallicRoughnessImage && mat.occlusionImage && mat.metallicRoughnessImage !== mat.occlusionImage);
    });
    const [, skelMods, morphMod, ormMod] = await Promise.all([
        ensureMipmapModule(),
        needsSkeleton ? Promise.all([import("./gltf-animation.js"), import("../skeleton/create-skeleton.js")]) : null,
        needsMorph ? import("../morph/create-morph-targets.js") : null,
        needsOrmComposite ? import("./gltf-orm-composite.js") : null,
    ]);
    const computeBoneTextureDataFn = skelMods?.[0].computeBoneTextureData ?? null;
    const createSkeletonFn = skelMods?.[1].createSkeleton ?? null;
    const createMorphTargetsFn = morphMod?.createMorphTargets ?? null;
    const compositeOrmFn = ormMod?.compositeOrm ?? null;

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

    function getOrmTexture(mat: GltfMaterialData): Promise<Texture2D> | Texture2D {
        const mrImg = mat.metallicRoughnessImage;
        const occImg = mat.occlusionImage;
        if (mrImg && occImg && mrImg !== occImg && compositeOrmFn) {
            // Separate MR + occlusion: composite R=occlusion into MR texture (dyn-imported)
            return compositeOrmFn(mrImg, occImg).then((bmp) => uploadTextureSynced(engine, bmp, false, sampler));
        } else if (mrImg ?? occImg) {
            return getCachedTexture((mrImg ?? occImg)!, false);
        } else {
            const rf = mat.roughnessFactor,
                mf = mat.metallicFactor;
            const clampByte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
            return uploadTextureSynced(engine, null, false, sampler, new Uint8Array([255, clampByte(rf), clampByte(mf), 255]));
        }
    }

    // Build a PbrMaterialPropsInternal from parsed glTF material data.
    // Uses shared texture caches so identical bitmaps are uploaded once.
    const builtMaterialCache = new Map<GltfMaterialData, Promise<PbrMaterialPropsInternal>>();
    async function buildPbrFromGltfMat(mat: GltfMaterialData): Promise<PbrMaterialPropsInternal> {
        let cached = builtMaterialCache.get(mat);
        if (cached) {
            return cached;
        }
        cached = (async () => {
            const baseColorTexture = mat.baseColorImage
                ? getCachedTexture(mat.baseColorImage, true)
                : (() => {
                      const f = mat.baseColorFactor;
                      const bytes = new Uint8Array([linearToSrgbByte(f[0]), linearToSrgbByte(f[1]), linearToSrgbByte(f[2]), Math.round(Math.max(0, Math.min(1, f[3])) * 255)]);
                      return uploadTextureSynced(engine, null, true, sampler, bytes);
                  })();
            const normalTexture = mat.normalImage ? getCachedTexture(mat.normalImage, false) : undefined;
            const emissiveTexture = mat.emissiveImage ? getCachedTexture(mat.emissiveImage, true) : undefined;
            const specGlossTexture = mat.specGlossImage ? getCachedTexture(mat.specGlossImage, true) : undefined;
            const ormTexture = await getOrmTexture(mat);
            let layers: Partial<import("../material/pbr/pbr-material.js").PbrMaterialProps> | undefined;
            if (mat.clearcoat || mat.sheen || mat.anisotropy) {
                const mod = await import("./gltf-material-layers.js");
                const ccTextures = mat.clearcoat
                    ? {
                          ccTexture: mat.clearcoatImage ? getCachedTexture(mat.clearcoatImage, false) : undefined,
                          ccRoughnessTexture: mat.clearcoatRoughnessImage ? getCachedTexture(mat.clearcoatRoughnessImage, false) : undefined,
                          ccNormalTexture: mat.clearcoatNormalImage ? getCachedTexture(mat.clearcoatNormalImage, false) : undefined,
                      }
                    : undefined;
                layers = mod.buildPbrLayers(mat, ccTextures);
            }

            return {
                baseColorTexture,
                normalTexture,
                ormTexture,
                emissiveTexture,
                specGlossTexture,
                doubleSided: mat.doubleSided,
                occlusionStrength: mat.occlusionImage ? 1.0 : 0,
                // Apply glTF metallicFactor/roughnessFactor only when a real MR texture is present.
                // When no MR texture, the factors are already baked into the 1×1 fallback ORM bytes above.
                ...(mat.metallicRoughnessImage ? { metallicFactor: mat.metallicFactor, roughnessFactor: mat.roughnessFactor } : undefined),
                enableSpecularAA: true,
                ...(mat.alphaMode === "BLEND" ? { alphaBlend: true, alpha: mat.baseColorFactor[3] } : undefined),
                ...layers,
                _buildGroup: pbrGroupBuilder,
            } satisfies PbrMaterialPropsInternal;
        })();
        builtMaterialCache.set(mat, cached);
        return cached;
    }

    const meshes = await Promise.all(
        meshDatas.map(async (m, i): Promise<Mesh> => {
            const material = await buildPbrFromGltfMat(m.material);

            const [boundMin, boundMax] = computeWorldBounds(m.positions, m.worldMatrix);

            // Skeleton (modules already pre-loaded)
            let skeleton: import("../animation/types.js").SkeletonData | null = null;
            if (m.joints && m.weights && m.skin && computeBoneTextureDataFn && createSkeletonFn) {
                const boneCount = m.skin.jointNodes.length;
                const boneData = computeBoneTextureDataFn(m.skin);
                skeleton = createSkeletonFn(engine, m.joints, m.weights, boneCount, boneData, m.joints1, m.weights1);
            }

            // Morph targets (module already pre-loaded)
            let morphTargets: import("../animation/types.js").MorphTargetData | null = null;
            if (m.morphTargets && m.morphTargets.length > 0 && createMorphTargetsFn) {
                morphTargets = createMorphTargetsFn(engine, m.morphTargets, m.vertexCount, m.morphWeights);
            }

            const gpu: MeshGPU = {
                positionBuffer: createBufferFromData(engine, m.positions, GPUBufferUsage.VERTEX),
                normalBuffer: createBufferFromData(engine, m.normals, GPUBufferUsage.VERTEX),
                tangentBuffer: m.tangents ? createBufferFromData(engine, m.tangents, GPUBufferUsage.VERTEX) : null,
                uvBuffer: createBufferFromData(engine, m.uvs, GPUBufferUsage.VERTEX),
                indexBuffer: createBufferFromData(engine, m.indices, GPUBufferUsage.INDEX),
                indexCount: m.indexCount,
                indexFormat: (m.indices instanceof Uint32Array ? "uint32" : "uint16") as GPUIndexFormat,
            };

            const mesh = {
                name: `gltf_mesh_${i}`,
                material,
                receiveShadows: false,
                boundMin,
                boundMax,
                skeleton,
                morphTargets,
                _materialDirty: false,
                _gpu: gpu,
            } as unknown as MeshInternal;
            initMeshTransform(mesh);

            // Retain CPU geometry for detailed picking
            mesh._cpuPositions = m.positions;
            mesh._cpuNormals = m.normals;
            mesh._cpuUvs = m.uvs;
            mesh._cpuIndices = m.indices instanceof Uint32Array ? m.indices : new Uint32Array(m.indices);

            return mesh as Mesh;
        })
    );

    return meshes;
}

/** Compute world-space AABB from local positions x world matrix. */
function computeWorldBounds(positions: Float32Array, world: Mat4): [[number, number, number], [number, number, number]] {
    let minX = Infinity,
        minY = Infinity,
        minZ = Infinity;
    let maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;

    for (let i = 0; i < positions.length; i += 3) {
        const lx = positions[i]!;
        const ly = positions[i + 1]!;
        const lz = positions[i + 2]!;
        // Column-major transform: m[col*4+row]
        const wx = world[0]! * lx + world[4]! * ly + world[8]! * lz + world[12]!;
        const wy = world[1]! * lx + world[5]! * ly + world[9]! * lz + world[13]!;
        const wz = world[2]! * lx + world[6]! * ly + world[10]! * lz + world[14]!;
        if (wx < minX) {
            minX = wx;
        }
        if (wx > maxX) {
            maxX = wx;
        }
        if (wy < minY) {
            minY = wy;
        }
        if (wy > maxY) {
            maxY = wy;
        }
        if (wz < minZ) {
            minZ = wz;
        }
        if (wz > maxZ) {
            maxZ = wz;
        }
    }

    return [
        [minX, minY, minZ],
        [maxX, maxY, maxZ],
    ];
}
