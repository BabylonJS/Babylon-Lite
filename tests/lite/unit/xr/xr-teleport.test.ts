import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub only the GPU-touching bits (mesh creation + scene attach/dispose + the
// ray pick + pointer-visual helper). The thumbstick reading, floor test,
// reference-space teleport/turn math, and connect/disconnect bookkeeping run for real.
function fakeMesh() {
    const vec = (x: number, y: number, z: number, w?: number) => ({
        x,
        y,
        z,
        w,
        set(nx: number, ny: number, nz: number, nw?: number) {
            this.x = nx;
            this.y = ny;
            this.z = nz;
            if (nw !== undefined) this.w = nw;
        },
    });
    return {
        name: "",
        material: null as unknown,
        pickable: undefined as boolean | undefined,
        receiveShadows: false,
        visible: false,
        children: [] as unknown[],
        position: vec(0, 0, 0),
        scaling: vec(1, 1, 1),
        rotationQuaternion: vec(0, 0, 0, 1),
    };
}

vi.mock("../../../../packages/babylon-lite/src/mesh/mesh-factories", () => ({
    createBox: vi.fn(() => fakeMesh()),
    createTorus: vi.fn(() => fakeMesh()),
}));
vi.mock("../../../../packages/babylon-lite/src/material/standard/create-standard-material", () => ({
    createStandardMaterial: vi.fn(() => ({ diffuseColor: [0, 0, 0], emissiveColor: [0, 0, 0], disableLighting: false })),
}));
vi.mock("../../../../packages/babylon-lite/src/scene/scene-core", () => ({ addToScene: vi.fn() }));
vi.mock("../../../../packages/babylon-lite/src/scene/scene-remove", () => ({ removeFromScene: vi.fn() }));
const { disposeMeshGpu } = vi.hoisted(() => ({ disposeMeshGpu: vi.fn() }));
vi.mock("../../../../packages/babylon-lite/src/mesh/mesh-dispose", () => ({ disposeMeshGpu }));
// setSubtreeVisible is the real "make it actually hide" path; here just mirror the
// boolean onto the mesh so tests can assert visibility.
vi.mock("../../../../packages/babylon-lite/src/scene/visibility", () => ({
    setSubtreeVisible: vi.fn((node: { visible: boolean }, v: boolean) => {
        node.visible = v;
    }),
}));
const { pickWithRay } = vi.hoisted(() => ({ pickWithRay: vi.fn() }));
vi.mock("../../../../packages/babylon-lite/src/picking/ray-pick", () => ({ pickWithRay }));
vi.mock("../../../../packages/babylon-lite/src/xr/xr-pointer", () => ({
    computePointerVisual: vi.fn((_o: unknown, _d: unknown, distance: number, maxLength: number) => ({
        beamLength: distance > 0 ? distance : maxLength,
        laserPosition: [0, 0, 0],
        cursorPosition: [0, 0, 0],
        hit: distance > 0,
    })),
}));
vi.mock("../../../../packages/babylon-lite/src/math/mat4-decompose", () => ({
    mat4Decompose: vi.fn(() => ({ rotation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } })),
}));

import { createXrTeleportation, updateXrTeleportation, disposeXrTeleportation, teleportation } from "../../../../packages/babylon-lite/src/xr/xr-teleport";
import type { XrTeleportation, XrTeleportationOptions } from "../../../../packages/babylon-lite/src/xr/xr-teleport";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene";
import type { Mesh } from "../../../../packages/babylon-lite/src/mesh/mesh";
import type { XrInputManager, XrInputSource } from "../../../../packages/babylon-lite/src/xr/xr-input";
import type { XrSessionContext } from "../../../../packages/babylon-lite/src/xr/xr-session";

// --- Test doubles for the WebXR globals the teleport math touches. ---
let lastTransform: { pos: unknown; orient: unknown } | null = null;
class FakeRigidTransform {
    position: unknown;
    orientation: unknown;
    constructor(pos?: unknown, orient?: unknown) {
        this.position = pos;
        this.orientation = orient;
        lastTransform = { pos, orient };
    }
}
(globalThis as unknown as { XRRigidTransform: unknown }).XRRigidTransform = FakeRigidTransform;

