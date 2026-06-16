/**
 * .babylon format loader — parses Babylon.js .babylon scene files.
 *
 * Supports:
 * - Standard materials with diffuse, bump, specular, ambient, lightmap, opacity textures
 * - Inline vertex data (positions, normals, UVs, indices)
 * - Point lights
 * - Scene clear color
 * - SubMesh → multi-material handling
 * - Parent-child hierarchy via parentId
 */

import { F32, U32 } from "../engine/typed-arrays.js";
import type { EngineContext } from "../engine/engine.js";
import type { AssetContainer } from "../asset-container.js";
import type { LightBase } from "../light/types.js";
import type { Mesh } from "../mesh/mesh.js";
import type { TransformNode } from "../scene/transform-node.js";
import type { SceneNode } from "../scene/scene-node.js";
import { createTransformNode } from "../scene/transform-node.js";
import { createStandardMaterial } from "../material/standard/create-standard-material.js";
import type { StandardMaterialProps } from "../material/standard/standard-material.js";
import { uploadMeshToGPU, initMeshTransform } from "../mesh/mesh.js";
import { loadTexture2D } from "../texture/texture-2d.js";
// ─── .babylon JSON Types ───────────────────────────────────────────

interface BabylonScene {
    clearColor?: number[];
    ambientColor?: number[];
    cameras?: BabylonCamera[];
    lights?: BabylonLight[];
    materials?: BabylonMaterial[];
    multiMaterials?: BabylonMultiMaterial[];
    meshes?: BabylonMesh[];
    activeCameraID?: string;
}

interface BabylonCamera {
    name: string;
    id: string;
    type: string;
    position: number[];
    rotation?: number[];
    target?: number[];
    fov?: number;
    minZ?: number;
    maxZ?: number;
}

interface BabylonTexture {
    name: string;
    hasAlpha?: boolean;
    getAlphaFromRGB?: boolean;
    isCube?: boolean;
    level?: number;
    coordinatesIndex?: number;
    coordinatesMode?: number;
    uOffset?: number;
    vOffset?: number;
    uScale?: number;
    vScale?: number;
}

interface BabylonMaterial {
    name: string;
    id: string;
    diffuse?: number[];
    specular?: number[];
    specularPower?: number;
    emissive?: number[];
    ambient?: number[];
    alpha?: number;
    alphaCutOff?: number;
    diffuseTexture?: BabylonTexture | null;
    bumpTexture?: BabylonTexture | null;
    specularTexture?: BabylonTexture | null;
    ambientTexture?: BabylonTexture | null;
    lightmapTexture?: BabylonTexture | null;
    emissiveTexture?: BabylonTexture | null;
    opacityTexture?: BabylonTexture | null;
    reflectionTexture?: BabylonTexture | null;
    backFaceCulling?: boolean;
}

interface BabylonMultiMaterial {
    name: string;
    id: string;
    materials: string[];
}

interface BabylonSubMesh {
    materialIndex: number;
    verticesStart: number;
    verticesCount: number;
    indexStart: number;
    indexCount: number;
}

interface BabylonMesh {
    name: string;
    id: string;
    parentId?: string | null;
    materialId?: string | null;
    position?: number[];
    rotation?: number[];
    scaling?: number[];
    localMatrix?: number[];
    positions?: number[];
    normals?: number[];
    uvs?: number[];
    uvs2?: number[];
    indices?: number[];
    subMeshes?: BabylonSubMesh[];
    isVisible?: boolean;
}

interface BabylonLight {
    name: string;
    id: string;
    type: number;
    position?: number[];
    direction?: number[];
    diffuse?: number[];
    specular?: number[];
    intensity?: number;
    range?: number;
    excludedMeshesIds?: string[];
    includedOnlyMeshesIds?: string[];
}

