/**
 * WebXR controller teleportation — thumbstick-driven locomotion, ported in spirit
 * from Babylon.js `WebXRMotionControllerTeleportation`, at feature parity:
 *
 *  - **Parabolic aim ray.** Push a controller's thumbstick forward to aim. The ray is
 *    a projectile arc (initial velocity along the controller's forward, curving down
 *    under gravity), so you can aim *up* onto higher platforms or *down* off ledges —
 *    teleporting to floors at different heights, not just the one you stand on.
 *  - **Landing direction.** While aiming, lean the stick left/right to choose which way
 *    you'll face after landing; a floor arrow (floating just outside the ring) previews it.
 *    Let the stick spring back to centre to teleport there and rotate to that heading in one
 *    step — the teleport commits on the *return to centre*, not on a partial release.
 *  - **Snap turn.** With the stick centred forward-wise, a left/right push snap-turns in
 *    place by a fixed angle.
 *
 * The arc is drawn as a single camera-facing ribbon mesh whose vertices are rewritten
 * in place each frame ({@link updateMeshPositions}) — one draw call per controller, zero
 * per-frame allocation. The viewer is moved by swapping the session's reference space for
 * an `XRRigidTransform` offset space (`getOffsetReferenceSpace`) — the WebXR-native way to
 * relocate the origin — so the physical room stays put while the scene shifts under the
 * user. Pure data + free functions (pillar 4b); nothing runs unless the app drives it.
 */

import type { EngineContext } from "../engine/engine.js";
import type { Mat4 } from "../math/types.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneContext } from "../scene/scene.js";
import type { XrInputManager } from "./xr-input.js";
import type { XrFeatureSpec } from "./xr-feature.js";
import { createMeshFromData, createTorus, updateMeshPositions } from "../mesh/mesh-factories.js";
import { createStandardMaterial } from "../material/standard/create-standard-material.js";
import { addToScene } from "../scene/scene-core.js";
import { removeFromScene } from "../scene/scene-remove.js";
import { disposeMeshGpu } from "../mesh/mesh-dispose.js";
import { setSubtreeVisible } from "../scene/visibility.js";
import { pickWithRay } from "../picking/ray-pick.js";

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
    /** Reticle + arc tint while aiming at valid floor. Default Babylon teleport blue. */
    color?: readonly [number, number, number];
    /** Max horizontal reach of the aim arc in metres. Default `20`. */
    maxLength?: number;
    /** Parabolic aim arc (curves down under gravity so you can aim up/down onto floors at
     *  other heights). Set `false` for a straight ray. Default `true`. */
    parabolic?: boolean;
    /** Launch speed (m/s) of the parabolic arc — higher flattens it, lower curves it more.
     *  Only affects arc shape, not reach. Default `7`. */
    parabolaSpeed?: number;
    /** Downward acceleration (m/s²) applied to the parabolic arc. Default `9.8`. */
    gravity?: number;
    /** Let the stick's left/right lean set the heading you face after teleporting, previewed
     *  by a floor arrow. Default `true`. */
    rotateToDirection?: boolean;
    /** Enable thumbstick left/right snap-turn (when not aiming). Default `true`. */
    snapTurn?: boolean;
    /** Snap-turn step in radians. Default `Math.PI / 4` (45°). */
    rotationAngle?: number;
    /** Thumbstick magnitude past which forward = aim and sideways = turn. Default `0.7`. */
    thumbstickThreshold?: number;
}

/** @internal Default reticle/arc colour (Babylon teleport blue). */
const DEFAULT_COLOR: [number, number, number] = [0.3, 0.6, 1];
/** @internal Reticle ring diameter in metres before orienting flat on the floor. */
const RETICLE_DIAMETER = 0.4;
/** @internal Half-width (metres) of the ribbon arc's cross-section. */
const ARC_HALF_WIDTH = 0.008;
/** @internal Number of points sampled along the aim arc (ribbon = 2 verts per point). */
const ARC_POINTS = 20;
/** @internal Landing-arrow length in metres (flat triangle laid on the floor). Sized to
 *  read clearly from across a room, since it sits OUTSIDE the ring (see {@link orientIndicator}). */
const INDICATOR_LENGTH = 0.3;
/** @internal Landing-arrow half-width in metres. */
const INDICATOR_HALF_WIDTH = 0.13;
/** @internal Gap (metres) between the ring's outer edge and the landing arrow's base, so the
 *  arrow floats just beyond the reticle rather than overlapping it (Babylon-style, clearer from far). */
