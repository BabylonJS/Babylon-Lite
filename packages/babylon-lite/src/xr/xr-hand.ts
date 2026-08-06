/**
 * WebXR hand tracking — joint-sphere visuals rendered at each tracked hand's 25
 * skeleton joints, ported in spirit from Babylon.js `WebXRHandTracking` (its
 * default "dot" hand visual). Each joint is a small lit sphere positioned and
 * sized (from the joint's reported radius) every frame from `frame.getJointPose`.
 *
 * Structure mirrors {@link XrPointer} / {@link XrControllerModels}: a per-DOM-source
 * unit map, meshes created on first sight of a joint and disposed on disconnect,
 * hidden while a joint is untracked. Pure data + free functions (pillar 4b);
 * nothing runs unless the app imports and drives it.
 *
 * The feature declares the native `hand-tracking` session feature (folded into the
 * session's `optionalFeatures` by {@link enterXr}); on a device without hand support
 * no source ever exposes `.hand`, so the feature is a graceful no-op. Hands still act
 * as ordinary input sources (index-finger target ray + pinch `select`), so
 * {@link pointerSelection} keeps working on them independently of this visual.
 */

import type { EngineContext } from "../engine/engine.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneContext } from "../scene/scene.js";
import type { XrInputManager } from "./xr-input.js";
import type { XrFeatureSpec } from "./xr-feature.js";
import type { XrHandedness } from "./xr-support.js";
import { createSphere } from "../mesh/mesh-factories.js";
import { createStandardMaterial } from "../material/standard/create-standard-material.js";
import { addToScene } from "../scene/scene-core.js";
import { removeFromScene } from "../scene/scene-remove.js";
import { disposeMeshGpu } from "../mesh/mesh-dispose.js";
import { setSubtreeVisible } from "../scene/visibility.js";

// `@types/webxr` names the DOM source interface `XRInputSource`; alias it so the
// unit map can key on the stable DOM object rather than our per-frame wrapper.
type DomXrInputSource = XRInputSource;

/** Builds the mesh drawn for one hand joint. It should be a ~1 m-diameter unit mesh
 *  centred on the origin; the feature scales it per frame to the joint's real radius. */
export type XrHandJointMeshFactory = (engine: EngineContext, scene: SceneContext, handedness: XrHandedness) => Mesh;

/** Options for {@link handTracking} / {@link createXrHandTracking}. */
export interface XrHandTrackingOptions {
    /** Diffuse colour of the default joint spheres. Defaults to a light blue-white. */
    jointColor?: readonly [number, number, number];
    /** Custom per-joint mesh builder (see {@link XrHandJointMeshFactory}). Defaults to a
     *  low-poly lit sphere. The returned mesh is scaled to the joint radius each frame. */
    jointMeshFactory?: XrHandJointMeshFactory;
    /** Multiplier on each joint's reported radius, to fatten/thin the dots. Default `1`. */
    jointScale?: number;
}

/** @internal Default joint-sphere tint (Babylon.js hand-dot look). */
const DEFAULT_JOINT_COLOR: [number, number, number] = [0.7, 0.78, 0.95];
/** @internal Fallback world radius (m) when a joint pose omits `radius`. */
const FALLBACK_RADIUS = 0.008;

/** @internal Per-hand visual: one sphere per joint, created lazily as joints appear. */
interface HandUnit {
    handedness: XrHandedness;
    /** Joint name → its sphere mesh. */
    joints: Map<XRHandJoint, Mesh>;
}

/** A hand-tracking manager. Create with {@link createXrHandTracking}, drive with
 *  {@link updateXrHandTracking} each XR frame, release with {@link disposeXrHandTracking}. */
export interface XrHandTracking {
    /** @internal */
    _engine: EngineContext;
    /** @internal */
    _scene: SceneContext;
    /** @internal */
    _factory: XrHandJointMeshFactory;
    /** @internal */
    _jointScale: number;
    /** @internal Visuals per DOM input source that exposes a hand. */
    _units: Map<DomXrInputSource, HandUnit>;
}

/** @internal Default joint mesh: a small low-poly lit sphere (unit diameter, scaled
 *  to the joint radius each frame). */
function makeDefaultFactory(color: readonly [number, number, number]): XrHandJointMeshFactory {
    return (engine: EngineContext, _scene: SceneContext, handedness: XrHandedness): Mesh => {
        const mesh = createSphere(engine, { diameter: 1, segments: 8 });
        mesh.name = `xr-hand-${handedness}-joint`;
        const mat = createStandardMaterial();
        mat.diffuseColor = [color[0], color[1], color[2]];
        mesh.material = mat as unknown as Mesh["material"];
        mesh.pickable = false;
        mesh.receiveShadows = false;
        mesh.visible = false;
        return mesh;
    };
}

