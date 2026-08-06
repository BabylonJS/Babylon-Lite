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
import type { XrInputManager, XrInputSource } from "./xr-input.js";
import type { XrFeatureSpec } from "./xr-feature.js";
import { mat4Decompose } from "../math/mat4-decompose.js";
import { createBox, createTorus } from "../mesh/mesh-factories.js";
import { createStandardMaterial } from "../material/standard/create-standard-material.js";
import { addToScene } from "../scene/scene-core.js";
import { removeFromScene } from "../scene/scene-remove.js";
import { disposeMeshGpu } from "../mesh/mesh-dispose.js";
import { pickWithRay } from "../picking/ray-pick.js";

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
    _options: Required<Omit<XrPointerOptions, "predicate" | "onHoverStart" | "onHoverEnd" | "onSelect">> &
        Pick<XrPointerOptions, "predicate" | "onHoverStart" | "onHoverEnd" | "onSelect">;
    /** @internal Visuals per DOM input source. */
    _units: Map<DomXrInputSource, PointerUnit>;
}

const DEFAULTS = {
    maxLength: 10,
    laserColor: [0.7, 0.7, 0.7] as [number, number, number],
    laserPickedColor: [0.9, 0.9, 0.9] as [number, number, number],
    cursorColor: [0.8, 0.8, 0.8] as [number, number, number],
    cursorPickedColor: [0.3, 0.3, 1] as [number, number, number],
    laserThickness: 0.004,
    cursorSize: 0.03,
};

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
            predicate: options.predicate,
            onHoverStart: options.onHoverStart,
            onHoverEnd: options.onHoverEnd,
            onSelect: options.onSelect,
        },
        _units: new Map(),
    };
}

/** @internal Build an unlit emissive material for a pointer visual. */
function unlitMaterial(color: [number, number, number], doubleSided = false): StandardMaterialProps {
    const mat = createStandardMaterial();
    mat.diffuseColor = [0, 0, 0];
    mat.emissiveColor = [color[0], color[1], color[2]];
    mat.disableLighting = true;
    if (doubleSided) {
        mat.backFaceCulling = false;
    }
    return mat;
}

/** @internal Orient a torus ring (hole axis = local +Y) to face along `forward`,
 *  i.e. rotate local +Y onto the ray direction via the shortest arc. */
function orientRingToForward(ring: Mesh, forward: [number, number, number]): void {
    const d = forward[1]; // dot((0,1,0), forward)
    if (d < -0.999999) {
        // Antiparallel: 180° about X.
        ring.rotationQuaternion.set(1, 0, 0, 0);
        return;
    }
    // axis = cross((0,1,0), forward) = (fz, 0, -fx); w = 1 + dot.
    const x = forward[2];
    const y = 0;
    const z = -forward[0];
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

    // Selection ring (Babylon.js "gazeTracker" torus): a flat ring placed at the hit
    // point and oriented to face the controller. Double-sided so it reads from behind.
    const cursor = createTorus(engine, {
        diameter: opts.cursorSize,
        thickness: opts.cursorSize * 0.35,
        tessellation: 20,
    });
    cursor.name = "xr-pointer-cursor";
    const cursorMat = unlitMaterial(opts.cursorColor, true);
    cursor.material = cursorMat as unknown as Mesh["material"];
    cursor.pickable = false;
    cursor.receiveShadows = false;
    cursor.visible = false;

    addToScene(pointer._scene, laser);
    addToScene(pointer._scene, cursor);

    const unit: PointerUnit = { laser, cursor, laserMat, cursorMat, hovered: null, picked: false, wasSelecting: false };
    pointer._units.set(source, unit);
    return unit;
}

/** @internal Dispose one unit's meshes and remove them from the scene. */
function disposeUnit(pointer: XrPointer, unit: PointerUnit): void {
    if (unit.hovered) {
        pointer._options.onHoverEnd?.(unit.hovered, undefined as unknown as XrInputSource);
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
export function updateXrPointer(pointer: XrPointer, input: XrInputManager): void {
    const opts = pointer._options;
    const scene = pointer._scene;
    const seen = new Set<DomXrInputSource>();

    for (const src of input.inputSources) {
        seen.add(src.source);
        const unit = ensureUnit(pointer, src.source);

        if (!src.targetRayTracked) {
            unit.laser.visible = false;
            unit.cursor.visible = false;
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
        const hitMesh = info.hit ? (info.pickedMesh as Mesh | null) : null;
        const visual = computePointerVisual(origin, forward, info.hit ? info.distance : -1, opts.maxLength);

        // Laser: oriented by the target-ray rotation, centred on the beam, scaled to length.
        const rot = mat4Decompose(m).rotation;
        unit.laser.rotationQuaternion.set(rot.x, rot.y, rot.z, rot.w);
        unit.laser.position.set(visual.laserPosition[0], visual.laserPosition[1], visual.laserPosition[2]);
        unit.laser.scaling.set(opts.laserThickness, opts.laserThickness, visual.beamLength);
        unit.laser.visible = true;

        // Selection ring at the hit point: scaled with distance (so it keeps a roughly
        // constant apparent size) and rotated to face back along the ray toward the
        // controller. Hidden entirely on a miss.
        if (visual.hit) {
            unit.cursor.position.set(visual.cursorPosition[0], visual.cursorPosition[1], visual.cursorPosition[2]);
            const s = Math.sqrt(info.distance) || 1;
            unit.cursor.scaling.set(s, s, s);
            orientRingToForward(unit.cursor, forward);
            unit.cursor.visible = true;
        } else {
            unit.cursor.visible = false;
        }

        // Picked-state colours: brighten the laser and turn the ring blue while pointing
        // at a mesh (Babylon.js picked vs. default colours), plain otherwise.
        const picked = hitMesh !== null;
        if (picked !== unit.picked) {
            const lc = picked ? opts.laserPickedColor : opts.laserColor;
            const cc = picked ? opts.cursorPickedColor : opts.cursorColor;
            unit.laserMat.emissiveColor = [lc[0], lc[1], lc[2]];
            unit.cursorMat.emissiveColor = [cc[0], cc[1], cc[2]];
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

        // Select (trigger) rising edge while hovering a mesh.
        if (src.selecting && !unit.wasSelecting && hitMesh) {
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
                update(): void {
                    updateXrPointer(pointer, input);
                },
                dispose(): void {
                    disposeXrPointer(pointer);
                },
            };
        },
    };
}
