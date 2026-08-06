import { describe, it, expect, vi } from "vitest";

// Stub only the GPU-touching bits (mesh creation + scene attach/dispose). The
// per-joint placement math and connect/disconnect bookkeeping run for real.
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
    createSphere: vi.fn(() => fakeMesh()),
}));
vi.mock("../../../../packages/babylon-lite/src/material/standard/create-standard-material", () => ({
    createStandardMaterial: vi.fn(() => ({ diffuseColor: [0, 0, 0] })),
}));
vi.mock("../../../../packages/babylon-lite/src/scene/scene-core", () => ({ addToScene: vi.fn() }));
vi.mock("../../../../packages/babylon-lite/src/scene/scene-remove", () => ({ removeFromScene: vi.fn() }));
const { disposeMeshGpu } = vi.hoisted(() => ({ disposeMeshGpu: vi.fn() }));
vi.mock("../../../../packages/babylon-lite/src/mesh/mesh-dispose", () => ({ disposeMeshGpu }));

import { createXrHandTracking, updateXrHandTracking, disposeXrHandTracking, handTracking } from "../../../../packages/babylon-lite/src/xr/xr-hand";
import type { XrHandTracking } from "../../../../packages/babylon-lite/src/xr/xr-hand";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene";
import type { XrInputManager, XrInputSource } from "../../../../packages/babylon-lite/src/xr/xr-input";
import type { XrSessionContext } from "../../../../packages/babylon-lite/src/xr/xr-session";

const JOINTS = ["wrist", "index-finger-tip", "thumb-tip"] as const;

/** A minimal fake XRHand: an ordered map of jointName → a marker joint space. */
function fakeHand(): Map<string, { jointName: string }> {
    const m = new Map<string, { jointName: string }>();
    for (const j of JOINTS) {
        m.set(j, { jointName: j });
    }
    return m;
}

function makeSource(hand: unknown, handedness = "right"): XrInputSource {
    return {
        source: { hand, handedness },
        handedness,
    } as unknown as XrInputSource;
}

function makeInput(sources: XrInputSource[]): XrInputManager {
    return { inputSources: sources } as unknown as XrInputManager;
}

