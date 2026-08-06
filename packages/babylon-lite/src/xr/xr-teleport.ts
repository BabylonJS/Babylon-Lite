/**
 * WebXR controller teleportation — thumbstick-driven locomotion, ported in spirit
 * from Babylon.js `WebXRMotionControllerTeleportation`. Push a controller's
 * thumbstick forward to aim: a laser + a flat ring reticle track the floor under
 * the ray; release the stick to teleport the viewer to that spot. Push the stick
 * left/right to snap-turn by a fixed angle.
 *
 * The viewer is moved by swapping the session's reference space for an
 * `XRRigidTransform` offset space (`getOffsetReferenceSpace`) — the WebXR-native way
 * to relocate the origin — so the physical room stays put while the scene shifts
 * under the user. Structure mirrors {@link XrPointer}: a per-DOM-source unit map,
 * visuals created lazily and hidden while inactive. Pure data + free functions
 * (pillar 4b); nothing runs unless the app imports and drives it.
 */

import type { EngineContext } from "../engine/engine.js";
import type { Mat4 } from "../math/types.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneContext } from "../scene/scene.js";
import type { XrInputManager } from "./xr-input.js";
import type { XrFeatureSpec } from "./xr-feature.js";
import { mat4Decompose } from "../math/mat4-decompose.js";
import { createBox, createTorus } from "../mesh/mesh-factories.js";
import { createStandardMaterial } from "../material/standard/create-standard-material.js";
import { addToScene } from "../scene/scene-core.js";
import { removeFromScene } from "../scene/scene-remove.js";
import { disposeMeshGpu } from "../mesh/mesh-dispose.js";
import { setSubtreeVisible } from "../scene/visibility.js";
import { pickWithRay } from "../picking/ray-pick.js";
import { computePointerVisual } from "./xr-pointer.js";

// `@types/webxr` names the DOM source interface `XRInputSource`; alias it so the
// unit map can key on the stable DOM object rather than our per-frame wrapper.
type DomXrInputSource = XRInputSource;

/** Options for {@link teleportation} / {@link createXrTeleportation}. */
export interface XrTeleportationOptions {
    /** Meshes that count as teleportable floor. A ray only teleports when it lands on
     *  one of these. Mutually exclusive with {@link floorPredicate}. */
    floorMeshes?: readonly Mesh[];
    /** Predicate selecting teleportable floor meshes (alternative to {@link floorMeshes}).
     *  When neither is given, any surface whose world normal points roughly up is floor. */
    floorPredicate?: (mesh: Mesh) => boolean;
    /** Reticle + laser tint while aiming at valid floor. Default Babylon teleport blue. */
    color?: readonly [number, number, number];
    /** Max ray length in metres. Default `20`. */
    maxLength?: number;
    /** Enable thumbstick left/right snap-turn. Default `true`. */
    snapTurn?: boolean;
    /** Snap-turn step in radians. Default `Math.PI / 4` (45°). */
    rotationAngle?: number;
    /** Thumbstick magnitude past which forward = aim and sideways = turn. Default `0.7`. */
    thumbstickThreshold?: number;
}

/** @internal Default reticle/laser colour (Babylon teleport blue). */
const DEFAULT_COLOR: [number, number, number] = [0.3, 0.6, 1];
/** @internal Reticle ring diameter in metres before orienting flat on the floor. */
const RETICLE_DIAMETER = 0.4;
/** @internal Laser cross-section (metres). */
const LASER_THICKNESS = 0.006;
/** @internal A floor pick's world normal must be at least this upward (dot with +Y). */
const FLOOR_NORMAL_MIN_Y = 0.6;

/** @internal Per-controller teleport visuals + activation state. */
interface TeleportUnit {
    /** Straight aim laser (shown while the thumbstick is pushed forward). */
    laser: Mesh;
    /** Flat ring reticle on the floor (shown only on a valid floor hit). */
    reticle: Mesh;
    /** True while the thumbstick is pushed forward (aim mode). */
    aiming: boolean;
    /** Last valid floor hit point, or null when the aim isn't on floor. */
    target: [number, number, number] | null;
    /** True while a snap-turn is latched (stick held past threshold), for debounce. */
    turnLatched: boolean;
}

