import { describe, it, expect, vi } from "vitest";

// Stub the GPU-touching bits (mesh creation + material + scene attach/dispose). The
// grip-pose placement math (mat4Decompose) and the connect/disconnect bookkeeping
// run for real.
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
        position: vec(0, 0, 0),
        scaling: vec(1, 1, 1),
        rotationQuaternion: vec(0, 0, 0, 1),
    };
}

const { createBox } = vi.hoisted(() => ({ createBox: vi.fn(() => fakeMesh()) }));
vi.mock("../../../../packages/babylon-lite/src/mesh/mesh-factories", () => ({ createBox }));
vi.mock("../../../../packages/babylon-lite/src/material/standard/create-standard-material", () => ({
    createStandardMaterial: vi.fn(() => ({ diffuseColor: [0, 0, 0] })),
}));
const { addToScene, removeFromScene, loadMotionController, enableMirroredMeshes, getContainerMeshes } = vi.hoisted(() => ({
    addToScene: vi.fn(),
    removeFromScene: vi.fn(),
    loadMotionController: vi.fn(),
    enableMirroredMeshes: vi.fn(),
    getContainerMeshes: vi.fn(() => []),
}));
vi.mock("../../../../packages/babylon-lite/src/scene/scene-core", () => ({ addToScene }));
vi.mock("../../../../packages/babylon-lite/src/scene/scene-remove", () => ({ removeFromScene }));
vi.mock("../../../../packages/babylon-lite/src/xr/xr-motion-controller", () => ({ loadMotionController, updateMotionController: vi.fn() }));
vi.mock("../../../../packages/babylon-lite/src/mesh/enable-mirrored-meshes", () => ({ enableMirroredMeshes }));
vi.mock("../../../../packages/babylon-lite/src/asset-container", () => ({ getContainerMeshes }));
const { disposeMeshGpu } = vi.hoisted(() => ({ disposeMeshGpu: vi.fn() }));
vi.mock("../../../../packages/babylon-lite/src/mesh/mesh-dispose", () => ({ disposeMeshGpu }));
const { setSubtreeVisible, markMaterialUboDirty } = vi.hoisted(() => ({
    setSubtreeVisible: vi.fn((node: { visible: boolean }, visible: boolean) => {
        node.visible = visible;
    }),
    markMaterialUboDirty: vi.fn(),
}));
vi.mock("../../../../packages/babylon-lite/src/scene/visibility", () => ({ setSubtreeVisible }));
vi.mock("../../../../packages/babylon-lite/src/material/material-dirty", () => ({ markMaterialUboDirty }));

import { createXrControllerModels, updateXrControllerModels, disposeXrControllerModels, controllerModels } from "../../../../packages/babylon-lite/src/xr/xr-controller-models";
import type { XrControllerModels } from "../../../../packages/babylon-lite/src/xr/xr-controller-models";
import type { XrSessionContext } from "../../../../packages/babylon-lite/src/xr/xr-session";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine";
import type { XrInputManager, XrInputSource } from "../../../../packages/babylon-lite/src/xr/xr-input";
import { createSceneNode } from "../../../../packages/babylon-lite/src/scene/scene-node";
import { mat4Compose } from "../../../../packages/babylon-lite/src/math/mat4-compose";

const engine = {} as EngineContext;
const scene = {} as SceneContext;

/** Column-major translation-only grip pose (identity rotation). */
function gripPose(tx: number, ty: number, tz: number): Float32Array {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    m[12] = tx;
    m[13] = ty;
    m[14] = tz;
    return m;
}

function makeSource(gripMatrix: Float32Array, gripTracked = true, handedness: "left" | "right" = "right"): XrInputSource {
    return { source: {} as XRInputSource, handedness, gripMatrix, gripTracked } as unknown as XrInputSource;
}

function makeInput(sources: XrInputSource[]): XrInputManager {
    return { inputSources: sources } as unknown as XrInputManager;
}

function unitOf(models: XrControllerModels, src: XrInputSource) {
    return (models as unknown as { _units: Map<unknown, { mesh: ReturnType<typeof fakeMesh> }> })._units.get((src as unknown as { source: unknown }).source)!;
}

