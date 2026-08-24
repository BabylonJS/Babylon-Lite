/**
 * WebXR articulated hand MESH — loads Babylon.js's rigged hand glTF and drives its
 * 25-bone skeleton from the live joint poses, giving a solid skinned hand instead of
 * the default joint dots. Ported in spirit from Babylon.js `WebXRHandTracking`'s
 * default hand-mesh path (`r_hand_rhs.glb` / `l_hand_rhs.glb`).
 *
 * This module is **dynamic-imported** by `xr-hand` only when hand meshes
 * are enabled, so the base (joint-sphere) hand-tracking path stays free of the glTF
 * loader + bone-control weight. It is otherwise side-effect-free (pillar 4b): a plain
 * rig-name table plus free functions; `enableBoneControl()` runs lazily inside
 * {@link loadHandMesh}, never at module load.
 *
 * Babylon's default rig is FLAT — all 25 joint bones parent directly to the skeleton
 * root. Each joint is driven from its absolute, converted Lite world pose so the glTF
 * root's handedness transform is not applied a second time.
 */

import type { EngineContext } from "../engine/engine.js";
import type { SceneContext } from "../scene/scene.js";
import type { SceneNode } from "../scene/scene-node.js";
import type { AssetContainer } from "../asset-container.js";
import type { Mesh } from "../mesh/mesh.js";
import type { Skeleton, Bone } from "../skeleton/bone-control.js";
import type { XrHandedness } from "./xr-support.js";
import { loadGltf } from "../loader-gltf/load-gltf.js";
import { enableBoneControl, getBoneByName, setBoneWorldPoseDeferred, bakeSkeleton } from "../skeleton/bone-control.js";
import { getContainerMeshes } from "../asset-container.js";
import { createStandardMaterial } from "../material/standard/create-standard-material.js";
import { enableStandardSkeleton, whenStandardMeshFeaturesReady } from "../material/standard/enable-standard-mesh-features.js";
import { addToScene } from "../scene/scene-core.js";
import { removeFromScene } from "../scene/scene-remove.js";
import { setSubtreeVisible } from "../scene/visibility.js";

/** Where + how to load the hand glTF meshes. Resolved by `xr-hand`. */
export interface HandMeshOptions {
    /** Base URL the two hand GLBs are fetched from (must end in `/`). */
    baseUrl: string;
    /** Left-hand GLB filename. */
    leftFilename: string;
    /** Right-hand GLB filename. */
    rightFilename: string;
    /** Diffuse tint applied to the (lit) hand material. */
    color: readonly [number, number, number];
    /** Material alpha (`< 1` renders the hand translucent). */
    alpha: number;
}

/** WebXR `XRHandJoint` → default Babylon hand-rig bone base name (the handedness
 *  suffix `_R` / `_L` is appended at load). Mirrors Babylon's
 *  `_GenerateDefaultHandMeshRigMapping`. Note the WebXR "pinky" maps to `little_*`
 *  and phalanges use the `proxPhalanx` / `intPhalanx` / `distPhalanx` abbreviations. */
const RIG_BASE: Record<string, string> = {
    wrist: "wrist",
    "thumb-metacarpal": "thumb_metacarpal",
    "thumb-phalanx-proximal": "thumb_proxPhalanx",
    "thumb-phalanx-distal": "thumb_distPhalanx",
    "thumb-tip": "thumb_tip",
    "index-finger-metacarpal": "index_metacarpal",
    "index-finger-phalanx-proximal": "index_proxPhalanx",
    "index-finger-phalanx-intermediate": "index_intPhalanx",
    "index-finger-phalanx-distal": "index_distPhalanx",
    "index-finger-tip": "index_tip",
    "middle-finger-metacarpal": "middle_metacarpal",
    "middle-finger-phalanx-proximal": "middle_proxPhalanx",
    "middle-finger-phalanx-intermediate": "middle_intPhalanx",
    "middle-finger-phalanx-distal": "middle_distPhalanx",
    "middle-finger-tip": "middle_tip",
    "ring-finger-metacarpal": "ring_metacarpal",
    "ring-finger-phalanx-proximal": "ring_proxPhalanx",
    "ring-finger-phalanx-intermediate": "ring_intPhalanx",
    "ring-finger-phalanx-distal": "ring_distPhalanx",
    "ring-finger-tip": "ring_tip",
    "pinky-finger-metacarpal": "little_metacarpal",
    "pinky-finger-phalanx-proximal": "little_proxPhalanx",
    "pinky-finger-phalanx-intermediate": "little_intPhalanx",
    "pinky-finger-phalanx-distal": "little_distPhalanx",
    "pinky-finger-tip": "little_tip",
};

/** A loaded, rigged hand mesh ready to be posed each frame. */
export interface LoadedHandMesh {
    /** The loaded asset container (owner disposes it via {@link disposeHandMesh}). */
    container: AssetContainer;
    /** The container's root node — hidden until the first successful pose. */
    root: SceneNode;
    /** The hand skin's skeleton. */
    skeleton: Skeleton;
    /** WebXR joint → its rig bone (only joints whose bone was found in the GLB). */
    bones: Map<XRHandJoint, Bone>;
    /** Whether the mesh has been shown (revealed on first pose). */
    shown: boolean;
}