/** A reference space whose getOffsetReferenceSpace returns a fresh sentinel each call. */
function makeRef(tag: string): XRReferenceSpace {
    const ref = {
        tag,
        getOffsetReferenceSpace: vi.fn((t: unknown) => makeRefFrom(`${tag}+off`, t)),
    };
    return ref as unknown as XRReferenceSpace;
}
function makeRefFrom(tag: string, t: unknown): XRReferenceSpace {
    return {
        tag,
        offset: t,
        getOffsetReferenceSpace: vi.fn((tt: unknown) => makeRefFrom(`${tag}+off`, tt)),
    } as unknown as XRReferenceSpace;
}

/** Column-major target-ray matrix: origin at (ox,oy,oz), forward = -Z (identity basis). */
function rayMatrix(ox: number, oy: number, oz: number): Float32Array {
    const m = new Float32Array(16);
    m[0] = 1;
    m[5] = 1;
    m[10] = 1;
    m[15] = 1;
    m[12] = ox;
    m[13] = oy;
    m[14] = oz;
    return m;
}

function makeSource(opts: { gamepad?: Partial<Gamepad> | null; tracked?: boolean; ray?: Float32Array; handedness?: string } = {}): XrInputSource {
    return {
        source: { gamepad: opts.gamepad === undefined ? { axes: [0, 0, 0, 0] } : opts.gamepad, handedness: opts.handedness ?? "right" },
        handedness: opts.handedness ?? "right",
        targetRayTracked: opts.tracked ?? true,
        targetRayMatrix: opts.ray ?? rayMatrix(0, 1.5, 0),
    } as unknown as XrInputSource;
}

function makeInput(sources: XrInputSource[]): XrInputManager {
    return { inputSources: sources } as unknown as XrInputManager;
}

/** Viewer pose at (vx,vy,vz). */
function makeFrame(vx = 0, vy = 1.5, vz = 0): XRFrame {
    return {
        getViewerPose: vi.fn(() => ({ transform: { position: { x: vx, y: vy, z: vz } } })),
    } as unknown as XRFrame;
}

function unitFor(tp: XrTeleportation, src: XrInputSource) {
    return (
        tp as unknown as {
            _units: Map<unknown, { laser: ReturnType<typeof fakeMesh>; reticle: ReturnType<typeof fakeMesh>; aiming: boolean; target: number[] | null; turnLatched: boolean }>;
        }
    )._units.get((src as unknown as { source: unknown }).source)!;
}

function make(options: XrTeleportationOptions = {}): XrTeleportation {
    return createXrTeleportation({} as EngineContext, {} as SceneContext, options);
}

const FLOOR = { name: "floor" } as unknown as Mesh;

function floorHit(point: [number, number, number], normal: [number, number, number] = [0, 1, 0], mesh: Mesh = FLOOR) {
    pickWithRay.mockReturnValue({ hit: true, pickedPoint: point, pickedNormalWorld: normal, distance: Math.hypot(...point), pickedMesh: mesh });
}

beforeEach(() => {
    lastTransform = null;
    pickWithRay.mockReset();
    disposeMeshGpu.mockClear();
});

describe("updateXrTeleportation — aiming", () => {
    it("shows the laser and reticle when the thumbstick points forward at floor", () => {
        const tp = make({ floorMeshes: [FLOOR] });
        floorHit([2, 0, -5]);
        const src = makeSource({ gamepad: { axes: [0, 0, 0, -1] } });
        updateXrTeleportation(tp, makeInput([src]), makeFrame(), makeRef("r0"));

        const u = unitFor(tp, src);
        expect(u.aiming).toBe(true);
        expect(u.laser.visible).toBe(true);
        expect(u.reticle.visible).toBe(true);
        expect(u.target).toEqual([2, 0, -5]);
        expect([u.reticle.position.x, u.reticle.position.y, u.reticle.position.z]).toEqual([2, 0, -5]);
    });

    it("shows the laser but hides the reticle when the aim isn't on floor", () => {
        const tp = make({ floorMeshes: [FLOOR] });
        // Hit a non-floor mesh (not in the floor set).
        pickWithRay.mockReturnValue({ hit: true, pickedPoint: [1, 1, -3], pickedNormalWorld: [0, 1, 0], distance: 3, pickedMesh: { name: "wall" } as unknown as Mesh });
        const src = makeSource({ gamepad: { axes: [0, 0, 0, -1] } });
        updateXrTeleportation(tp, makeInput([src]), makeFrame(), makeRef("r0"));

        const u = unitFor(tp, src);
        expect(u.laser.visible).toBe(true);
        expect(u.reticle.visible).toBe(false);
        expect(u.target).toBeNull();
    });

    it("uses the upward-normal fallback when no floor list/predicate is given", () => {
        const tp = make();
        floorHit([0, 0, -4], [0, 1, 0], { name: "anything" } as unknown as Mesh);
        const src = makeSource({ gamepad: { axes: [0, 0, 0, -1] } });
        updateXrTeleportation(tp, makeInput([src]), makeFrame(), makeRef("r0"));
        expect(unitFor(tp, src).reticle.visible).toBe(true);

        // A steep (wall-like) normal is not floor.
        const tp2 = make();
        pickWithRay.mockReturnValue({ hit: true, pickedPoint: [0, 1, -4], pickedNormalWorld: [1, 0, 0], distance: 4, pickedMesh: { name: "wall" } as unknown as Mesh });
        const src2 = makeSource({ gamepad: { axes: [0, 0, 0, -1] } });
        updateXrTeleportation(tp2, makeInput([src2]), makeFrame(), makeRef("r0"));
        expect(unitFor(tp2, src2).reticle.visible).toBe(false);
    });
});

