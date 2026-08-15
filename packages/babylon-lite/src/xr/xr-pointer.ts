/**
 * Controller pointer-selection — a laser beam + cursor driven by each input
 * source's target ray, ported from Babylon.js `WebXRControllerPointerSelection`.
 *
 * Each tracked target ray is cast against the scene with the synchronous CPU
 * {@link pickWithRay}; the laser is stretched to the hit distance and a cursor is
 * placed at the hit point. Hover and select (trigger) transitions are surfaced via
 * callbacks. Pure data + free functions (pillar 4b); nothing here runs unless the
 * app imports and drives it, so non-XR (and pointer-less XR) scenes are unaffected.
 */

import type { EngineContext } from "../engine/engine.js";
import type { Mat4 } from "../math/types.js";
import type { Mesh } from "../mesh/mesh.js";
import type { SceneContext } from "../scene/scene.js";
import type { StandardMaterialProps } from "../material/standard/standard-material.js";
import type { PickingInfo } from "../picking/picking-info.js";
import type { XrHandedness } from "./xr-support.js";
import type { XrInputManager, XrInputSource } from "./xr-input.js";
import type { XrFeatureSpec } from "./xr-feature.js";
import { mat4Decompose } from "../math/mat4-decompose.js";
import { createBox, createTorus } from "../mesh/mesh-factories.js";
import { createStandardMaterial } from "../material/standard/create-standard-material.js";
import { addToScene } from "../scene/scene-core.js";
import { removeFromScene } from "../scene/scene-remove.js";
import { disposeMeshGpu } from "../mesh/mesh-dispose.js";
import { pickWithRay } from "../picking/ray-pick.js";
import { setSubtreeVisible } from "../scene/visibility.js";
import { markMaterialUboDirty } from "../material/material-dirty.js";

// `@types/webxr` names the DOM source interface `XRInputSource`; alias it so the
// unit map can key on the stable DOM object rather than our per-frame wrapper.
type DomXrInputSource = XRInputSource;

/** Pure result of {@link computePointerVisual}: where the beam and cursor go. */
export interface PointerVisual {
    /** True when the ray hit a mesh (cursor is shown). */
    hit: boolean;
    /** Beam length in metres — the hit distance, or `maxLength` on a miss. */
    beamLength: number;
    /** World-space centre of the laser box. */
    laserPosition: [number, number, number];
    /** World-space cursor position — meaningful only when {@link hit}. */
    cursorPosition: [number, number, number];
}

/** Options for {@link createXrPointer}. */
export interface XrPointerOptions {
    /** Maximum beam length in metres when nothing is hit. Default `10`. */
    maxLength?: number;
    /** Laser emissive colour `[r,g,b]` (0–1) while not pointing at a mesh. Default
     *  light grey `[0.7, 0.7, 0.7]` (Babylon.js `laserPointerDefaultColor`). */
    laserColor?: [number, number, number];
    /** Laser emissive colour `[r,g,b]` (0–1) while pointing at a mesh. Default
     *  `[0.9, 0.9, 0.9]` (Babylon.js `laserPointerPickedColor`). */
    laserPickedColor?: [number, number, number];
    /** Cursor (selection ring) emissive colour `[r,g,b]` (0–1) while not pointing at a
     *  mesh. Default `[0.8, 0.8, 0.8]` (Babylon.js `selectionMeshDefaultColor`). */
    cursorColor?: [number, number, number];
    /** Cursor (selection ring) emissive colour `[r,g,b]` (0–1) while pointing at a mesh.
     *  Default blue `[0.3, 0.3, 1]` (Babylon.js `selectionMeshPickedColor`). */
    cursorPickedColor?: [number, number, number];
    /** Laser cross-section thickness in metres. Default `0.004`. */
    laserThickness?: number;
    /** Selection-ring base outer diameter in metres (scaled up with hit distance so it
     *  keeps a roughly constant apparent size, like Babylon.js). Default `0.03`. */
    cursorSize?: number;
    /** Restrict which meshes the ray can pick (in addition to `mesh.pickable`). */
    predicate?: (mesh: Mesh) => boolean;
    /** Draw a laser + cursor on every tracked controller at once. When `false` (default,
     *  matching Babylon.js), only a single **active** controller shows a pointer; pressing
     *  the trigger on another controller moves focus to it (see {@link disableSwitchOnClick}).
     *  Babylon calls this `enablePointerSelectionOnAllControllers`. */
    enableOnAllControllers?: boolean;
    /** Which hand's controller should own the pointer initially / be preferred when picking
     *  the active controller (single-active mode only). Default `"none"` → first tracked. */
    preferredHandedness?: XrHandedness;
    /** Disable moving pointer focus to another controller when its trigger is pressed
     *  (single-active mode only). Default `false`. */
    disableSwitchOnClick?: boolean;
    /** Fired when a source's ray starts hovering a mesh. */
    onHoverStart?: (mesh: Mesh, input: XrInputSource) => void;
    /** Fired when a source's ray stops hovering a mesh. */
    onHoverEnd?: (mesh: Mesh, input: XrInputSource) => void;
    /** Fired when the trigger (select) is pressed while hovering a mesh. */
    onSelect?: (mesh: Mesh, info: PickingInfo, input: XrInputSource) => void;
}

