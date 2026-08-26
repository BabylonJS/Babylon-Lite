/**
 * WebXR hand tracking — by default a solid **rigged hand mesh** (Babylon.js's
 * `r_hand_rhs.glb` / `l_hand_rhs.glb`, skinned to the 25 tracked joints), falling
 * back to per-joint **spheres** while the mesh loads, if it can't be loaded, or when
 * `handMeshes: false`. Ported in spirit from Babylon.js `WebXRHandTracking`.
 *
 * Structure mirrors {@link XrPointer} / {@link XrControllerModels}: a per-DOM-source
 * unit map, visuals created lazily and disposed on disconnect. The rigged-mesh loader
 * (`xr-hand-mesh`) is **dynamic-imported** only when hand meshes are enabled,
 * so the sphere-only path carries none of the glTF-loader / bone-control weight. Pure
 * data + free functions (pillar 4b); nothing runs unless the app imports and drives it.
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
import { setXrPoseToLeftHanded } from "./xr-coordinates.js";
import type { XrFeatureSpec } from "./xr-feature.js";
import type { XrHandedness } from "./xr-support.js";
import type { HandMeshOptions, LoadedHandMesh } from "./xr-hand-mesh.js";
import { createSphere } from "../mesh/mesh-factories.js";
import { createStandardMaterial } from "../material/standard/create-standard-material.js";
import { addToScene } from "../scene/scene-core.js";
import { removeFromScene } from "../scene/scene-remove.js";
import { disposeMeshGpu } from "../mesh/mesh-dispose.js";
import { setSubtreeVisible } from "../scene/visibility.js";

// `@types/webxr` names the DOM source interface `XRInputSource`; alias it so the
// unit map can key on the stable DOM object rather than our per-frame wrapper.
type DomXrInputSource = XRInputSource;

/** @internal The lazily dynamic-imported hand-mesh module surface. */
/** @internal The subset of the lazily dynamic-imported hand-mesh module we use.
 *  Written as an explicit interface rather than `typeof import(...)` because api-extractor
 *  cannot resolve a whole-module (`SourceFile`) import-type node. */
interface HandMeshModule {
    loadHandMesh: (engine: EngineContext, scene: SceneContext, handedness: XrHandedness, opts: HandMeshOptions) => Promise<LoadedHandMesh | null>;
    disposeHandMesh: (scene: SceneContext, loaded: LoadedHandMesh) => void;
    poseHandMesh: (loaded: LoadedHandMesh, hand: XRHand, frame: XRFrame, referenceSpace: XRReferenceSpace) => boolean;
}

/** Builds the mesh drawn for one hand joint. It should be a ~1 m-diameter unit mesh
 *  centred on the origin; the feature scales it per frame to the joint's real radius. */
export type XrHandJointMeshFactory = (engine: EngineContext, scene: SceneContext, handedness: XrHandedness) => Mesh;