describe("updateXrTeleportation — teleport on release", () => {
    it("offsets the reference space by (viewer − target) when the stick is released", () => {
        const tp = make({ floorMeshes: [FLOOR] });
        floorHit([2, 0, -5]);
        const src = makeSource({ gamepad: { axes: [0, 0, 0, -1] } });
        const ref0 = makeRef("r0");
        // Frame 1: aim.
        updateXrTeleportation(tp, makeInput([src]), makeFrame(0, 1.5, 0), ref0);
        // Frame 2: release (neutral stick) → teleport.
        (src.source.gamepad as unknown as { axes: number[] }).axes = [0, 0, 0, 0];
        const out = updateXrTeleportation(tp, makeInput([src]), makeFrame(0, 1.5, 0), ref0);

        expect((ref0 as unknown as { getOffsetReferenceSpace: ReturnType<typeof vi.fn> }).getOffsetReferenceSpace).toHaveBeenCalledTimes(1);
        // t = viewer(0,1.5,0) − target(2,0,-5), y uses floorY(0) − target.y(0) = 0.
        expect(lastTransform!.pos).toEqual({ x: -2, y: 0, z: 5 });
        // Returned space is the new offset space, not the original.
        expect(out).not.toBe(ref0);
        // Standing floor height updated so the next teleport preserves eye height.
        expect((tp as unknown as { _floorY: number })._floorY).toBe(0);
        // Visuals cleared after teleport.
        expect(unitFor(tp, src).laser.visible).toBe(false);
        expect(unitFor(tp, src).reticle.visible).toBe(false);
    });

    it("does not teleport when released without a valid floor target", () => {
        const tp = make({ floorMeshes: [FLOOR] });
        pickWithRay.mockReturnValue({ hit: false, pickedPoint: null, pickedNormalWorld: null, distance: 0, pickedMesh: null });
        const src = makeSource({ gamepad: { axes: [0, 0, 0, -1] } });
        const ref0 = makeRef("r0");
        updateXrTeleportation(tp, makeInput([src]), makeFrame(), ref0); // aim, no floor
        (src.source.gamepad as unknown as { axes: number[] }).axes = [0, 0, 0, 0];
        const out = updateXrTeleportation(tp, makeInput([src]), makeFrame(), ref0); // release
        expect((ref0 as unknown as { getOffsetReferenceSpace: ReturnType<typeof vi.fn> }).getOffsetReferenceSpace).not.toHaveBeenCalled();
        expect(out).toBe(ref0);
    });
});