/** A teleportation manager. Create with {@link createXrTeleportation}, drive with
 *  {@link updateXrTeleportation} each XR frame, release with {@link disposeXrTeleportation}. */
export interface XrTeleportation {
    /** @internal */
    _engine: EngineContext;
    /** @internal */
    _scene: SceneContext;
    /** @internal */
    _options: Required<Pick<XrTeleportationOptions, "maxLength" | "snapTurn" | "rotationAngle" | "thumbstickThreshold">> & { color: [number, number, number] };
    /** @internal Floor test derived from `floorMeshes` / `floorPredicate` / normal fallback. */
    _isFloor: (mesh: Mesh, normalWorld: [number, number, number] | null) => boolean;
    /** @internal Height (m) of the floor the viewer currently stands on; updated per teleport
     *  so multi-level floors preserve eye height. */
    _floorY: number;
    /** @internal Visuals per DOM input source. */
    _units: Map<DomXrInputSource, TeleportUnit>;
}

/** @internal Build the floor test from the options. */
function makeFloorTest(options: XrTeleportationOptions): (mesh: Mesh, normalWorld: [number, number, number] | null) => boolean {
    if (options.floorMeshes) {
        const set = new Set(options.floorMeshes);
        return (mesh) => set.has(mesh);
    }
    if (options.floorPredicate) {
        const pred = options.floorPredicate;
        return (mesh) => pred(mesh);
    }
    // Fallback: treat any roughly-upward-facing surface as floor.
    return (_mesh, n) => n !== null && n[1] >= FLOOR_NORMAL_MIN_Y;
}

/** @internal Unlit material in the teleport tint (reads clearly against any scene). */
function tintMaterial(color: readonly [number, number, number]): Mesh["material"] {
    const mat = createStandardMaterial();
    // With lighting disabled the shader multiplies emissive by diffuse, so diffuse
    // must stay white or the mesh renders black.
    mat.diffuseColor = [1, 1, 1];
    mat.emissiveColor = [color[0], color[1], color[2]];
    mat.disableLighting = true;
    return mat as unknown as Mesh["material"];
}

/** Create a teleportation manager bound to a scene. */
export function createXrTeleportation(engine: EngineContext, scene: SceneContext, options: XrTeleportationOptions = {}): XrTeleportation {
    const color = (options.color ?? DEFAULT_COLOR) as [number, number, number];
    return {
        _engine: engine,
        _scene: scene,
        _options: {
            color: [color[0], color[1], color[2]],
            maxLength: options.maxLength ?? 20,
            snapTurn: options.snapTurn ?? true,
            rotationAngle: options.rotationAngle ?? Math.PI / 4,
            thumbstickThreshold: options.thumbstickThreshold ?? 0.7,
        },
        _isFloor: makeFloorTest(options),
        _floorY: 0,
        _units: new Map(),
    };
}

/** @internal Lazily create a controller's laser + reticle. */
function ensureUnit(tp: XrTeleportation, source: DomXrInputSource): TeleportUnit {
    const existing = tp._units.get(source);
    if (existing) {
        return existing;
    }
    const color = tp._options.color;
    const laser = createBox(tp._engine, 1);
    laser.name = "xr-teleport-laser";
    laser.material = tintMaterial(color);
    laser.pickable = false;
    laser.receiveShadows = false;
    laser.visible = false;

    const reticle = createTorus(tp._engine, { diameter: RETICLE_DIAMETER, thickness: RETICLE_DIAMETER * 0.14, tessellation: 40 });
    reticle.name = "xr-teleport-reticle";
    reticle.material = tintMaterial(color);
    reticle.pickable = false;
    reticle.receiveShadows = false;
    reticle.visible = false;

    addToScene(tp._scene, laser);
    addToScene(tp._scene, reticle);
    const unit: TeleportUnit = { laser, reticle, aiming: false, target: null, turnLatched: false };
    tp._units.set(source, unit);
    return unit;
}

/** @internal Dispose one unit's visuals. */
function disposeUnit(tp: XrTeleportation, unit: TeleportUnit): void {
    removeFromScene(tp._scene, unit.laser);
    removeFromScene(tp._scene, unit.reticle);
    disposeMeshGpu(unit.laser);
    disposeMeshGpu(unit.reticle);
}