/** @internal Per-input-source laser + cursor visuals and interaction state. */
interface PointerUnit {
    laser: Mesh;
    /** Selection ring placed at the hit point (Babylon.js "gazeTracker" torus). */
    cursor: Mesh;
    /** Laser material, so its emissive colour can switch on hover without a rebuild. */
    laserMat: StandardMaterialProps;
    /** Cursor material, likewise. */
    cursorMat: StandardMaterialProps;
    /** The mesh currently under this source's ray, if any. */
    hovered: Mesh | null;
    /** Last {@link XrInputSource} wrapper seen for this unit, so a disconnect-time
     *  `onHoverEnd` can still hand callers a real source (never `undefined`). */
    lastInput: XrInputSource | null;
    /** Last emissive state pushed to the materials (`true` = picked), to avoid redundant writes. */
    picked: boolean;
    /** `selecting` state on the previous frame, for edge detection. */
    wasSelecting: boolean;
}

/** A controller pointer manager. Create with {@link createXrPointer}, drive with
 *  {@link updateXrPointer} each XR frame, and release with {@link disposeXrPointer}. */
export interface XrPointer {
    /** @internal */
    _engine: EngineContext;
    /** @internal */
    _scene: SceneContext;
    /** @internal */
    _options: Required<Omit<XrPointerOptions, "predicate" | "preferredHandedness" | "onHoverStart" | "onHoverEnd" | "onSelect">> &
        Pick<XrPointerOptions, "predicate" | "preferredHandedness" | "onHoverStart" | "onHoverEnd" | "onSelect">;
    /** @internal Visuals per DOM input source. */
    _units: Map<DomXrInputSource, PointerUnit>;
    /** @internal The controller that currently owns the pointer in single-active mode
     *  (ignored when `enableOnAllControllers`). `null` until one is chosen. */
    _activeSource: DomXrInputSource | null;
}

const DEFAULTS = {
    maxLength: 10,
    laserColor: [0.7, 0.7, 0.7] as [number, number, number],
    laserPickedColor: [0.9, 0.9, 0.9] as [number, number, number],
    cursorColor: [0.8, 0.8, 0.8] as [number, number, number],
    cursorPickedColor: [0.3, 0.3, 1] as [number, number, number],
    laserThickness: 0.004,
    cursorSize: 0.03,
    enableOnAllControllers: false,
    disableSwitchOnClick: false,
};

/** @internal Hits closer than this (metres) are treated as "inside a mesh" and
 *  ignored, so a bounding box enclosing the controller can't pin the cursor. */
const MIN_PICK_DISTANCE = 0.02;

/**
 * Pure geometry for the laser + cursor given a ray and a hit distance. Separated
 * from mesh mutation so it is unit-testable without a GPU device.
 *
 * @param origin      - Ray origin (world).
 * @param forward     - Unit ray direction (world) — the target ray's −Z axis.
 * @param hitDistance - Distance to the hit, or a value `< 0` / non-finite for a miss.
 * @param maxLength   - Beam length used when there is no hit.
 */
export function computePointerVisual(origin: readonly [number, number, number], forward: readonly [number, number, number], hitDistance: number, maxLength: number): PointerVisual {
    const hit = hitDistance >= 0 && Number.isFinite(hitDistance);
    const beamLength = Math.max(1e-4, hit ? hitDistance : maxLength);
    const half = beamLength * 0.5;
    const laserPosition: [number, number, number] = [origin[0] + forward[0] * half, origin[1] + forward[1] * half, origin[2] + forward[2] * half];
    const cursorPosition: [number, number, number] = hit
        ? [origin[0] + forward[0] * hitDistance, origin[1] + forward[1] * hitDistance, origin[2] + forward[2] * hitDistance]
        : [0, 0, 0];
    return { hit, beamLength, laserPosition, cursorPosition };
}