const INDICATOR_GAP = 0.05;
/** @internal Small lift (metres) of the landing arrow above the floor so its flat triangle isn't
 *  coplanar with the floor surface (which z-fights and flickers). */
const INDICATOR_LIFT = 0.02;
/** @internal A floor pick's world normal must be at least this upward (dot with +Y). */
const FLOOR_NORMAL_MIN_Y = 0.6;
/** @internal Stick magnitude at/below which the stick counts as centred — this, not a partial
 *  release, is what commits the teleport (matches Babylon: teleport happens when you let go). */
const CENTER_DEADZONE = 0.2;
/** @internal While the stick is deflected past this the landing heading tracks the lean; below it
 *  the last heading is frozen so the arrow doesn't spin as the stick springs back to centre. */
const HEADING_FREEZE = 0.35;

/** @internal Per-controller teleport visuals + activation state. */
interface TeleportUnit {
    /** Parabolic aim arc ribbon (shown while the thumbstick is pushed forward). */
    arc: Mesh;
    /** Flat ring reticle on the floor (shown only on a valid floor hit). */
    reticle: Mesh;
    /** Flat arrow previewing the post-teleport heading (shown with the reticle). */
    indicator: Mesh;
    /** Reused world-space arc sample points (`ARC_POINTS` × xyz). */
    arcPath: Float32Array;
    /** Reused ribbon vertex scratch (`2 × ARC_POINTS` × xyz) uploaded each frame. */
    arcVerts: Float32Array;
    /** True while the thumbstick is pushed forward (aim mode). */
    aiming: boolean;
    /** Last valid floor hit point, or null when the aim isn't on floor. */
    target: [number, number, number] | null;
    /** Heading offset (radians) chosen by the stick lean, applied on release. */
    landingTurn: number;
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
    _options: Required<
        Pick<XrTeleportationOptions, "maxLength" | "parabolic" | "parabolaSpeed" | "gravity" | "rotateToDirection" | "snapTurn" | "rotationAngle" | "thumbstickThreshold">
    > & { color: [number, number, number] };
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
function tintMaterial(color: readonly [number, number, number], alpha: number, twoSided: boolean): Mesh["material"] {
    const mat = createStandardMaterial();
    // With lighting disabled the shader multiplies emissive by diffuse, so diffuse
    // must stay white or the mesh renders black.
    mat.diffuseColor = [1, 1, 1];
    mat.emissiveColor = [color[0], color[1], color[2]];
    mat.disableLighting = true;
    mat.alpha = alpha;
    if (twoSided) {
        mat.backFaceCulling = false;
    }
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
            parabolic: options.parabolic ?? true,
            parabolaSpeed: options.parabolaSpeed ?? 7,
            gravity: options.gravity ?? 9.8,
            rotateToDirection: options.rotateToDirection ?? true,
            snapTurn: options.snapTurn ?? true,
            rotationAngle: options.rotationAngle ?? Math.PI / 4,
            thumbstickThreshold: options.thumbstickThreshold ?? 0.7,
        },
        _isFloor: makeFloorTest(options),
        _floorY: 0,
        _units: new Map(),
    };
}

/** @internal Ribbon strip index buffer for `ARC_POINTS` rung pairs (left = 2i, right = 2i+1). */
function buildArcIndices(): Uint32Array {
    const idx = new Uint32Array((ARC_POINTS - 1) * 6);
    for (let i = 0; i < ARC_POINTS - 1; i++) {
        const a = 2 * i,
            b = 2 * i + 1,
            c = 2 * i + 2,
            d = 2 * i + 3;
        const o = i * 6;
        idx[o] = a;
        idx[o + 1] = b;
        idx[o + 2] = c;
        idx[o + 3] = b;
        idx[o + 4] = d;
        idx[o + 5] = c;
    }
    return idx;
}