/** @internal Shortest-arc quaternion rotating local +Y onto world `n` (both unit).
 *  With up = (0,1,0): cross(up, n) = (n.z, 0, -n.x) and dot(up, n) = n.y. */
function orientRingToNormal(reticle: Mesh, n: [number, number, number]): void {
    const cx = n[2];
    const cz = -n[0];
    const dot = n[1];
    if (dot > 0.99999) {
        reticle.rotationQuaternion.set(0, 0, 0, 1);
        return;
    }
    if (dot < -0.99999) {
        // Antiparallel: flip 180° about X.
        reticle.rotationQuaternion.set(1, 0, 0, 0);
        return;
    }
    const s = Math.hypot(cx, 0, cz) || 1;
    const angle = Math.atan2(s, dot);
    const half = angle / 2;
    const sinH = Math.sin(half) / s;
    reticle.rotationQuaternion.set(cx * sinH, 0, cz * sinH, Math.cos(half));
}

/** @internal Read the active thumbstick (xr-standard axes 2/3, falling back to 0/1). */
function readThumbstick(gamepad: Gamepad): [number, number] {
    const a = gamepad.axes;
    const x = (a.length > 2 ? a[2] : a[0]) ?? 0;
    const y = (a.length > 3 ? a[3] : a[1]) ?? 0;
    return [x, y];
}

/** @internal Offset the reference space so the viewer's feet move from `from` (its
 *  current position in `ref`) to floor point `to`, preserving eye height. Returns the
 *  new reference space. */
function teleportRef(ref: XRReferenceSpace, from: [number, number, number], to: [number, number, number], floorY: number): XRReferenceSpace {
    const t = { x: from[0] - to[0], y: floorY - to[1], z: from[2] - to[2] };
    return ref.getOffsetReferenceSpace(new XRRigidTransform(t));
}

/** @internal Offset the reference space to snap-rotate the view by `angle` (radians,
 *  about world +Y) around the viewer position `v`. Returns the new reference space. */
function turnRef(ref: XRReferenceSpace, v: [number, number, number], angle: number): XRReferenceSpace {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const rx = v[0] * c + v[2] * s;
    const rz = -v[0] * s + v[2] * c;
    const half = angle / 2;
    const q = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
    return ref.getOffsetReferenceSpace(new XRRigidTransform({ x: v[0] - rx, y: 0, z: v[2] - rz }, q));
}

/**
 * Drive teleportation for the current frame: read each controller's thumbstick, aim
 * a laser + floor reticle while it's pushed forward, teleport on release, and
 * snap-turn on sideways pushes. Returns the (possibly new) reference space — the
 * caller must adopt it for subsequent frames (the {@link teleportation} feature does
 * this automatically). Call once per XR frame after {@link updateXrInputPoses}.
 */