describe("controller models", () => {
    it("creates one mesh per source and places it at the grip pose", () => {
        const models = createXrControllerModels(engine, scene);
        const src = makeSource(gripPose(1, 2, 3));
        updateXrControllerModels(models, makeInput([src]));

        const unit = unitOf(models, src);
        expect(unit).toBeTruthy();
        expect(unit.mesh.position).toMatchObject({ x: 1, y: 2, z: 3 });
        // Identity rotation → identity quaternion.
        expect(unit.mesh.rotationQuaternion).toMatchObject({ x: 0, y: 0, z: 0, w: 1 });
        expect(unit.mesh.visible).toBe(true);
    });

    it("reuses the same mesh across frames for a persistent source", () => {
        const models = createXrControllerModels(engine, scene);
        const src = makeSource(gripPose(0, 0, 0));
        updateXrControllerModels(models, makeInput([src]));
        const first = unitOf(models, src).mesh;
        updateXrControllerModels(models, makeInput([src]));
        expect(unitOf(models, src).mesh).toBe(first);
    });

    it("does not reapply unchanged tracked visibility", () => {
        setSubtreeVisible.mockClear();
        const models = createXrControllerModels(engine, scene);
        const src = makeSource(gripPose(0, 0, 0));

        updateXrControllerModels(models, makeInput([src]));
        updateXrControllerModels(models, makeInput([src]));

        expect(setSubtreeVisible).toHaveBeenCalledOnce();
        expect(setSubtreeVisible).toHaveBeenCalledWith(unitOf(models, src).mesh, true);
    });

    it("hides the mesh while the grip is untracked", () => {
        setSubtreeVisible.mockClear();
        const models = createXrControllerModels(engine, scene);
        const src = makeSource(gripPose(1, 1, 1), false);
        updateXrControllerModels(models, makeInput([src]));
        expect(unitOf(models, src).mesh.visible).toBe(false);
        expect(setSubtreeVisible).toHaveBeenCalledWith(unitOf(models, src).mesh, false);
    });

    it("dirties the loading placeholder material after pulsing it", () => {
        markMaterialUboDirty.mockClear();
        const models = createXrControllerModels(engine, scene, { profiles: true });
        const src = makeSource(gripPose(0, 0, 0));

        updateXrControllerModels(models, makeInput([src]));

        expect(markMaterialUboDirty).toHaveBeenCalledOnce();
    });

    it("disposes a source's mesh when it disconnects", () => {
        const models = createXrControllerModels(engine, scene);
        const src = makeSource(gripPose(0, 0, 0));
        updateXrControllerModels(models, makeInput([src]));
        expect(models._units.size).toBe(1);
        // Source gone this frame → retired.
        updateXrControllerModels(models, makeInput([]));
        expect(models._units.size).toBe(0);
        expect(disposeMeshGpu).toHaveBeenCalled();
    });

    it("uses a custom meshFactory when provided", () => {
        const custom = fakeMesh();
        const factory = vi.fn(() => custom as unknown as ReturnType<typeof fakeMesh>);
        const models = createXrControllerModels(engine, scene, { meshFactory: factory as never });
        const src = makeSource(gripPose(0, 0, 0), true, "left");
        updateXrControllerModels(models, makeInput([src]));
        expect(factory).toHaveBeenCalledWith(engine, scene, "left");
        expect(unitOf(models, src).mesh).toBe(custom);
    });

    it("disposeXrControllerModels clears every unit", () => {
        const models = createXrControllerModels(engine, scene);
        updateXrControllerModels(models, makeInput([makeSource(gripPose(0, 0, 0))]));
        disposeXrControllerModels(models);
        expect(models._units.size).toBe(0);
    });

    it("does not attach a profile model when the source retires during the final import", async () => {
        addToScene.mockClear();
        removeFromScene.mockClear();
        loadMotionController.mockReset();
        enableMirroredMeshes.mockReset();
        const root = fakeMesh();
        root.scaling.x = -1;
        const container = { tag: "controller-model" };
        loadMotionController.mockResolvedValue({ root, container });
        let finishMirrored!: () => void;
        enableMirroredMeshes.mockReturnValue(new Promise<void>((resolve) => (finishMirrored = resolve)));
        const models = createXrControllerModels(engine, scene, { profiles: true });
        const src = makeSource(gripPose(0, 0, 0));

        updateXrControllerModels(models, makeInput([src]));
        await vi.waitFor(() => expect(models._mod).not.toBeNull());
        updateXrControllerModels(models, makeInput([src]));
        await vi.waitFor(() => expect(enableMirroredMeshes).toHaveBeenCalled());
        updateXrControllerModels(models, makeInput([]));
        finishMirrored();
        await vi.waitFor(() => expect(removeFromScene).toHaveBeenCalledWith(scene, container));

        expect(addToScene).not.toHaveBeenCalledWith(scene, container);
    });

    it("applies the profile-model LH yaw while preserving the glTF root mirror", async () => {
        addToScene.mockClear();
        loadMotionController.mockReset();
        enableMirroredMeshes.mockReset();
        enableMirroredMeshes.mockResolvedValue(undefined);
        const q = [0.2, 0.3, 0.1, Math.sqrt(0.86)] as const;
        const grip = mat4Compose(1, 2, 3, q[0], q[1], q[2], q[3], 1, 1, 1);
        const root = createSceneNode("controller-root", 0, 0, 0, 0, 0, 0, 1, -1, 1, 1);
        const container = { tag: "controller-model" };
        loadMotionController.mockResolvedValue({ root, container });
        const models = createXrControllerModels(engine, scene, { profiles: true });
        const src = makeSource(new Float32Array(grip));

        updateXrControllerModels(models, makeInput([src]));
        await vi.waitFor(() => expect(models._mod).not.toBeNull());
        updateXrControllerModels(models, makeInput([src]));
        await vi.waitFor(() => expect(addToScene).toHaveBeenCalledWith(scene, container));
        updateXrControllerModels(models, makeInput([src]));

        // glTF scale(-X) followed by the Input Profiles yawY(π).
        const local = [0.2, 0.1, 1] as const;
        const tx = 2 * (q[1] * local[2] - q[2] * local[1]);
        const ty = 2 * (q[2] * local[0] - q[0] * local[2]);
        const tz = 2 * (q[0] * local[1] - q[1] * local[0]);
        const expected = [
            1 + local[0] + q[3] * tx + (q[1] * tz - q[2] * ty),
            2 + local[1] + q[3] * ty + (q[2] * tx - q[0] * tz),
            3 + local[2] + q[3] * tz + (q[0] * ty - q[1] * tx),
        ];
        const world = root.worldMatrix;
        const actual = [
            world[0]! * 0.2 + world[4]! * 0.1 - world[8]! + world[12]!,
            world[1]! * 0.2 + world[5]! * 0.1 - world[9]! + world[13]!,
            world[2]! * 0.2 + world[6]! * 0.1 - world[10]! + world[14]!,
        ];

        expect(actual[0]).toBeCloseTo(expected[0]!, 5);
        expect(actual[1]).toBeCloseTo(expected[1]!, 5);
        expect(actual[2]).toBeCloseTo(expected[2]!, 5);
        expect(root.scaling.x).toBe(-1);
    });
});

describe("controllerModels feature", () => {
    it("throws when input tracking is disabled", () => {
        const spec = controllerModels();
        expect(() => spec.create({ engine, scene, input: null } as unknown as XrSessionContext)).toThrow(/input/);
    });

    it("needs no native session feature", () => {
        expect(controllerModels().sessionFeatures).toBeUndefined();
    });

    it("creates, drives, and disposes controller models over a session", () => {
        const src = makeSource(gripPose(2, 0, -1));
        const input = makeInput([src]);
        const spec = controllerModels();
        const handle = spec.create({ engine, scene, input } as unknown as XrSessionContext);

        handle.update!({} as XRFrame, 0);
        // A mesh was created and placed at the grip pose.
        expect(createBox).toHaveBeenCalled();

        handle.dispose!();
        // After dispose the manager holds no units (verified indirectly: a second
        // dispose is a no-op and does not throw).
        expect(() => handle.dispose!()).not.toThrow();
    });
});