// ─── Standard-material texture-slot table ───────────────────────────
// Declarative description of .babylon -> StandardMaterialProps texture mapping.
// Each slot maps a source texture field on BabylonMaterial to a destination
// Texture2D field on StandardMaterialProps, plus optional level/coordIndex/extras.
type BabylonTexField = "diffuseTexture" | "bumpTexture" | "specularTexture" | "ambientTexture" | "lightmapTexture" | "opacityTexture" | "reflectionTexture";

interface BabylonTexSlot {
    readonly src: BabylonTexField;
    /** Destination Texture2D field on StandardMaterialProps. */
    readonly dst: string;
    /** StandardMaterialProps field receiving `t.level`, if present. */
    readonly level?: string;
    /** Coordinate-index mapping. `only1`=true → only apply when coordIndex===1. */
    readonly coordIndex?: { readonly dst: string; readonly only1?: boolean };
    /** Skip this slot for a texture if predicate returns true (e.g. cube reflections). */
    readonly skipIf?: (t: BabylonTexture) => boolean;
    /** Apply remaining slot-specific side-effects (uvScale, alphaCutOff, etc.). */
    readonly extra?: (t: BabylonTexture, mat: StandardMaterialProps) => void;
}

const TEX_SLOTS: readonly BabylonTexSlot[] = [
    {
        src: "diffuseTexture",
        dst: "diffuseTexture",
        coordIndex: { dst: "diffuseCoordIndex", only1: true },
        extra: (t, m) => {
            m.uvScale = [t.uScale ?? 1, t.vScale ?? 1];
            if (t.hasAlpha) {
                m.alphaCutOff = 0.4;
            }
        },
    },
    { src: "bumpTexture", dst: "bumpTexture", level: "bumpLevel" },
    { src: "specularTexture", dst: "specularTexture", coordIndex: { dst: "specularCoordIndex", only1: true } },
    { src: "ambientTexture", dst: "ambientTexture", level: "ambientTexLevel", coordIndex: { dst: "ambientCoordIndex", only1: true } },
    { src: "lightmapTexture", dst: "lightmapTexture", level: "lightmapLevel", coordIndex: { dst: "lightmapCoordIndex" } },
    {
        src: "opacityTexture",
        dst: "opacityTexture",
        level: "opacityLevel",
        extra: (t, m) => {
            if (t.getAlphaFromRGB) {
                m.opacityFromRGB = true;
            }
        },
    },
    {
        src: "reflectionTexture",
        dst: "reflectionTexture",
        level: "reflectionLevel",
        skipIf: (t) => t.isCube === true,
        extra: (t, m) => {
            if (t.coordinatesMode === 2) {
                m.reflectionCoordMode = 2;
            }
        },
    },
];

// ─── Public API ─────────────────────────────────────────────────────

export interface LoadBabylonOptions {
    /** Maximum number of meshes to load. Default: all. */
    maxMeshes?: number;
    /** Whether to load textures. Default: true. */
    loadTextures?: boolean;
    /** Whether to parse the camera from the file. Default: true. */
    loadCamera?: boolean;
}

/**
 * Load a .babylon scene file and return a AssetContainer.
 * Pass the result to addToScene() to populate the scene.
 *
 * @param engine - The engine (provides GPU device)
 * @param url - URL to the .babylon file
 * @param opts - Optional loader configuration
 */