/**
 * Load the rigged hand glTF for one handedness and resolve its 25 rig bones. Returns
 * `null` if the model has no skeleton (bone control unavailable) — the caller then
 * keeps the joint spheres. The container is added to the scene here (hidden); the
 * caller reveals it on the first posed frame.
 */
export async function loadHandMesh(engine: EngineContext, scene: SceneContext, handedness: XrHandedness, opts: HandMeshOptions): Promise<LoadedHandMesh | null> {
    // Bone control is opt-in and must be enabled BEFORE the glTF is parsed so the
    // loader surfaces `container.skeletons`. Idempotent + process-global.
    enableBoneControl();
    // The hand GLB is skinned, so the Standard skinning ext must be registered or the mesh
    // renders frozen at bind pose (invisible / at the origin) instead of tracking the joints.
    // Enable it BEFORE the (network-bound) glTF load so its dynamic import overlaps the fetch
    // and is almost certainly registered by the time we add the mesh below. Idempotent +
    // process-global, same opt-in pattern as `enableBoneControl`.
    enableStandardSkeleton();

    const file = handedness === "right" ? opts.rightFilename : opts.leftFilename;
    const url = new URL(file, opts.baseUrl).href;
    const container = await loadGltf(engine, url);

    const skeleton = container.skeletons?.[0];
    const root = container.entities[0] as SceneNode | undefined;
    if (!skeleton || !root) {
        return null;
    }

    const suffix = handedness === "right" ? "_R" : "_L";
    const bones = new Map<XRHandJoint, Bone>();
    for (const joint of Object.keys(RIG_BASE)) {
        const bone = getBoneByName(skeleton, RIG_BASE[joint] + suffix);
        if (bone) {
            bones.set(joint as XRHandJoint, bone);
        }
    }

    // Semi-transparent tinted material (approximates Babylon's translucent hand shader,
    // which is a NodeMaterial Lite can't parse). Lit, so the hand still shades.
    const mat = createStandardMaterial();
    mat.diffuseColor = [opts.color[0], opts.color[1], opts.color[2]];
    mat.alpha = opts.alpha;
    for (const mesh of getContainerMeshes(container)) {
        mesh.material = mat as unknown as Mesh["material"];
        mesh.pickable = false;
        mesh.receiveShadows = false;
    }

    // The glTF root performs the model's right-handed→left-handed conversion. Keep it
    // intact and enable the ordinary mirrored-mesh path used by all imported glTF content.
    const { enableMirroredMeshes } = await import("../mesh/enable-mirrored-meshes.js");
    await enableMirroredMeshes(scene);

    // Guarantee the skinning ext is registered before the mesh is added: a mesh added after
    // the first frame is built through the synchronous rebuild path, which cannot import the
    // ext itself. Without this, adding the hand while controllers are already shown races the
    // ext import and the mesh renders frozen at bind pose (stuck at the origin).
    await whenStandardMeshFeaturesReady();

    addToScene(scene, container);
    setSubtreeVisible(root, false);
    return { container, root, skeleton, bones, shown: false };
}

/**
 * Pose a loaded hand mesh's skeleton from the current frame's joint poses. Each flat-rig
 * bone receives its absolute Lite world pose, then the skin is baked once. Returns
 * `true` if at least one joint was posed (so the caller can reveal the mesh).
 */
export function poseHandMesh(loaded: LoadedHandMesh, hand: XRHand, frame: XRFrame, referenceSpace: XRReferenceSpace): boolean {
    const getJointPose = frame.getJointPose;
    if (!getJointPose) {
        if (loaded.shown) {
            setSubtreeVisible(loaded.root, false);
            loaded.shown = false;
        }
        return false;
    }
    let posedAny = false;
    for (const [joint, bone] of loaded.bones) {
        const space = hand.get(joint);
        if (!space) {
            continue;
        }
        const pose = getJointPose.call(frame, space, referenceSpace);
        if (!pose) {
            continue;
        }
        const p = pose.transform.position;
        const o = pose.transform.orientation;
        setBoneWorldPoseDeferred(loaded.skeleton, bone, p.x, p.y, -p.z, o.x, o.y, -o.z, -o.w);
        posedAny = true;
    }
    if (posedAny) {
        bakeSkeleton(loaded.skeleton);
        if (!loaded.shown) {
            setSubtreeVisible(loaded.root, true);
            loaded.shown = true;
        }
    } else if (loaded.shown) {
        setSubtreeVisible(loaded.root, false);
        loaded.shown = false;
    }
    return posedAny;
}

/** Detach + free a loaded hand mesh. */
export function disposeHandMesh(scene: SceneContext, loaded: LoadedHandMesh): void {
    removeFromScene(scene, loaded.container);
}