/** Fake frame whose getJointPose returns a per-joint position/radius (or null). */
function makeFrame(poseFor: (jointName: string) => { x: number; y: number; z: number; radius?: number } | null): XRFrame {
    return {
        getJointPose: (space: { jointName: string }) => {
            const p = poseFor(space.jointName);
            if (!p) return undefined;
            return {
                transform: { position: { x: p.x, y: p.y, z: p.z }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
                radius: p.radius,
            };
        },
    } as unknown as XRFrame;
}

const REF = {} as XRReferenceSpace;

function jointsOf(t: XrHandTracking, src: XrInputSource) {
    return (t as unknown as { _units: Map<unknown, { joints: Map<string, ReturnType<typeof fakeMesh>> }> })._units.get((src as unknown as { source: unknown }).source)!.joints;
}

function makeTracking(): XrHandTracking {
    return createXrHandTracking({} as EngineContext, {} as SceneContext);
}

describe("updateXrHandTracking", () => {
    it("creates a sphere per joint and places + sizes it from the joint pose", () => {
        const t = makeTracking();
        const src = makeSource(fakeHand());
        const frame = makeFrame((name) => (name === "index-finger-tip" ? { x: 1, y: 2, z: 3, radius: 0.01 } : { x: 0, y: 0, z: 0, radius: 0.008 }));
        updateXrHandTracking(t, makeInput([src]), frame, REF);

        const joints = jointsOf(t, src);
        expect(joints.size).toBe(JOINTS.length);
        const tip = joints.get("index-finger-tip")!;
        expect(tip.visible).toBe(true);
        expect([tip.position.x, tip.position.y, tip.position.z]).toEqual([1, 2, 3]);
        // World diameter = radius * 2 (jointScale defaults to 1).
        expect(tip.scaling.x).toBeCloseTo(0.02, 6);
    });

    it("hides a joint whose pose is not tracked this frame", () => {
        const t = makeTracking();
        const src = makeSource(fakeHand());
        updateXrHandTracking(
            t,
            makeInput([src]),
            makeFrame(() => ({ x: 0, y: 0, z: 0, radius: 0.01 })),
            REF
        );
        // Next frame: the thumb tip loses tracking.
        updateXrHandTracking(
            t,
            makeInput([src]),
            makeFrame((name) => (name === "thumb-tip" ? null : { x: 0, y: 0, z: 0, radius: 0.01 })),
            REF
        );
        expect(jointsOf(t, src).get("thumb-tip")!.visible).toBe(false);
        expect(jointsOf(t, src).get("wrist")!.visible).toBe(true);
    });

    it("ignores input sources that expose no hand", () => {
        const t = makeTracking();
        const src = makeSource(null);
        updateXrHandTracking(
            t,
            makeInput([src]),
            makeFrame(() => ({ x: 0, y: 0, z: 0 })),
            REF
        );
        expect((t as unknown as { _units: Map<unknown, unknown> })._units.size).toBe(0);
    });

    it("falls back to a default radius when the pose omits one", () => {
        const t = makeTracking();
        const src = makeSource(fakeHand());
        updateXrHandTracking(
            t,
            makeInput([src]),
            makeFrame(() => ({ x: 0, y: 0, z: 0 })),
            REF
        );
        // FALLBACK_RADIUS (0.008) * 2 = 0.016.
        expect(jointsOf(t, src).get("wrist")!.scaling.x).toBeCloseTo(0.016, 6);
    });

    it("disposes a hand's joints when its source disconnects", () => {
        disposeMeshGpu.mockClear();
        const t = makeTracking();
        const src = makeSource(fakeHand());
        updateXrHandTracking(
            t,
            makeInput([src]),
            makeFrame(() => ({ x: 0, y: 0, z: 0, radius: 0.01 })),
            REF
        );
        updateXrHandTracking(
            t,
            makeInput([]),
            makeFrame(() => null),
            REF
        );
        expect(disposeMeshGpu).toHaveBeenCalledTimes(JOINTS.length);
        expect((t as unknown as { _units: Map<unknown, unknown> })._units.size).toBe(0);
    });

    it("is a no-op when the frame lacks getJointPose (unsupported runtime)", () => {
        const t = makeTracking();
        const src = makeSource(fakeHand());
        updateXrHandTracking(t, makeInput([src]), {} as XRFrame, REF);
        // The unit is registered but no joint spheres are created.
        expect(jointsOf(t, src).size).toBe(0);
    });
});

describe("disposeXrHandTracking", () => {
    it("tears down all joint spheres", () => {
        disposeMeshGpu.mockClear();
        const t = makeTracking();
        const src = makeSource(fakeHand());
        updateXrHandTracking(
            t,
            makeInput([src]),
            makeFrame(() => ({ x: 0, y: 0, z: 0, radius: 0.01 })),
            REF
        );
        disposeXrHandTracking(t);
        expect(disposeMeshGpu).toHaveBeenCalledTimes(JOINTS.length);
        expect((t as unknown as { _units: Map<unknown, unknown> })._units.size).toBe(0);
    });
});

describe("handTracking feature", () => {
    function makeCtx(input: XrInputManager | null): XrSessionContext {
        return {
            engine: {} as EngineContext,
            scene: {} as SceneContext,
            referenceSpace: REF,
            input,
        } as unknown as XrSessionContext;
    }

    it("requests the native hand-tracking session feature", () => {
        expect(handTracking().sessionFeatures).toEqual(["hand-tracking"]);
    });

    it("throws when created without input tracking", () => {
        expect(() => handTracking().create(makeCtx(null))).toThrow(/requires XR input/);
    });

    it("creates on create, updates joints on update, tears down on dispose", () => {
        disposeMeshGpu.mockClear();
        const src = makeSource(fakeHand());
        const handle = handTracking().create(makeCtx(makeInput([src])));
        handle.update!(
            makeFrame(() => ({ x: 0, y: 0, z: 0, radius: 0.01 })),
            0
        );
        handle.dispose!();
        expect(disposeMeshGpu).toHaveBeenCalledTimes(JOINTS.length);
    });
});
