import type { SceneNode } from "./scene/scene-node.js";
import type { LightBase } from "./light/types.js";
import type { AnimationGroup } from "./animation/animation-group.js";
import type { MaterialVariantData } from "./loader-gltf/material-variants.js";
import type { Mesh } from "./mesh/mesh.js";
import type { GaussianSplattingMesh } from "./mesh/GaussianSplatting/gaussian-splatting-mesh.js";
import type { Skeleton } from "./skeleton/bone-control.js";
import type { SceneContext } from "./scene/scene-core.js";

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
    /** Cameras imported after `enableGltfCameras()` is called, in node-encounter order.
     *  Each is parented to its source node, so it inherits that node's animation and
     *  hierarchy live. Unlike `camera`, addToScene() never auto-activates one — pick one
     *  explicitly and assign it to `scene.camera`. */
    cameras?: import("./camera/camera.js").Camera[];
    /** KHR_materials_variants data. Use selectVariant() / getVariantNames() to interact. */
    materialVariants?: MaterialVariantData;
    /** KHR_xmp_json_ld metadata. `packets` are the JSON-LD packets declared at the
     *  document level; `assetPacket` is the packet referenced by `asset` (if any). */
    xmpMetadata?: { packets: unknown[]; assetPacket?: unknown };
    /** Bone-control handles, one per glTF skin. Present only when
     *  `enableBoneControl()` was called before loading; otherwise `undefined`.
     *  Drive bones via `getBoneByName()` + the `setBone*` functions. */
    skeletons?: Skeleton[];
    /** @internal Per-frame animation tick closure pushed onto `scene._beforeRender` by
     *  `addToScene(scene, container)`. Stored so `removeFromScene(scene, container)` can
     *  splice it back out, keeping the two calls symmetric. */
    _beforeRenderHook?: (deltaMs: number) => void;
    /** Deferred scene-wiring hook contributed by a loader feature that needs the
     *  target `SceneContext` (which the loader itself never sees). `addToScene()`
     *  invokes it once, synchronously, while processing the container. Used by
     *  `EXT_lights_image_based` to install its image-based-light environment
     *  (spherical harmonics + specular cubemap) onto the scene. Lazy features own
     *  the closure so the core loader/scene stay feature-agnostic.
     *  @internal */
    _sceneSetup?: (scene: SceneContext) => void;
    /** Gaussian Splatting renderables contributed by the `KHR_gaussian_splatting`
     *  loader feature, one promise per GS primitive. The promises are populated by
     *  `_sceneSetup` (i.e. during `addToScene`); each resolves to the attached
     *  {@link GaussianSplattingMesh}. Await `mesh.firstSortReady` to know when the
     *  first depth sort has landed. `undefined` for assets without GS primitives.
     *  @internal */
    _gaussianSplats?: Promise<GaussianSplattingMesh>[];
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