export async function loadBabylon(engine: EngineContext, url: string, opts: LoadBabylonOptions = {}): Promise<AssetContainer> {
    const baseUrl = url.substring(0, url.lastIndexOf("/") + 1);

    const response = await fetch(url);
    const data: BabylonScene = await response.json();

    // Scene-level settings
    let clearColor: GPUColorDict | undefined;
    if (data.clearColor) {
        clearColor = {
            r: data.clearColor[0]!,
            g: data.clearColor[1]!,
            b: data.clearColor[2]!,
            a: 1,
        };
    }

    // Scene ambient color — BJS multiplies material.ambient by scene.ambientColor
    const sceneAmbient: [number, number, number] = data.ambientColor ? [data.ambientColor[0]!, data.ambientColor[1]!, data.ambientColor[2]!] : [0, 0, 0];
    // Build material map
    const materialMap = new Map<string, StandardMaterialProps>();
    const texturePromises: Promise<void>[] = [];

    if (data.materials) {
        for (const md of data.materials) {
            const mat = createStandardMaterial();
            if (md.diffuse) {
                mat.diffuseColor = [md.diffuse[0]!, md.diffuse[1]!, md.diffuse[2]!];
            }
            if (md.specular) {
                mat.specularColor = [md.specular[0]!, md.specular[1]!, md.specular[2]!];
            }
            if (md.specularPower != null) {
                mat.specularPower = md.specularPower;
            }
            if (md.emissive) {
                mat.emissiveColor = [md.emissive[0]!, md.emissive[1]!, md.emissive[2]!];
            }
            if (md.ambient) {
                mat.ambientColor = [md.ambient[0]! * sceneAmbient[0], md.ambient[1]! * sceneAmbient[1], md.ambient[2]! * sceneAmbient[2]];
            }
            if (md.alpha != null) {
                mat.alpha = md.alpha;
            }
            if (md.alphaCutOff != null) {
                mat.alphaCutOff = md.alphaCutOff;
            }
            if (md.backFaceCulling === false) {
                mat.backFaceCulling = false;
            }

            if (opts.loadTextures !== false) {
                for (const slot of TEX_SLOTS) {
                    const t = md[slot.src];
                    if (!t) {
                        continue;
                    }
                    if (slot.skipIf?.(t)) {
                        continue;
                    }
                    if (slot.level && t.level != null) {
                        (mat as unknown as Record<string, unknown>)[slot.level] = t.level;
                    }
                    if (slot.coordIndex) {
                        if (slot.coordIndex.only1) {
                            if (t.coordinatesIndex === 1) {
                                (mat as unknown as Record<string, unknown>)[slot.coordIndex.dst] = 1;
                            }
                        } else if (t.coordinatesIndex != null) {
                            (mat as unknown as Record<string, unknown>)[slot.coordIndex.dst] = t.coordinatesIndex === 1 ? 1 : 0;
                        }
                    }
                    slot.extra?.(t, mat);
                    const texUrl = baseUrl + t.name;
                    const dst = slot.dst;
                    texturePromises.push(
                        loadTexture2D(engine, texUrl).then((tex) => {
                            (mat as unknown as Record<string, unknown>)[dst] = tex;
                        })
                    );
                }
            }

            if (md.reflectionTexture && opts.loadTextures !== false && md.reflectionTexture.isCube) {
                if (md.reflectionTexture.level != null) {
                    mat.reflectionLevel = md.reflectionTexture.level;
                }
                const cubeName = md.reflectionTexture.name;
                texturePromises.push(
                    import("../texture/cube-texture.js").then(({ loadCubeTexture }) =>
                        loadCubeTexture(engine as EngineContext, baseUrl + cubeName).then((cube) => {
                            mat.reflectionCubeTexture = cube;
                        })
                    )
                );
            }

            materialMap.set(md.id, mat);
        }
    }

    await Promise.all(texturePromises);

    // Multi-material map: multiMat ID → array of sub-material IDs
    const multiMatMap = new Map<string, string[]>();
    if (data.multiMaterials) {
        for (const mm of data.multiMaterials) {
            multiMatMap.set(mm.id, mm.materials);
        }
    }

    // Lights (point lights only — dynamically imported)
    const lights: LightBase[] = [];
    if (data.lights?.length) {
        const { createPointLight } = await import("../light/point-light.js");
        for (const ld of data.lights) {
            if (ld.type === 0 && ld.position) {
                const pl = createPointLight([ld.position[0]!, ld.position[1]!, ld.position[2]!], ld.intensity ?? 1);
                if (ld.diffuse) {
                    pl.diffuse = [ld.diffuse[0]!, ld.diffuse[1]!, ld.diffuse[2]!];
                }
                if (ld.specular) {
                    pl.specular = [ld.specular[0]!, ld.specular[1]!, ld.specular[2]!];
                }
                if (ld.range != null) {
                    pl.range = ld.range;
                }
                const { excludedMeshesIds: ex, includedOnlyMeshesIds: io } = ld;
                if (ex?.length) {
                    pl.excludedMeshIds = new Set(ex);
                }
                if (io?.length) {
                    pl.includedOnlyMeshIds = new Set(io);
                }
                lights.push(pl);
            }
        }
    }

    // Meshes — each carries its own TRS; parentId links are used for world-matrix chaining.
    const allMeshes: Mesh[] = [];
    const nodeMap = new Map<string, Mesh | TransformNode>();
    const meshesByNodeId = new Map<string, Mesh[]>();
    const childNodeIds = new Set<string>();
    if (data.meshes) {
        const maxMeshes = opts.maxMeshes ?? Infinity;
        let meshCount = 0;

        // Dynamically load localMatrix baking only when the scene needs it
        const hasAnyLocalMatrix = data.meshes.some((m) => m.localMatrix);
        const bakeLocalMatrix = hasAnyLocalMatrix ? (await import("./bake-local-matrix.js")).bakeLocalMatrix : null;

        // First pass: create Mesh(es) for geometry nodes; TransformNode for pure containers.
        for (const md of data.meshes) {
            if (meshCount >= maxMeshes) {
                break;
            }
            if (md.isVisible === false) {
                continue;
            }

            if (md.positions && md.normals && md.indices && md.indices.length > 0) {
                const positions = new F32(md.positions);
                const normals = new F32(md.normals);
                const allIndices = new U32(md.indices);
                const uvs = md.uvs ? new F32(md.uvs) : undefined;
                const uvs2 = md.uvs2 ? new F32(md.uvs2) : undefined;

                // Bake localMatrix (pivot) into vertex data when present
                if (md.localMatrix && bakeLocalMatrix) {
                    bakeLocalMatrix(positions, normals, md.localMatrix);
                }

                let matIds: string[] | null = null;
                if (md.materialId) {
                    const multi = multiMatMap.get(md.materialId);
                    matIds = multi ?? [md.materialId];
                }

                const subMeshes = md.subMeshes ?? [
                    {
                        materialIndex: 0,
                        verticesStart: 0,
                        verticesCount: positions.length / 3,
                        indexStart: 0,
                        indexCount: allIndices.length,
                    },
                ];

                let firstMesh: Mesh | null = null;
                for (const sub of subMeshes) {
                    if (sub.indexCount === 0) {
                        continue;
                    }

                    const subIndices = allIndices.slice(sub.indexStart, sub.indexStart + sub.indexCount);
                    const gpu = uploadMeshToGPU(engine as EngineContext, positions, normals, subIndices, uvs, uvs2);

                    let mat: StandardMaterialProps;
                    if (matIds && sub.materialIndex < matIds.length) {
                        mat = materialMap.get(matIds[sub.materialIndex]!) ?? createStandardMaterial();
                    } else if (matIds && matIds.length === 1) {
                        mat = materialMap.get(matIds[0]!) ?? createStandardMaterial();
                    } else {
                        mat = createStandardMaterial();
                    }

                    const mesh = {
                        name: md.name + (subMeshes.length > 1 ? `_sub${sub.materialIndex}` : ""),
                        id: md.id,
                        material: mat,
                        receiveShadows: false,
                        _gpu: gpu,
                    } as unknown as Mesh;

                    mesh._cpuPositions = positions;
                    mesh._cpuNormals = normals;
                    mesh._cpuUvs = uvs;
                    mesh._cpuIndices = subIndices;

                    // Each mesh carries its own TRS from the node.
                    initMeshTransform(
                        mesh,
                        md.position?.[0] ?? 0,
                        md.position?.[1] ?? 0,
                        md.position?.[2] ?? 0,
                        md.rotation?.[0] ?? 0,
                        md.rotation?.[1] ?? 0,
                        md.rotation?.[2] ?? 0,
                        md.scaling?.[0] ?? 1,
                        md.scaling?.[1] ?? 1,
                        md.scaling?.[2] ?? 1
                    );

                    allMeshes.push(mesh as unknown as Mesh);
                    if (!meshesByNodeId.has(md.id)) {
                        meshesByNodeId.set(md.id, []);
                    }
                    meshesByNodeId.get(md.id)!.push(mesh as unknown as Mesh);
                    if (firstMesh === null) {
                        firstMesh = mesh as unknown as Mesh;
                    }
                    meshCount++;
                }

                if (firstMesh !== null) {
                    nodeMap.set(md.id, firstMesh);
                }
            } else {
                // Container node (no geometry) — TransformNode used only for parent linking.
                const rx = md.rotation?.[0] ?? 0,
                    ry = md.rotation?.[1] ?? 0,
                    rz = md.rotation?.[2] ?? 0;
                const cx = Math.cos(rx * 0.5),
                    sx_ = Math.sin(rx * 0.5);
                const cy = Math.cos(ry * 0.5),
                    sy_ = Math.sin(ry * 0.5);
                const cz = Math.cos(rz * 0.5),
                    sz_ = Math.sin(rz * 0.5);
                const qx = sx_ * cy * cz + cx * sy_ * sz_;
                const qy = cx * sy_ * cz - sx_ * cy * sz_;
                const qz = cx * cy * sz_ + sx_ * sy_ * cz;
                const qw = cx * cy * cz - sx_ * sy_ * sz_;
                const tn = createTransformNode(
                    md.name,
                    md.position?.[0] ?? 0,
                    md.position?.[1] ?? 0,
                    md.position?.[2] ?? 0,
                    qx,
                    qy,
                    qz,
                    qw,
                    md.scaling?.[0] ?? 1,
                    md.scaling?.[1] ?? 1,
                    md.scaling?.[2] ?? 1
                );
                nodeMap.set(md.id, tn);
            }
        }

        // Second pass: wire parent links and children so world matrices chain correctly.
        for (const md of data.meshes) {
            if (md.isVisible === false || !md.parentId) {
                continue;
            }
            const parent = nodeMap.get(md.parentId);
            if (!parent) {
                continue;
            }
            childNodeIds.add(md.id);
            // Wire all mesh submeshes belonging to this node to the parent
            const childMeshes = meshesByNodeId.get(md.id) ?? [];
            for (const child of childMeshes) {
                child.parent = parent;
                (parent as unknown as { children: SceneNode[] }).children.push(child);
            }
            // Wire TransformNode children (container nodes with no geometry)
            if (childMeshes.length === 0) {
                const childNode = nodeMap.get(md.id);
                if (childNode) {
                    childNode.parent = parent;
                    (parent as unknown as { children: SceneNode[] }).children.push(childNode);
                }
            }
        }
    }

    // Parse camera (dynamically imported — zero cost when loadCamera=false or no cameras in file)
    const camData =
        opts.loadCamera !== false && data.cameras?.length ? ((data.activeCameraID ? data.cameras.find((c) => c.id === data.activeCameraID) : null) ?? data.cameras[0]!) : null;
    const camera = camData ? (await import("./parse-camera.js")).parseBabylonCamera(camData) : undefined;

    // Return AssetContainer — addToScene() handles entity registration, clearColor, and cleanup.
    // Only root entities (not children of any other node) are included; addToScene() recurses.
    const rootMeshes = allMeshes.filter((m) => !childNodeIds.has(m.id!));
    const rootTransformNodes: TransformNode[] = [];
    for (const [id, node] of nodeMap) {
        if (!childNodeIds.has(id) && !meshesByNodeId.has(id)) {
            rootTransformNodes.push(node as TransformNode);
        }
    }
    return { entities: [...lights, ...rootMeshes, ...rootTransformNodes], clearColor, camera };
}
