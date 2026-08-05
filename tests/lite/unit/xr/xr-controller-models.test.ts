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
vi.mock("../../../../packages/babylon-lite/src/scene/scene-core", () => ({ addToScene: vi.fn() }));
vi.mock("../../../../packages/babylon-lite/src/scene/scene-remove", () => ({ removeFromScene: vi.fn() }));
const { disposeMeshGpu } = vi.hoisted(() => ({ disposeMeshGpu: vi.fn() }));
vi.mock("../../../../packages/babylon-lite/src/mesh/mesh-dispose", () => ({ disposeMeshGpu }));

import { createXrControllerModels, updateXrControllerModels, disposeXrControllerModels, controllerModels } from "../../../../packages/babylon-lite/src/xr/xr-controller-models";
import type { XrControllerModels } from "../../../../packages/babylon-lite/src/xr/xr-controller-models";
import type { XrSessionContext } from "../../../../packages/babylon-lite/src/xr/xr-session";
import type { SceneContext } from "../../../../packages/babylon-lite/src/scene/scene";
import type { EngineContext } from "../../../../packages/babylon-lite/src/engine/engine";
import type { XrInputManager, XrInputSource } from "../../../../packages/babylon-lite/src/xr/xr-input";

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

    it("hides the mesh while the grip is untracked", () => {
        const models = createXrControllerModels(engine, scene);
        const src = makeSource(gripPose(1, 1, 1), false);
        updateXrControllerModels(models, makeInput([src]));
        expect(unitOf(models, src).mesh.visible).toBe(false);
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