/** Options for {@link handTracking} / {@link createXrHandTracking}. */
export interface XrHandTrackingOptions {
    /** Load Babylon.js's rigged hand mesh (skinned to the joints) instead of only the
     *  joint spheres. Default `true`. The spheres still show while the mesh loads and if
     *  it can't be loaded. Set `false` for the lightweight dots-only visual. */
    handMeshes?: boolean;
    /** Base URL the hand GLBs are fetched from (must end in `/`). Defaults to Babylon's CDN. */
    handMeshBaseUrl?: string;
    /** Left-hand GLB filename. Default `l_hand_rhs.glb`. */
    handMeshLeftFilename?: string;
    /** Right-hand GLB filename. Default `r_hand_rhs.glb`. */
    handMeshRightFilename?: string;
    /** Hand-mesh diffuse tint. Default Babylon's hand purple. */
    handColor?: readonly [number, number, number];
    /** Hand-mesh alpha (`< 1` = translucent). Default `1` (opaque). A translucent hand
     *  shows its own far fingers through the near ones (nearer fragments can't occlude
     *  farther ones once alpha blending disables depth writes), so the default is solid. */
    handAlpha?: number;
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
/** @internal Default hand-mesh tint (Babylon's `base` hand colour rgb(116,63,203)). */
const DEFAULT_HAND_COLOR: [number, number, number] = [0.455, 0.247, 0.796];
/** @internal Fallback world radius (m) when a joint pose omits `radius`. */
const FALLBACK_RADIUS = 0.008;
/** @internal Babylon's default hand-mesh CDN base + filenames. */
const DEFAULT_HAND_BASE_URL = "https://assets.babylonjs.com/core/HandMeshes/";
const DEFAULT_HAND_RIGHT = "r_hand_rhs.glb";
const DEFAULT_HAND_LEFT = "l_hand_rhs.glb";

/** @internal Per-hand visual: joint spheres (placeholder/fallback) + optional rigged mesh. */
interface HandUnit {
    handedness: XrHandedness;
    /** Joint name → its sphere mesh. */
    joints: Map<XRHandJoint, Mesh>;
    /** The loaded rigged hand mesh, once ready (spheres are retired when it lands). */
    mesh: LoadedHandMesh | null;
    /** True once the async mesh load has been kicked off for this hand. */
    meshLoadStarted: boolean;
    /** True once the source disconnected, so an in-flight load disposes on arrival. */
    retired: boolean;
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
    /** @internal Whether to load the rigged hand mesh. */
    _handMeshes: boolean;
    /** @internal Resolved hand-mesh load options. */
    _handMeshOpts: HandMeshOptions;
    /** @internal Dynamic-imported hand-mesh module, once loaded. */
    _mod: HandMeshModule | null;
    /** @internal True while the hand-mesh module import is in flight. */
    _modLoading: boolean;
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
        _handMeshes: options.handMeshes ?? true,
        _handMeshOpts: {
            baseUrl: options.handMeshBaseUrl ?? DEFAULT_HAND_BASE_URL,
            leftFilename: options.handMeshLeftFilename ?? DEFAULT_HAND_LEFT,
            rightFilename: options.handMeshRightFilename ?? DEFAULT_HAND_RIGHT,
            color: options.handColor ?? DEFAULT_HAND_COLOR,
            alpha: options.handAlpha ?? 1,
        },
        _mod: null,
        _modLoading: false,
        _units: new Map(),
    };
}

/** @internal Kick off the one-time dynamic import of the hand-mesh loader. */
function ensureModule(handTracking: XrHandTracking): void {
    if (handTracking._mod || handTracking._modLoading || !handTracking._handMeshes) {
        return;
    }
    handTracking._modLoading = true;
    void import("./xr-hand-mesh.js")
        .then((m) => {
            handTracking._mod = m;
        })
        .catch(() => {
            // Loader unavailable → stay on the joint spheres.
            handTracking._handMeshes = false;
        });
}

/** @internal Begin loading a hand's rigged mesh (once). On success the joint spheres
 *  are retired and the mesh becomes the active visual. */
function startMeshLoad(handTracking: XrHandTracking, unit: HandUnit): void {
    const mod = handTracking._mod;
    if (!mod || unit.meshLoadStarted) {
        return;
    }
    unit.meshLoadStarted = true;
    void (async () => {
        try {
            const loaded = await mod.loadHandMesh(handTracking._engine, handTracking._scene, unit.handedness, handTracking._handMeshOpts);
            if (!loaded) {
                return; // no skeleton → keep spheres
            }
            if (unit.retired) {
                mod.disposeHandMesh(handTracking._scene, loaded);
                return;
            }
            unit.mesh = loaded;
            disposeSpheres(handTracking, unit); // retire the placeholder dots
        } catch {
            // Keep the joint spheres on any failure.
        }
    })();
}