/** Create a controller pointer manager (laser + cursor visuals) bound to a scene. */
export function createXrPointer(engine: EngineContext, scene: SceneContext, options: XrPointerOptions = {}): XrPointer {
    return {
        _engine: engine,
        _scene: scene,
        _options: {
            maxLength: options.maxLength ?? DEFAULTS.maxLength,
            laserColor: options.laserColor ?? DEFAULTS.laserColor,
            laserPickedColor: options.laserPickedColor ?? DEFAULTS.laserPickedColor,
            cursorColor: options.cursorColor ?? DEFAULTS.cursorColor,
            cursorPickedColor: options.cursorPickedColor ?? DEFAULTS.cursorPickedColor,
            laserThickness: options.laserThickness ?? DEFAULTS.laserThickness,
            cursorSize: options.cursorSize ?? DEFAULTS.cursorSize,
            enableOnAllControllers: options.enableOnAllControllers ?? DEFAULTS.enableOnAllControllers,
            disableSwitchOnClick: options.disableSwitchOnClick ?? DEFAULTS.disableSwitchOnClick,
            predicate: options.predicate,
            preferredHandedness: options.preferredHandedness,
            onHoverStart: options.onHoverStart,
            onHoverEnd: options.onHoverEnd,
            onSelect: options.onSelect,
        },
        _units: new Map(),
        _activeSource: null,
    };
}

/** @internal Build an unlit emissive material for a pointer visual. */
function unlitMaterial(color: [number, number, number], doubleSided = false): StandardMaterialProps {
    const mat = createStandardMaterial();
    // Keep diffuse white: with `disableLighting` the shader outputs
    // `emissive * diffuse * baseColor`, so a zero diffuse would render black.
    mat.diffuseColor = [1, 1, 1];
    mat.emissiveColor = [color[0], color[1], color[2]];
    mat.disableLighting = true;
    if (doubleSided) {
        mat.backFaceCulling = false;
    }
    return mat;
}

/** @internal Orient a torus ring (hole axis = local +Y) so its hole axis aligns with
 *  `dir` (a unit vector) via the shortest arc — used to lay the ring flat on the
 *  surface it points at (dir = surface normal) or, failing that, face the ray. */
function orientRingToDir(ring: Mesh, dir: [number, number, number]): void {
    const d = dir[1]; // dot((0,1,0), dir)
    if (d < -0.999999) {
        // Antiparallel: 180° about X.
        ring.rotationQuaternion.set(1, 0, 0, 0);
        return;
    }
    // axis = cross((0,1,0), dir) = (dz, 0, -dx); w = 1 + dot.
    const x = dir[2];
    const y = 0;
    const z = -dir[0];
    const w = 1 + d;
    const len = Math.hypot(x, y, z, w) || 1;
    ring.rotationQuaternion.set(x / len, y / len, z / len, w / len);
}

/** @internal Lazily create the laser + cursor meshes for one input source. */
function ensureUnit(pointer: XrPointer, source: DomXrInputSource): PointerUnit {
    const existing = pointer._units.get(source);
    if (existing) {
        return existing;
    }
    const engine = pointer._engine;
    const opts = pointer._options;

    // Unit box scaled per frame to [thickness, thickness, beamLength]; its local Z
    // spans the beam, centred on the ray line.
    const laser = createBox(engine, 1);
    laser.name = "xr-pointer-laser";
    const laserMat = unlitMaterial(opts.laserColor);
    laser.material = laserMat as unknown as Mesh["material"];
    laser.pickable = false;
    laser.receiveShadows = false;
    laser.visible = false;

    // Selection ring (Babylon.js "gazeTracker" torus): a thin flat ring laid on the
    // surface it points at. Double-sided so it reads from either side.
    const cursor = createTorus(engine, {
        diameter: opts.cursorSize,
        thickness: opts.cursorSize * 0.12,
        tessellation: 24,
    });
    cursor.name = "xr-pointer-cursor";
    const cursorMat = unlitMaterial(opts.cursorColor, true);
    cursor.material = cursorMat as unknown as Mesh["material"];
    cursor.pickable = false;
    cursor.receiveShadows = false;
    cursor.visible = false;

    addToScene(pointer._scene, laser);
    addToScene(pointer._scene, cursor);

    const unit: PointerUnit = { laser, cursor, laserMat, cursorMat, hovered: null, lastInput: null, picked: false, wasSelecting: false };
    pointer._units.set(source, unit);
    return unit;
}