export function updateXrTeleportation(tp: XrTeleportation, input: XrInputManager, frame: XRFrame, referenceSpace: XRReferenceSpace): XRReferenceSpace {
    const seen = new Set<DomXrInputSource>();
    const opts = tp._options;
    let ref = referenceSpace;

    for (const src of input.inputSources) {
        const gamepad = src.source.gamepad;
        // Teleportation is thumbstick-driven; sources without a gamepad (e.g. hands) opt out.
        if (!gamepad) {
            continue;
        }
        seen.add(src.source);
        const unit = ensureUnit(tp, src.source);
        const [tx, ty] = readThumbstick(gamepad);
        const forward = ty <= -opts.thumbstickThreshold;

        // --- Snap turn (only when not aiming) ---
        if (opts.snapTurn && !forward && Math.abs(tx) >= opts.thumbstickThreshold) {
            if (!unit.turnLatched) {
                const pose = frame.getViewerPose(ref);
                if (pose) {
                    const p = pose.transform.position;
                    ref = turnRef(ref, [p.x, p.y, p.z], tx > 0 ? opts.rotationAngle : -opts.rotationAngle);
                }
                unit.turnLatched = true;
            }
        } else if (Math.abs(tx) < opts.thumbstickThreshold * 0.5) {
            unit.turnLatched = false;
        }

        // --- Aim / teleport ---
        if (forward) {
            unit.aiming = true;
            if (src.targetRayTracked) {
                const m = src.targetRayMatrix as unknown as Mat4;
                const origin: [number, number, number] = [m[12]!, m[13]!, m[14]!];
                let fx = -m[8]!,
                    fy = -m[9]!,
                    fz = -m[10]!;
                const flen = Math.hypot(fx, fy, fz) || 1;
                fx /= flen;
                fy /= flen;
                fz /= flen;
                const dir: [number, number, number] = [fx, fy, fz];
                const info = pickWithRay(tp._scene, { origin, direction: dir, length: opts.maxLength });
                const normal = info.pickedNormalWorld as [number, number, number] | null;
                const onFloor = info.hit && info.pickedPoint !== null && tp._isFloor(info.pickedMesh as Mesh, normal);

                const visual = computePointerVisual(origin, dir, info.hit ? info.distance : -1, opts.maxLength);
                const rot = mat4Decompose(m).rotation;
                unit.laser.rotationQuaternion.set(rot.x, rot.y, rot.z, rot.w);
                unit.laser.position.set(visual.laserPosition[0], visual.laserPosition[1], visual.laserPosition[2]);
                unit.laser.scaling.set(LASER_THICKNESS, LASER_THICKNESS, visual.beamLength);
                setSubtreeVisible(unit.laser, true);

                if (onFloor) {
                    const hp = info.pickedPoint!;
                    unit.target = [hp[0], hp[1], hp[2]];
                    unit.reticle.position.set(hp[0], hp[1], hp[2]);
                    orientRingToNormal(unit.reticle, normal ?? [0, 1, 0]);
                    setSubtreeVisible(unit.reticle, true);
                } else {
                    unit.target = null;
                    setSubtreeVisible(unit.reticle, false);
                }
            }
        } else {
            // Release: commit the teleport to the last valid target, then clear visuals.
            if (unit.aiming && unit.target) {
                const pose = frame.getViewerPose(ref);
                if (pose) {
                    const p = pose.transform.position;
                    ref = teleportRef(ref, [p.x, p.y, p.z], unit.target, tp._floorY);
                    tp._floorY = unit.target[1];
                }
            }
            unit.aiming = false;
            unit.target = null;
            setSubtreeVisible(unit.laser, false);
            setSubtreeVisible(unit.reticle, false);
        }
    }

    // Retire visuals for sources that disconnected since the last frame.
    for (const [source, unit] of tp._units) {
        if (!seen.has(source)) {
            disposeUnit(tp, unit);
            tp._units.delete(source);
        }
    }
    return ref;
}

/** Dispose all teleport visuals and detach them from the scene. */
export function disposeXrTeleportation(tp: XrTeleportation): void {
    for (const unit of tp._units.values()) {
        disposeUnit(tp, unit);
    }
    tp._units.clear();
}

/**
 * Controller teleportation as an opt-in {@link XrFeatureSpec} (Babylon.js
 * `TELEPORTATION`). Pass it to `enterXr({ features: [teleportation({ floorMeshes })] })`:
 * push a thumbstick forward to aim a laser + floor reticle, release to teleport,
 * push sideways to snap-turn. The session drives + disposes it and adopts the offset
 * reference space each frame — no manual wiring.
 *
 * Requires input tracking (do not pass `input: false` to {@link enterXr}); it needs
 * no native WebXR session feature.
 *
 * @param options - Floor selection + appearance (see {@link XrTeleportationOptions}).
 */
export function teleportation(options: XrTeleportationOptions = {}): XrFeatureSpec {
    return {
        create(ctx) {
            if (!ctx.input) {
                throw new Error("teleportation requires XR input tracking; do not pass input:false to enterXr.");
            }
            const input = ctx.input;
            const tp = createXrTeleportation(ctx.engine, ctx.scene, options);
            return {
                update(frame): void {
                    ctx._referenceSpace = updateXrTeleportation(tp, input, frame, ctx._referenceSpace);
                },
                dispose(): void {
                    disposeXrTeleportation(tp);
                },
            };
        },
    };
}
