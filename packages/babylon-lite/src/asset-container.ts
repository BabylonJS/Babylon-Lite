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
    /** Animation groups from the file. addToScene() registers their per-frame tick automatically. */
    animationGroups?: AnimationGroup[];
    /** Scene background color declared in the file. addToScene() applies it to scene.clearColor. */
    clearColor?: GPUColorDict;
    /** Camera parsed from the file. addToScene() sets it as scene.camera when present. */
    camera?: import("./camera/camera.js").Camera;
    /** KHR_materials_variants data. Use selectVariant() / getVariantNames() to interact. */
    materialVariants?: MaterialVariantData;
}
