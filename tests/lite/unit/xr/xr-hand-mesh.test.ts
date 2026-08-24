import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the GPU/loader-touching collaborators; the rig-name mapping, bone resolution,
// per-frame pose loop, and reveal/dispose bookkeeping run for real.
const { loadGltf } = vi.hoisted(() => ({ loadGltf: vi.fn() }));
vi.mock("../../../../packages/babylon-lite/src/loader-gltf/load-gltf", () => ({ loadGltf }));
const { enableBoneControl, getBoneByName, setBoneWorldPoseDeferred, bakeSkeleton } = vi.hoisted(() => ({
    enableBoneControl: vi.fn(),
    getBoneByName: vi.fn(),
    setBoneWorldPoseDeferred: vi.fn(),
    bakeSkeleton: vi.fn(),
}));
vi.mock("../../../../packages/babylon-lite/src/skeleton/bone-control", () => ({ enableBoneControl, getBoneByName, setBoneWorldPoseDeferred, bakeSkeleton }));
const { getContainerMeshes } = vi.hoisted(() => ({ getContainerMeshes: vi.fn(() => []) }));
vi.mock("../../../../packages/babylon-lite/src/asset-container", () => ({ getContainerMeshes }));
vi.mock("../../../../packages/babylon-lite/src/material/standard/create-standard-material", () => ({
    createStandardMaterial: vi.fn(() => ({ diffuseColor: [0, 0, 0], alpha: 1 })),
}));
const { enableStandardSkeleton, whenStandardMeshFeaturesReady } = vi.hoisted(() => ({
    enableStandardSkeleton: vi.fn(),
    whenStandardMeshFeaturesReady: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../../../packages/babylon-lite/src/material/standard/enable-standard-mesh-features", () => ({ enableStandardSkeleton, whenStandardMeshFeaturesReady }));
const { addToScene } = vi.hoisted(() => ({ addToScene: vi.fn() }));
vi.mock("../../../../packages/babylon-lite/src/scene/scene-core", () => ({ addToScene }));
const { removeFromScene } = vi.hoisted(() => ({ removeFromScene: vi.fn() }));
vi.mock("../../../../packages/babylon-lite/src/scene/scene-remove", () => ({ removeFromScene }));
const { setSubtreeVisible } = vi.hoisted(() => ({
    setSubtreeVisible: vi.fn((n: { visible?: boolean }, v: boolean) => {
        n.visible = v;
    }),
}));
vi.mock("../../../../packages/babylon-lite/src/scene/visibility", () => ({ setSubtreeVisible }));
// enable-mirrored-meshes is dynamic-imported inside loadHandMesh.
const { enableMirroredMeshes } = vi.hoisted(() => ({ enableMirroredMeshes: vi.fn(async () => {}) }));
vi.mock("../../../../packages/babylon-lite/src/mesh/enable-mirrored-meshes", () => ({ enableMirroredMeshes }));

import { loadHandMesh, poseHandMesh, disposeHandMesh } from "../../../../packages/babylon-lite/src/xr/xr-hand-mesh";
import type { LoadedHandMesh, HandMeshOptions } from "../../../../packages/babylon-lite/src/xr/xr-hand-mesh";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene";

const OPTS: HandMeshOptions = {
    baseUrl: "https://cdn.example/HandMeshes/",
    leftFilename: "l_hand_rhs.glb",
    rightFilename: "r_hand_rhs.glb",
    color: [0.4, 0.2, 0.8],
    alpha: 0.65,
};

function vec(x = 0, y = 0, z = 0) {
    return {
        x,
        y,
        z,
        set(nx: number, ny: number, nz: number) {
            this.x = nx;
            this.y = ny;
            this.z = nz;
        },
    };
}

/** A fake glTF container root with a mirror (-1 X) scaling like the real loader applies. */
function fakeRoot() {
    return { scaling: vec(-1, 1, 1), visible: false };
}

/** A fake skeleton whose getBoneByName returns a bone tagged with its name. */
function fakeContainer(root: ReturnType<typeof fakeRoot>, skeleton: unknown) {
    return { entities: [root], skeletons: skeleton ? [skeleton] : undefined };
}

beforeEach(() => {
    loadGltf.mockReset();
    enableBoneControl.mockClear();
    getBoneByName.mockReset();
    setBoneWorldPoseDeferred.mockClear();
    bakeSkeleton.mockClear();
    getContainerMeshes.mockReset();
    getContainerMeshes.mockReturnValue([]);
    addToScene.mockClear();
    removeFromScene.mockClear();
    setSubtreeVisible.mockClear();
    enableMirroredMeshes.mockClear();
});

describe("loadHandMesh", () => {
    it("enables bone control before loading, fetches the handedness GLB, and resolves 25 bones", async () => {
        const root = fakeRoot();
        const skeleton = { tag: "skel" };
        loadGltf.mockResolvedValue(fakeContainer(root, skeleton));
        getBoneByName.mockImplementation((_s: unknown, name: string) => ({ name }));

        const loaded = await loadHandMesh({} as EngineContext, {} as SceneContext, "right", OPTS);

        expect(enableBoneControl).toHaveBeenCalled();
        // The hand GLB is skinned + gets a Standard material, so Standard skinning must
        // be enabled or it would render frozen at bind pose.
        expect(enableStandardSkeleton).toHaveBeenCalled();
        // Right-hand GLB URL resolved against the base.
        expect(loadGltf).toHaveBeenCalledWith(expect.anything(), "https://cdn.example/HandMeshes/r_hand_rhs.glb");
        expect(loaded).not.toBeNull();
        expect(loaded!.bones.size).toBe(25);
        // Names carry the right-hand suffix and the Babylon rig conventions.
        expect(loaded!.bones.get("wrist" as XRHandJoint)!.name).toBe("wrist_R");
        expect(loaded!.bones.get("pinky-finger-tip" as XRHandJoint)!.name).toBe("little_tip_R");
        expect(loaded!.bones.get("index-finger-phalanx-intermediate" as XRHandJoint)!.name).toBe("index_intPhalanx_R");
    });

    it("uses the left GLB + _L suffix for the left hand", async () => {
        loadGltf.mockResolvedValue(fakeContainer(fakeRoot(), { tag: "skel" }));
        getBoneByName.mockImplementation((_s: unknown, name: string) => ({ name }));
        const loaded = await loadHandMesh({} as EngineContext, {} as SceneContext, "left", OPTS);
        expect(loadGltf).toHaveBeenCalledWith(expect.anything(), "https://cdn.example/HandMeshes/l_hand_rhs.glb");
        expect(loaded!.bones.get("thumb-tip" as XRHandJoint)!.name).toBe("thumb_tip_L");
    });

    it("keeps the loader's LH conversion and hides the mesh until first pose", async () => {
        const root = fakeRoot();
        loadGltf.mockResolvedValue(fakeContainer(root, { tag: "skel" }));
        getBoneByName.mockImplementation((_s: unknown, name: string) => ({ name }));
        await loadHandMesh({} as EngineContext, {} as SceneContext, "right", OPTS);
        expect(root.scaling.x).toBe(-1);
        expect(enableMirroredMeshes).toHaveBeenCalled();
        expect(addToScene).toHaveBeenCalled();
        expect(root.visible).toBe(false);
    });

    it("awaits the skinning ext registration before adding the mesh, so a late add isn't built at bind pose", async () => {
        const root = fakeRoot();
        loadGltf.mockResolvedValue(fakeContainer(root, { tag: "skel" }));
        getBoneByName.mockImplementation((_s: unknown, name: string) => ({ name }));
        let resolveReady!: () => void;
        whenStandardMeshFeaturesReady.mockReturnValueOnce(new Promise<void>((r) => (resolveReady = r)));
        addToScene.mockClear();

        const pending = loadHandMesh({} as EngineContext, {} as SceneContext, "right", OPTS);
        await Promise.resolve();
        // Ext not registered yet → the mesh must NOT have been added to the scene.
        expect(addToScene).not.toHaveBeenCalled();
        resolveReady();
        await pending;
        expect(whenStandardMeshFeaturesReady).toHaveBeenCalled();
        expect(addToScene).toHaveBeenCalled();
    });

    it("returns null when the model has no skeleton (bone control unavailable)", async () => {
        loadGltf.mockResolvedValue(fakeContainer(fakeRoot(), null));
        const loaded = await loadHandMesh({} as EngineContext, {} as SceneContext, "right", OPTS);
        expect(loaded).toBeNull();
    });

    it("skips bones the GLB rig doesn't contain", async () => {
        loadGltf.mockResolvedValue(fakeContainer(fakeRoot(), { tag: "skel" }));
        getBoneByName.mockImplementation((_s: unknown, name: string) => (name === "wrist_R" ? { name } : undefined));
        const loaded = await loadHandMesh({} as EngineContext, {} as SceneContext, "right", OPTS);
        expect(loaded!.bones.size).toBe(1);
        expect(loaded!.bones.get("wrist" as XRHandJoint)!.name).toBe("wrist_R");
    });
});

describe("poseHandMesh", () => {
    function loaded(bones: Map<string, { name: string }>): LoadedHandMesh {
        return {
            container: {} as never,
            root: { visible: false } as never,
            skeleton: { tag: "skel" } as never,
            bones: bones as never,
            shown: false,
        };
    }
    function frameWith(poseFor: (name: string) => { x: number; y: number; z: number } | null, hasJointPose = true): XRFrame {
        return {
            getJointPose: hasJointPose
                ? (space: { name: string }) => {
                      const p = poseFor(space.name);
                      if (!p) return undefined;
                      return { transform: { position: { x: p.x, y: p.y, z: p.z }, orientation: { x: 0.1, y: 0.2, z: 0.3, w: 0.9 } } };
                  }
                : undefined,
        } as unknown as XRFrame;
    }
    // A fake XRHand: joint name → a joint space carrying the same name.
    function hand(names: string[]): XRHand {
        const m = new Map<string, { name: string }>();
        for (const n of names) m.set(n, { name: n });
        return m as unknown as XRHand;
    }

    it("poses each mapped bone from its joint pose and bakes once, revealing the mesh", () => {
        const bones = new Map([
            ["wrist", { name: "wrist_R" }],
            ["thumb-tip", { name: "thumb_tip_R" }],
        ]);
        const l = loaded(bones);
        const frame = frameWith((name) => (name === "wrist" ? { x: 1, y: 2, z: 3 } : { x: 4, y: 5, z: 6 }));
        const ok = poseHandMesh(l, hand(["wrist", "thumb-tip"]), frame, {} as XRReferenceSpace);

        expect(ok).toBe(true);
        expect(setBoneWorldPoseDeferred).toHaveBeenCalledTimes(2);
        expect(setBoneWorldPoseDeferred).toHaveBeenCalledWith(expect.anything(), { name: "wrist_R" }, 1, 2, -3, 0.1, 0.2, -0.3, -0.9);
        expect(bakeSkeleton).toHaveBeenCalledTimes(1); // single bake for the whole hand
        expect((l.root as unknown as { visible: boolean }).visible).toBe(true);
        expect(l.shown).toBe(true);
    });

    it("skips joints without a pose this frame and still bakes the rest", () => {
        const bones = new Map([
            ["wrist", { name: "wrist_R" }],
            ["thumb-tip", { name: "thumb_tip_R" }],
        ]);
        const frame = frameWith((name) => (name === "thumb-tip" ? null : { x: 0, y: 0, z: 0 }));
        const ok = poseHandMesh(loaded(bones), hand(["wrist", "thumb-tip"]), frame, {} as XRReferenceSpace);
        expect(ok).toBe(true);
        expect(setBoneWorldPoseDeferred).toHaveBeenCalledTimes(1); // only the wrist
        expect(bakeSkeleton).toHaveBeenCalledTimes(1);
    });

    it("does nothing on a runtime without getJointPose", () => {
        const bones = new Map([["wrist", { name: "wrist_R" }]]);
        const ok = poseHandMesh(
            loaded(bones),
            hand(["wrist"]),
            frameWith(() => ({ x: 0, y: 0, z: 0 }), false),
            {} as XRReferenceSpace
        );
        expect(ok).toBe(false);
        expect(setBoneWorldPoseDeferred).not.toHaveBeenCalled();
        expect(bakeSkeleton).not.toHaveBeenCalled();
    });

    it("does not re-bake when no joint of the hand is present", () => {
        const bones = new Map([["wrist", { name: "wrist_R" }]]);
        const ok = poseHandMesh(
            loaded(bones),
            hand([]),
            frameWith(() => ({ x: 0, y: 0, z: 0 })),
            {} as XRReferenceSpace
        );
        expect(ok).toBe(false);
        expect(bakeSkeleton).not.toHaveBeenCalled();
    });

    it("hides a previously shown mesh when every joint loses tracking", () => {
        const bones = new Map([["wrist", { name: "wrist_R" }]]);
        const l = loaded(bones);
        l.shown = true;
        (l.root as unknown as { visible: boolean }).visible = true;

        const ok = poseHandMesh(
            l,
            hand(["wrist"]),
            frameWith(() => null),
            {} as XRReferenceSpace
        );

        expect(ok).toBe(false);
        expect((l.root as unknown as { visible: boolean }).visible).toBe(false);
        expect(l.shown).toBe(false);
    });
});

describe("disposeHandMesh", () => {
    it("removes the container from the scene", () => {
        const container = { tag: "container" };
        disposeHandMesh({} as SceneContext, { container } as unknown as LoadedHandMesh);
        expect(removeFromScene).toHaveBeenCalledWith(expect.anything(), container);
    });
});