/** @internal Lazily create the per-hand unit. */
function ensureUnit(handTracking: XrHandTracking, source: DomXrInputSource, handedness: XrHandedness): HandUnit {
    const existing = handTracking._units.get(source);
    if (existing) {
        return existing;
    }
    const unit: HandUnit = { handedness, joints: new Map(), mesh: null, meshLoadStarted: false, retired: false };
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

/** @internal Dispose one hand's joint spheres (kept separate so the mesh load can retire
 *  them without touching the rigged mesh). */
function disposeSpheres(handTracking: XrHandTracking, unit: HandUnit): void {
    for (const mesh of unit.joints.values()) {
        removeFromScene(handTracking._scene, mesh);
        disposeMeshGpu(mesh);
    }
    unit.joints.clear();
}

/** @internal Dispose one hand's visuals (spheres + rigged mesh) and detach from the scene. */
function disposeUnit(handTracking: XrHandTracking, unit: HandUnit): void {
    unit.retired = true;
    disposeSpheres(handTracking, unit);
    if (unit.mesh && handTracking._mod) {
        handTracking._mod.disposeHandMesh(handTracking._scene, unit.mesh);
        unit.mesh = null;
    }
}

/**
 * Update every tracked hand for the current frame. For each input source that exposes
 * an {@link XRHand}: pose its rigged mesh from the joint poses when loaded, otherwise
 * place + size a sphere at each joint from `frame.getJointPose` (also the placeholder
 * while the mesh loads). Hides joints/hands not tracked this frame. Call once per XR
 * frame after {@link updateXrInputPoses}.
 */
export function updateXrHandTracking(handTracking: XrHandTracking, input: XrInputManager, frame: XRFrame, referenceSpace: XRReferenceSpace): void {
    const seen = new Set<DomXrInputSource>();
    // `getJointPose` is optional in the WebXR API (only present with hand-tracking);
    // bail out cleanly on devices/sessions that lack it.
    const getJointPose = frame.getJointPose;

    if (handTracking._handMeshes) {
        ensureModule(handTracking);
    }

    for (const src of input.inputSources) {
        const hand = src.source.hand;
        if (!hand) {
            continue;
        }
        seen.add(src.source);
        const unit = ensureUnit(handTracking, src.source, src.handedness);

        // Rigged-mesh path: kick off the load once the module is ready, and pose the
        // mesh each frame once it lands (spheres have been retired by then).
        if (handTracking._handMeshes) {
            if (!unit.mesh) {
                startMeshLoad(handTracking, unit);
            }
            if (unit.mesh) {
                handTracking._mod!.poseHandMesh(unit.mesh, hand, frame, referenceSpace);
                continue;
            }
        }

        // Joint-sphere path (dots-only, or the placeholder while the mesh loads).
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
            const d = (pose.radius ?? FALLBACK_RADIUS) * 2 * handTracking._jointScale;
            setXrPoseToLeftHanded(mesh, pose.transform);
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
 * Hand-tracking visuals as an opt-in {@link XrFeatureSpec} (Babylon.js `HAND_TRACKING`).
 * Pass it to `enterXr({ features: [handTracking(...)] })` and the session renders each
 * tracked hand — a rigged hand mesh by default, joint spheres while it loads or when
 * `handMeshes:false` — tracking connect/disconnect and disposing on exit (no manual
 * `onFrame`/`onEnd` wiring).
 *
 * Requires input tracking (do not pass `input: false` to {@link enterXr}) and requests
 * the native `hand-tracking` session feature (optional — degrades to a no-op where
 * unsupported).
 *
 * @param options - Appearance + mesh options (see {@link XrHandTrackingOptions}).
 */
export function handTracking(options: XrHandTrackingOptions = {}): XrFeatureSpec {
    return {
        sessionFeatures: ["hand-tracking"],
        create(ctx) {
            if (!ctx.input) {
                throw new Error("handTracking requires XR input tracking; do not pass input:false to enterXr.");
            }
            const input = ctx.input;
            const tracking = createXrHandTracking(ctx.engine, ctx.scene, options);
            return {
                update(frame): void {
                    // Read the reference space fresh each frame — teleportation swaps it.
                    updateXrHandTracking(tracking, input, frame, ctx.referenceSpace);
                },
                dispose(): void {
                    disposeXrHandTracking(tracking);
                },
            };
        },
    };
}