describe("updateXrTeleportation — snap turn", () => {
    it("turns once per sideways push and debounces until the stick recenters", () => {
        const tp = make({ rotationAngle: Math.PI / 2 });
        const src = makeSource({ gamepad: { axes: [0, 0, 1, 0] } }); // full right
        const ref0 = makeRef("r0");

        const a = updateXrTeleportation(tp, makeInput([src]), makeFrame(0, 1.5, 0), ref0);
        expect((ref0 as unknown as { getOffsetReferenceSpace: ReturnType<typeof vi.fn> }).getOffsetReferenceSpace).toHaveBeenCalledTimes(1);
        expect(a).not.toBe(ref0);
        // Rotation quaternion about +Y for +90°: y = sin(45°).
        expect((lastTransform!.orient as { y: number }).y).toBeCloseTo(Math.SQRT1_2, 6);

        // Held: still latched → no second turn (drive the returned space, which is fresh).
        updateXrTeleportation(tp, makeInput([src]), makeFrame(0, 1.5, 0), a);
        expect(unitFor(tp, src).turnLatched).toBe(true);

        // Recenter → unlatches.
        (src.source.gamepad as unknown as { axes: number[] }).axes = [0, 0, 0, 0];
        updateXrTeleportation(tp, makeInput([src]), makeFrame(), a);
        expect(unitFor(tp, src).turnLatched).toBe(false);
    });

    it("does not snap-turn when snapTurn is disabled", () => {
        const tp = make({ snapTurn: false });
        const src = makeSource({ gamepad: { axes: [0, 0, 1, 0] } });
        const ref0 = makeRef("r0");
        const out = updateXrTeleportation(tp, makeInput([src]), makeFrame(), ref0);
        expect(out).toBe(ref0);
        expect((ref0 as unknown as { getOffsetReferenceSpace: ReturnType<typeof vi.fn> }).getOffsetReferenceSpace).not.toHaveBeenCalled();
    });
});

describe("updateXrTeleportation — source lifecycle", () => {
    it("skips sources without a gamepad (e.g. tracked hands)", () => {
        const tp = make({ floorMeshes: [FLOOR] });
        const src = makeSource({ gamepad: null });
        updateXrTeleportation(tp, makeInput([src]), makeFrame(), makeRef("r0"));
        expect((tp as unknown as { _units: Map<unknown, unknown> })._units.size).toBe(0);
    });

    it("disposes a controller's visuals when its source disconnects", () => {
        const tp = make({ floorMeshes: [FLOOR] });
        floorHit([0, 0, -3]);
        const src = makeSource({ gamepad: { axes: [0, 0, 0, -1] } });
        updateXrTeleportation(tp, makeInput([src]), makeFrame(), makeRef("r0"));
        expect((tp as unknown as { _units: Map<unknown, unknown> })._units.size).toBe(1);
        updateXrTeleportation(tp, makeInput([]), makeFrame(), makeRef("r0"));
        expect(disposeMeshGpu).toHaveBeenCalledTimes(2); // laser + reticle
        expect((tp as unknown as { _units: Map<unknown, unknown> })._units.size).toBe(0);
    });
});

describe("disposeXrTeleportation", () => {
    it("tears down every controller's laser + reticle", () => {
        const tp = make({ floorMeshes: [FLOOR] });
        floorHit([0, 0, -3]);
        const src = makeSource({ gamepad: { axes: [0, 0, 0, -1] } });
        updateXrTeleportation(tp, makeInput([src]), makeFrame(), makeRef("r0"));
        disposeXrTeleportation(tp);
        expect(disposeMeshGpu).toHaveBeenCalledTimes(2);
        expect((tp as unknown as { _units: Map<unknown, unknown> })._units.size).toBe(0);
    });
});

describe("teleportation feature", () => {
    function makeCtx(input: XrInputManager | null): XrSessionContext {
        return {
            engine: {} as EngineContext,
            scene: {} as SceneContext,
            input,
            _referenceSpace: makeRef("ctx"),
        } as unknown as XrSessionContext;
    }

    it("requires no native session feature", () => {
        expect(teleportation().sessionFeatures).toBeUndefined();
    });

    it("throws when created without input tracking", () => {
        expect(() => teleportation().create(makeCtx(null))).toThrow(/requires XR input/);
    });

    it("adopts the offset reference space onto the context each frame", () => {
        floorHit([1, 0, -2]);
        const src = makeSource({ gamepad: { axes: [0, 0, 1, 0] } }); // snap-turn to force a swap
        const ctx = makeCtx(makeInput([src]));
        const before = (ctx as unknown as { _referenceSpace: XRReferenceSpace })._referenceSpace;
        const handle = teleportation({ floorMeshes: [FLOOR] }).create(ctx);
        handle.update!(makeFrame(), 0);
        const after = (ctx as unknown as { _referenceSpace: XRReferenceSpace })._referenceSpace;
        expect(after).not.toBe(before);
        handle.dispose!();
    });
});
