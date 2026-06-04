import type { SceneNode } from "./scene/scene-node.js";
import type { LightBase } from "./light/types.js";
import type { AnimationGroup } from "./animation/animation-group.js";
import type { MaterialVariantData } from "./loader-gltf/material-variants.js";

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
