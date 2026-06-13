import type { SceneNode } from "./scene/scene-node.js";
import type { LightBase } from "./light/types.js";
import type { AnimationGroup } from "./animation/animation-group.js";
import type { MaterialVariantData } from "./loader-gltf/material-variants.js";
import type { Mesh } from "./mesh/mesh.js";

/**
 * Result returned by loadGltf / loadBabylon.
 * Pass directly to addToScene() — it handles all fields automatically.
 *
 * - glTF: entities = [root TransformNode], animationGroups = loaded clips
 * - .babylon: entities = root SceneNodes (Mesh/TransformNode) + LightBase, clearColor from file
 */
export interface AssetContainer {
    /** Scene entities. glTF: [root TransformNode]. .babylon: root nodes + lights. */
    entities: Array<SceneNode | LightBase>;
    /** Animation groups from the file. addToScene() registers them with the scene-owned AnimationManager by default. */
    animationGroups?: AnimationGroup[];
    /** Scene background color declared in the file. addToScene() applies it to scene.clearColor. */
    clearColor?: GPUColorDict;
    /** Camera parsed from the file. addToScene() sets it as scene.camera when present. */
    camera?: import("./camera/camera.js").Camera;
    /** KHR_materials_variants data. Use selectVariant() / getVariantNames() to interact. */
    materialVariants?: MaterialVariantData;
    /** KHR_xmp_json_ld metadata. `packets` are the JSON-LD packets declared at the
     *  document level; `assetPacket` is the packet referenced by `asset` (if any). */
    xmpMetadata?: { packets: unknown[]; assetPacket?: unknown };
}

/**
 * Flatten a loaded asset container's entity tree to its renderable `Mesh` nodes
 * (those carrying GPU geometry), matching the flat `meshes` array Babylon.js
 * loaders return. Useful for camera-framing and per-mesh inspection after a load.
 *
 * Tree-shakeable: only callers that import this pull it into their bundle.
 */
export function getContainerMeshes(container: AssetContainer): Mesh[] {
    const meshes: Mesh[] = [];
    const seen = new Set<unknown>();
    const visit = (node: SceneNode): void => {
        if (seen.has(node)) {
            return;
        }
        seen.add(node);
        if ((node as unknown as { _gpu?: unknown })._gpu) {
            meshes.push(node as unknown as Mesh);
        }
        const children = (node as unknown as { children?: SceneNode[] }).children;
        if (children) {
            for (const child of children) {
                visit(child);
            }
        }
    };
    for (const entity of container.entities) {
        // Lights have no scene-graph children to walk; skip them.
        if ("lightType" in (entity as object)) {
            continue;
        }
        visit(entity as SceneNode);
    }
    return meshes;
}