/** @internal Dispose one unit's meshes and remove them from the scene. */
function disposeUnit(pointer: XrPointer, unit: PointerUnit): void {
    if (unit.hovered) {
        // The source is disconnecting; hand the callback the last real input we saw for
        // this unit (a hover can only have been set while it was live, so this is set).
        if (unit.lastInput) {
            pointer._options.onHoverEnd?.(unit.hovered, unit.lastInput);
        }
        unit.hovered = null;
    }
    removeFromScene(pointer._scene, unit.laser);
    removeFromScene(pointer._scene, unit.cursor);
    disposeMeshGpu(unit.laser);
    disposeMeshGpu(unit.cursor);
}

/**
 * Update every controller pointer for the current frame: cast each tracked target
 * ray, stretch the laser to the hit, place the cursor, and fire hover/select
 * callbacks. Call once per XR frame (e.g. from `enterXr`'s `onFrame`), after
 * {@link updateXrInputPoses} has refreshed the input poses.
 */
export function updateXrPointer(pointer: XrPointer, input: XrInputManager, eyePosition?: readonly [number, number, number] | null): void {
    const opts = pointer._options;
    const scene = pointer._scene;
    const seen = new Set<DomXrInputSource>();
    const singleActive = !opts.enableOnAllControllers;

    // Pass 1: make sure every tracked source has visuals and is marked seen.
    for (const src of input.inputSources) {
        seen.add(src.source);
        ensureUnit(pointer, src.source);
    }

    // Pass 2 (single-active only): move focus to whichever controller just pressed its
    // trigger, so clicking with the "other" hand hands the pointer over — like Babylon.js.
    // Read the PREVIOUS frame's `wasSelecting` here (the render loop updates it below), so a
    // rising edge is a fresh press. The claiming press itself must not also select a mesh.
    let justSwitched: DomXrInputSource | null = null;
    if (singleActive && !opts.disableSwitchOnClick) {
        for (const src of input.inputSources) {
            const unit = pointer._units.get(src.source)!;
            if (src.selecting && !unit.wasSelecting && src.source !== pointer._activeSource) {
                pointer._activeSource = src.source;
                justSwitched = src.source;
            }
        }
    }

    // Pass 3 (single-active only): if there's no valid active controller yet, pick one by
    // preferred handedness, else the first tracked source.
    if (singleActive) {
        const stillPresent = pointer._activeSource !== null && seen.has(pointer._activeSource);
        if (!stillPresent) {
            pointer._activeSource = null;
            const pref = opts.preferredHandedness;
            let fallback: DomXrInputSource | null = null;
            for (const src of input.inputSources) {
                fallback ??= src.source;
                if (pref !== undefined && src.handedness === pref) {
                    pointer._activeSource = src.source;
                    break;
                }
            }
            pointer._activeSource ??= fallback;
        }
    }

    for (const src of input.inputSources) {
        const unit = pointer._units.get(src.source)!;
        unit.lastInput = src;
        const isActive = !singleActive || src.source === pointer._activeSource;

        // Inactive controllers (single-active mode) and untracked rays show no pointer.
        if (!isActive || !src.targetRayTracked) {
            setSubtreeVisible(unit.laser, false);
            setSubtreeVisible(unit.cursor, false);
            if (unit.hovered) {
                opts.onHoverEnd?.(unit.hovered, src);
                unit.hovered = null;
            }
            unit.wasSelecting = src.selecting;
            continue;
        }

        const m = src.targetRayMatrix as unknown as Mat4;
        const origin: [number, number, number] = [m[12]!, m[13]!, m[14]!];
        // Target-ray forward is the matrix's −Z basis column (normalised for safety).
        let fx = -m[8]!,
            fy = -m[9]!,
            fz = -m[10]!;
        const flen = Math.hypot(fx, fy, fz) || 1;
        fx /= flen;
        fy /= flen;
        fz /= flen;
        const forward: [number, number, number] = [fx, fy, fz];

        const info = pickWithRay(scene, { origin, direction: forward, length: opts.maxLength }, { predicate: opts.predicate });
        // Ignore hits at (near) zero distance: those happen when the ray origin sits
        // inside a mesh's bounding box (e.g. a cube floating around the controller),
        // which would otherwise pin the cursor to the controller and never release.
        const hit = info.hit && info.distance > MIN_PICK_DISTANCE;
        const hitMesh = hit ? (info.pickedMesh as Mesh | null) : null;
        const visual = computePointerVisual(origin, forward, hit ? info.distance : -1, opts.maxLength);

        // Laser: oriented by the target-ray rotation, centred on the beam, scaled to length.
        const rot = mat4Decompose(m).rotation;
        unit.laser.rotationQuaternion.set(rot.x, rot.y, rot.z, rot.w);
        unit.laser.position.set(visual.laserPosition[0], visual.laserPosition[1], visual.laserPosition[2]);
        unit.laser.scaling.set(opts.laserThickness, opts.laserThickness, visual.beamLength);
        setSubtreeVisible(unit.laser, true);

        // Selection ring: laid flat on the hit surface (hole axis along the surface
        // normal) and sized so it keeps a constant *apparent* size — its world size
        // scales with the distance from the viewer's eye to the hit, not from the
        // controller, so a near and a far target look the same on screen. A small
        // distance-proportional nudge off the surface avoids z-fighting the coplanar
        // ring against the face. Hidden entirely on a miss.
        if (visual.hit) {
            const hp = visual.cursorPosition;
            const refDist = eyePosition ? Math.hypot(hp[0] - eyePosition[0], hp[1] - eyePosition[1], hp[2] - eyePosition[2]) || info.distance : info.distance;
            const off = 0.003 * refDist;
            const n = (info.pickedNormalWorld as [number, number, number] | null) ?? [-fx, -fy, -fz];
            unit.cursor.position.set(hp[0] + n[0] * off, hp[1] + n[1] * off, hp[2] + n[2] * off);
            unit.cursor.scaling.set(refDist, refDist, refDist);
            orientRingToDir(unit.cursor, n);
            setSubtreeVisible(unit.cursor, true);
        } else {
            setSubtreeVisible(unit.cursor, false);
        }

        // Picked-state colours: brighten the laser and turn the ring blue while pointing
        // at a mesh (Babylon.js picked vs. default colours), plain otherwise. Runtime
        // emissive edits must mark the material UBO dirty or they never reach the GPU.
        const picked = hitMesh !== null;
        if (picked !== unit.picked) {
            const lc = picked ? opts.laserPickedColor : opts.laserColor;
            const cc = picked ? opts.cursorPickedColor : opts.cursorColor;
            unit.laserMat.emissiveColor = [lc[0], lc[1], lc[2]];
            unit.cursorMat.emissiveColor = [cc[0], cc[1], cc[2]];
            markMaterialUboDirty(unit.laserMat);
            markMaterialUboDirty(unit.cursorMat);
            unit.picked = picked;
        }

        // Hover transitions.
        if (hitMesh !== unit.hovered) {
            if (unit.hovered) {
                opts.onHoverEnd?.(unit.hovered, src);
            }
            if (hitMesh) {
                opts.onHoverStart?.(hitMesh, src);
            }
            unit.hovered = hitMesh;
        }

        // Select (trigger) rising edge while hovering a mesh — but the press that just
        // claimed focus for this controller is consumed by the switch, not a selection.
        if (src.selecting && !unit.wasSelecting && hitMesh && src.source !== justSwitched) {
            opts.onSelect?.(hitMesh, info, src);
        }
        unit.wasSelecting = src.selecting;
    }

    // Retire visuals for sources that disconnected since the last frame.
    for (const [source, unit] of pointer._units) {
        if (!seen.has(source)) {
            disposeUnit(pointer, unit);
            pointer._units.delete(source);
        }
    }
    if (pointer._activeSource !== null && !seen.has(pointer._activeSource)) {
        pointer._activeSource = null;
    }
}