/** Create a hand-tracking manager bound to a scene. */
export function createXrHandTracking(engine: EngineContext, scene: SceneContext, options: XrHandTrackingOptions = {}): XrHandTracking {
    return {
        _engine: engine,
        _scene: scene,
        _factory: options.jointMeshFactory ?? makeDefaultFactory(options.jointColor ?? DEFAULT_JOINT_COLOR),
        _jointScale: options.jointScale ?? 1,
        _units: new Map(),
    };
}

/** @internal Lazily create the per-hand unit. */
function ensureUnit(handTracking: XrHandTracking, source: DomXrInputSource, handedness: XrHandedness): HandUnit {
    const existing = handTracking._units.get(source);
    if (existing) {
        return existing;
    }
    const unit: HandUnit = { handedness, joints: new Map() };
    handTracking._units.set(source, unit);
    return unit;
}

/** @internal Lazily create the sphere for one joint. */
function ensureJoint(handTracking: XrHandTracking, unit: HandUnit, joint: XRHandJoint): Mesh {
    const existing = unit.joints.get(joint);
    if (existing) {
        return existing;
    }
    const mesh = handTracking._factory(handTracking._engine, handTracking._scene, unit.handedness);
    mesh.name = `xr-hand-${unit.handedness}-${joint}`;
    addToScene(handTracking._scene, mesh);
    unit.joints.set(joint, mesh);
    return mesh;
}

/** @internal Dispose one hand's joint spheres and remove them from the scene. */
function disposeUnit(handTracking: XrHandTracking, unit: HandUnit): void {
    for (const mesh of unit.joints.values()) {
        removeFromScene(handTracking._scene, mesh);
        disposeMeshGpu(mesh);
    }
    unit.joints.clear();
}

/**
 * Update every tracked hand's joint spheres for the current frame: for each input
 * source that exposes an {@link XRHand}, place and size a sphere at each joint from
 * `frame.getJointPose`, hiding joints (or whole hands) that aren't tracked this
 * frame. Call once per XR frame after {@link updateXrInputPoses}.
 */
export function updateXrHandTracking(handTracking: XrHandTracking, input: XrInputManager, frame: XRFrame, referenceSpace: XRReferenceSpace): void {
    const seen = new Set<DomXrInputSource>();
    // `getJointPose` is optional in the WebXR API (only present with hand-tracking);
    // bail out cleanly on devices/sessions that lack it.
    const getJointPose = frame.getJointPose;

    for (const src of input.inputSources) {
        const hand = src.source.hand;
        if (!hand) {
            continue;
        }
        seen.add(src.source);
        const unit = ensureUnit(handTracking, src.source, src.handedness);

        if (!getJointPose) {
            continue;
        }
        for (const [jointName, jointSpace] of hand) {
            const mesh = ensureJoint(handTracking, unit, jointName);
            const pose = getJointPose.call(frame, jointSpace, referenceSpace);
            if (!pose) {
                setSubtreeVisible(mesh, false);
                continue;
            }
            const p = pose.transform.position;
            const o = pose.transform.orientation;
            const d = (pose.radius ?? FALLBACK_RADIUS) * 2 * handTracking._jointScale;
            mesh.position.set(p.x, p.y, p.z);
            mesh.rotationQuaternion.set(o.x, o.y, o.z, o.w);
            mesh.scaling.set(d, d, d);
            setSubtreeVisible(mesh, true);
        }
    }

    // Retire visuals for hands that disconnected since the last frame.
    for (const [source, unit] of handTracking._units) {
        if (!seen.has(source)) {
            disposeUnit(handTracking, unit);
            handTracking._units.delete(source);
        }
    }
}

/** Dispose all hand visuals and detach them from the scene. */
export function disposeXrHandTracking(handTracking: XrHandTracking): void {
    for (const unit of handTracking._units.values()) {
        disposeUnit(handTracking, unit);
    }
    handTracking._units.clear();
}

/**
 * Hand-tracking joint visuals as an opt-in {@link XrFeatureSpec} (Babylon.js
 * `HAND_TRACKING`). Pass it to `enterXr({ features: [handTracking(...)] })` and the
 * session renders a sphere at each tracked hand joint, tracking connect/disconnect
 * and disposing on exit — no manual `onFrame`/`onEnd` wiring.
 *
 * Requires input tracking (do not pass `input: false` to {@link enterXr}) and requests
 * the native `hand-tracking` session feature (optional — degrades to a no-op where
 * unsupported).
 *
 * @param options - Joint appearance (see {@link XrHandTrackingOptions}).
 */
export function handTracking(options: XrHandTrackingOptions = {}): XrFeatureSpec {
    return {
        sessionFeatures: ["hand-tracking"],
        create(ctx) {
            if (!ctx.input) {
                throw new Error("handTracking requires XR input tracking; do not pass input:false to enterXr.");
            }
            const input = ctx.input;
            const referenceSpace = ctx.referenceSpace;
            const tracking = createXrHandTracking(ctx.engine, ctx.scene, options);
            return {
                update(frame): void {
                    updateXrHandTracking(tracking, input, frame, referenceSpace);
                },
                dispose(): void {
                    disposeXrHandTracking(tracking);
                },
            };
        },
    };
}