/** @internal Lazily create a controller's arc + reticle + landing arrow. */
function ensureUnit(tp: XrTeleportation, source: DomXrInputSource): TeleportUnit {
    const existing = tp._units.get(source);
    if (existing) {
        return existing;
    }
    const color = tp._options.color;
    const engine = tp._engine;

    const arcVerts = new Float32Array(2 * ARC_POINTS * 3);
    const arcNormals = new Float32Array(2 * ARC_POINTS * 3);
    for (let i = 0; i < 2 * ARC_POINTS; i++) {
        arcNormals[i * 3 + 1] = 1;
    }
    const arc = createMeshFromData(engine, "xr-teleport-arc", arcVerts.slice(), arcNormals, buildArcIndices());
    arc.material = tintMaterial(color, 0.85, true);
    arc.pickable = false;
    arc.receiveShadows = false;
    arc.visible = false;

    const reticle = createTorus(engine, { diameter: RETICLE_DIAMETER, thickness: RETICLE_DIAMETER * 0.14, tessellation: 40 });
    reticle.name = "xr-teleport-reticle";
    reticle.material = tintMaterial(color, 1, false);
    reticle.pickable = false;
    reticle.receiveShadows = false;
    reticle.visible = false;

    // Flat arrow triangle in the XZ plane pointing +Z (tip forward), laid on the floor.
    const w = INDICATOR_HALF_WIDTH;
    const l = INDICATOR_LENGTH;
    const indicator = createMeshFromData(
        engine,
        "xr-teleport-arrow",
        new Float32Array([-w, 0, 0, w, 0, 0, 0, 0, l]),
        new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
        new Uint32Array([0, 1, 2])
    );
    indicator.material = tintMaterial(color, 1, true);
    indicator.pickable = false;
    indicator.receiveShadows = false;
    indicator.visible = false;

    addToScene(tp._scene, arc);
    addToScene(tp._scene, reticle);
    addToScene(tp._scene, indicator);
    const unit: TeleportUnit = {
        arc,
        reticle,
        indicator,
        arcPath: new Float32Array(ARC_POINTS * 3),
        arcVerts,
        aiming: false,
        target: null,
        landingTurn: 0,
        turnLatched: false,
    };
    tp._units.set(source, unit);
    return unit;
}