/** Dispose all pointer visuals and detach them from the scene. */
export function disposeXrPointer(pointer: XrPointer): void {
    for (const unit of pointer._units.values()) {
        disposeUnit(pointer, unit);
    }
    pointer._units.clear();
}

/**
 * Controller pointer-selection as an opt-in {@link XrFeatureSpec} (Babylon.js
 * `POINTER_SELECTION`). Pass it to `enterXr({ features: [pointerSelection(...)] })`
 * and the session creates the laser/cursor visuals, casts each tracked ray per
 * frame, and disposes everything on exit — no manual `onFrame`/`onEnd` wiring.
 *
 * Requires input tracking (do not pass `input: false` to {@link enterXr}); it needs
 * no native WebXR session feature.
 *
 * @param options - Pointer appearance + hover/select callbacks (see {@link XrPointerOptions}).
 */
export function pointerSelection(options: XrPointerOptions = {}): XrFeatureSpec {
    return {
        create(ctx) {
            if (!ctx.input) {
                throw new Error("pointerSelection requires XR input tracking; do not pass input:false to enterXr.");
            }
            const input = ctx.input;
            const pointer = createXrPointer(ctx.engine, ctx.scene, options);
            return {
                update(frame): void {
                    const pose = frame.getViewerPose?.(ctx.referenceSpace);
                    const p = pose?.transform.position;
                    const eye: [number, number, number] | null = p ? [p.x, p.y, -p.z] : null;
                    updateXrPointer(pointer, input, eye);
                },
                dispose(): void {
                    disposeXrPointer(pointer);
                },
            };
        },
    };
}