/** @internal Dispose one unit's visuals. */
function disposeUnit(tp: XrTeleportation, unit: TeleportUnit): void {
    removeFromScene(tp._scene, unit.arc);
    removeFromScene(tp._scene, unit.reticle);
    removeFromScene(tp._scene, unit.indicator);
    disposeMeshGpu(unit.arc);
    disposeMeshGpu(unit.reticle);
    disposeMeshGpu(unit.indicator);
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

/** @internal Horizontal view-forward direction from a viewer pose's orientation, or null
 *  when the runtime doesn't expose orientation. Forward = local −Z rotated by the quaternion. */
function viewForward(pose: XRViewerPose): [number, number, number] | null {
    const o = pose.transform.orientation as { x: number; y: number; z: number; w: number } | undefined;
    if (!o) {
        return null;
    }
    const fx = -2 * (o.x * o.z + o.w * o.y);
    const fz = -(1 - 2 * (o.x * o.x + o.y * o.y));
    const len = Math.hypot(fx, fz) || 1;
    return [fx / len, 0, fz / len];
}

/** @internal Rotate a horizontal vector about world +Y by `a` (matches `Ry(a)`). */
function rotateY(v: [number, number, number], a: number): [number, number, number] {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [v[0] * c + v[2] * s, 0, -v[0] * s + v[2] * c];
}

/** @internal March the aim arc sampling `ARC_POINTS` world points into `outPath`, stopping at
 *  the first surface it strikes (collapsing the tail onto that point). Returns the hit, if any. */
function traceArc(
    tp: XrTeleportation,
    origin: [number, number, number],
    dir: [number, number, number],
    outPath: Float32Array
): { hit: boolean; point: [number, number, number]; normal: [number, number, number] | null; mesh: Mesh | null } {
    const opts = tp._options;
    const speed = opts.parabolaSpeed;
    const g = opts.parabolic ? opts.gravity : 0;
    // Constant time step so the initial-velocity reach ≈ maxLength regardless of speed.
    const dt = opts.maxLength / ((ARC_POINTS - 1) * speed);

    outPath[0] = origin[0];
    outPath[1] = origin[1];
    outPath[2] = origin[2];
    let px = origin[0],
        py = origin[1],
        pz = origin[2];

    for (let i = 1; i < ARC_POINTS; i++) {
        const t = i * dt;
        const cx = origin[0] + dir[0] * speed * t;
        const cy = origin[1] + dir[1] * speed * t - 0.5 * g * t * t;
        const cz = origin[2] + dir[2] * speed * t;
        const dx = cx - px,
            dy = cy - py,
            dz = cz - pz;
        const len = Math.hypot(dx, dy, dz) || 1e-6;
        const info = pickWithRay(tp._scene, { origin: [px, py, pz], direction: [dx / len, dy / len, dz / len], length: len });
        if (info.hit && info.pickedPoint) {
            const hp = info.pickedPoint as [number, number, number];
            for (let j = i; j < ARC_POINTS; j++) {
                outPath[j * 3] = hp[0];
                outPath[j * 3 + 1] = hp[1];
                outPath[j * 3 + 2] = hp[2];
            }
            return { hit: true, point: [hp[0], hp[1], hp[2]], normal: info.pickedNormalWorld as [number, number, number] | null, mesh: info.pickedMesh as Mesh | null };
        }
        outPath[i * 3] = cx;
        outPath[i * 3 + 1] = cy;
        outPath[i * 3 + 2] = cz;
        px = cx;
        py = cy;
        pz = cz;
    }
    return { hit: false, point: [px, py, pz], normal: null, mesh: null };
}

/** @internal Rewrite the ribbon vertices so it hugs the arc as a camera-facing strip. */
function updateArcRibbon(tp: XrTeleportation, unit: TeleportUnit, camPos: [number, number, number]): void {
    const path = unit.arcPath;
    const out = unit.arcVerts;
    const hw = ARC_HALF_WIDTH;
    for (let i = 0; i < ARC_POINTS; i++) {
        const cx = path[i * 3]!,
            cy = path[i * 3 + 1]!,
            cz = path[i * 3 + 2]!;
        const i0 = i > 0 ? i - 1 : 0;
        const i1 = i < ARC_POINTS - 1 ? i + 1 : ARC_POINTS - 1;
        const tx = path[i1 * 3]! - path[i0 * 3]!;
        const ty = path[i1 * 3 + 1]! - path[i0 * 3 + 1]!;
        const tz = path[i1 * 3 + 2]! - path[i0 * 3 + 2]!;
        const vx = camPos[0] - cx,
            vy = camPos[1] - cy,
            vz = camPos[2] - cz;
        // side = tangent × viewDir (perpendicular to both → faces the camera).
        let sx = ty * vz - tz * vy;
        let sy = tz * vx - tx * vz;
        let sz = tx * vy - ty * vx;
        const sl = Math.hypot(sx, sy, sz) || 1;
        sx = (sx / sl) * hw;
        sy = (sy / sl) * hw;
        sz = (sz / sl) * hw;
        const o = i * 6;
        out[o] = cx + sx;
        out[o + 1] = cy + sy;
        out[o + 2] = cz + sz;
        out[o + 3] = cx - sx;
        out[o + 4] = cy - sy;
        out[o + 5] = cz - sz;
    }
    updateMeshPositions(tp._engine, unit.arc, out);
}

/** @internal Point the landing arrow along `dir` (horizontal), laid flat on the floor, floating
 *  just OUTSIDE the ring so it reads clearly from a distance (Babylon-style). */
function orientIndicator(indicator: Mesh, at: [number, number, number], dir: [number, number, number]): void {
    // Push the arrow out past the ring's edge along the heading, so its base clears the reticle,
    // and lift it slightly so its flat triangle doesn't z-fight (flicker) with the floor.
    const off = RETICLE_DIAMETER / 2 + INDICATOR_GAP;
    indicator.position.set(at[0] + dir[0] * off, at[1] + INDICATOR_LIFT, at[2] + dir[2] * off);
    // Yaw so local +Z maps onto `dir`: Ry(θ)·(0,0,1) = (sinθ, 0, cosθ).
    const yaw = Math.atan2(dir[0], dir[2]);
    const half = yaw / 2;
    indicator.rotationQuaternion.set(0, Math.sin(half), 0, Math.cos(half));
}

/** @internal Offset the reference space so the viewer's feet move from `from` (its
 *  current position in `ref`) to floor point `to`, preserving eye height. Returns the
 *  new reference space. */
function teleportRef(ref: XRReferenceSpace, from: [number, number, number], to: [number, number, number], floorY: number): XRReferenceSpace {
    const t = { x: from[0] - to[0], y: floorY - to[1], z: from[2] - to[2] };
    return ref.getOffsetReferenceSpace(new XRRigidTransform(t));
}

/** @internal Offset the reference space to rotate the view by `angle` (radians, about
 *  world +Y) around the viewer position `v`. Returns the new reference space. */
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
 * Drive teleportation for the current frame: read each controller's thumbstick, aim a
 * parabolic arc + floor reticle while it's pushed forward, teleport (and rotate to the
 * chosen heading) on release, and snap-turn on sideways pushes. Returns the (possibly
 * new) reference space — the caller must adopt it for subsequent frames (the
 * {@link teleportation} feature does this automatically). Call once per XR frame after
 * {@link updateXrInputPoses}.
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
        const mag = Math.hypot(tx, ty);
        const centered = mag < CENTER_DEADZONE;

        // A forward push past the threshold engages aim mode. Once engaged we STAY in aim
        // mode — no matter how the stick is leaned to pick a heading — until the stick
        // springs back to centre, which is what actually commits the teleport. This matches
        // Babylon: you teleport when you let go, not partway back.
        if (ty <= -opts.thumbstickThreshold) {
            unit.aiming = true;
        }

        // --- Snap turn (only when NOT aiming) ---
        if (!unit.aiming) {
            if (opts.snapTurn && Math.abs(tx) >= opts.thumbstickThreshold && Math.abs(ty) < opts.thumbstickThreshold) {
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
        }

        // --- Aim / teleport ---
        if (unit.aiming && !centered) {
            // Holding: aim the parabolic arc (direction comes from the controller ray, not the
            // stick) and preview the landing reticle + heading arrow.
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

                const info = traceArc(tp, origin, dir, unit.arcPath);
                const pose = frame.getViewerPose(ref);
                const camPos: [number, number, number] = pose ? [pose.transform.position.x, pose.transform.position.y, pose.transform.position.z] : origin;
                updateArcRibbon(tp, unit, camPos);
                setSubtreeVisible(unit.arc, true);

                const onFloor = info.hit && tp._isFloor(info.mesh as Mesh, info.normal);
                if (onFloor) {
                    unit.target = info.point;
                    unit.reticle.position.set(info.point[0], info.point[1], info.point[2]);
                    orientRingToNormal(unit.reticle, info.normal ?? [0, 1, 0]);
                    setSubtreeVisible(unit.reticle, true);

                    // Landing heading: the stick lean rotates the current view-forward. Only
                    // update it while the stick is strongly deflected; freeze the last value as
                    // it springs back so the arrow doesn't whip around on release.
                    if (opts.rotateToDirection) {
                        if (mag >= HEADING_FREEZE) {
                            // atan2 already gives 0 for a pure-forward push and ±π for a pure-back
                            // push, varying smoothly in between — no hard deadzone (a |tx| gate would
                            // wrongly zero the 180° back-push too, making the arrow flip near backward).
                            unit.landingTurn = Math.atan2(tx, -ty);
                        }
                        const fwd = pose ? viewForward(pose) : null;
                        if (fwd) {
                            // Preview arrow points where you'll face: view-forward rotated by −turn
                            // (the reference-space offset reports the view rotated by −turn).
                            orientIndicator(unit.indicator, info.point, rotateY(fwd, -unit.landingTurn));
                            setSubtreeVisible(unit.indicator, true);
                        } else {
                            setSubtreeVisible(unit.indicator, false);
                        }
                    } else {
                        unit.landingTurn = 0;
                        setSubtreeVisible(unit.indicator, false);
                    }
                } else {
                    unit.target = null;
                    unit.landingTurn = 0;
                    setSubtreeVisible(unit.reticle, false);
                    setSubtreeVisible(unit.indicator, false);
                }
            }
        } else if (unit.aiming && centered) {
            // Released at centre: commit the teleport to the last valid target, then clear visuals.
            if (unit.target) {
                const pose = frame.getViewerPose(ref);
                if (pose) {
                    const p = pose.transform.position;
                    const target = unit.target;
                    ref = teleportRef(ref, [p.x, p.y, p.z], target, tp._floorY);
                    tp._floorY = target[1];
                    if (opts.rotateToDirection && Math.abs(unit.landingTurn) > 1e-4) {
                        ref = turnRef(ref, target, unit.landingTurn);
                    }
                }
            }
            unit.aiming = false;
            unit.turnLatched = false;
            unit.target = null;
            unit.landingTurn = 0;
            setSubtreeVisible(unit.arc, false);
            setSubtreeVisible(unit.reticle, false);
            setSubtreeVisible(unit.indicator, false);
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
 * push a thumbstick forward to aim a parabolic arc + floor reticle, lean sideways to pick
 * a heading, release to teleport there facing that way; push sideways (centred) to
 * snap-turn. The session drives + disposes it and adopts the offset reference space each
 * frame — no manual wiring.
 *
 * Requires input tracking (do not pass `input: false` to {@link enterXr}); it needs no
 * native WebXR session feature.
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
