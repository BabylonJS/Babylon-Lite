import { describe, expect, it, vi } from "vitest";

import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import { CharacterCollisionObservable, PhysicsCharacterController } from "../../../packages/babylon-lite/src/physics/character-controller";
import { onPhysicsCollision, setPhysicsBodyCollisionEventsEnabled } from "../../../packages/babylon-lite/src/physics/havok-collision";
import { physicsRaycast } from "../../../packages/babylon-lite/src/physics/havok-queries";
import { lockPhysicsBodyRotationAxes, unlockPhysicsBodyRotationAxes } from "../../../packages/babylon-lite/src/physics/havok-rotation-locks";
import { onPhysicsTriggerBodies } from "../../../packages/babylon-lite/src/physics/havok-trigger";
import {
    applyPhysicsBodyImpulse,
    applyPhysicsImpulse,
    createHavokWorld as createBaseHavokWorld,
    createPhysicsAggregate,
    createPhysicsBody,
    disposePhysics,
    enableHavokThinInstancePhysics,
    getPhysicsBodyInstanceCount,
    PhysicsMotionType,
    PhysicsPrestepType,
    PhysicsShapeType,
    onPhysicsAfterStep,
    removePhysicsBody,
    setPhysicsBodyAngularVelocity,
    setPhysicsBodyLinearVelocity,
    setPhysicsBodyMass,
    setPhysicsBodyMotionType,
    setPhysicsBodyPrestepType,
    setPhysicsBodyShape,
    setPhysicsBodyTransform,
} from "../../../packages/babylon-lite/src/physics/havok";
import { setPhysicsBodyMassProperties } from "../../../packages/babylon-lite/src/physics/havok-body-mass-properties";
import { enableHavokThinInstanceAdvancedPhysics } from "../../../packages/babylon-lite/src/physics/havok-thin-instance-advanced";
import { capturePhysicsBodyInstanceResetState, resetPhysicsBodyInstances } from "../../../lab/lite/src/demos/playroom/physics-instances";
import type { PhysicsBody, PhysicsShape } from "../../../packages/babylon-lite/src/physics/havok";

function createHavokWorld(...args: Parameters<typeof createBaseHavokWorld>): ReturnType<typeof createBaseHavokWorld> {
    const world = createBaseHavokWorld(...args);
    enableHavokThinInstanceAdvancedPhysics(world);
    return world;
}

function makeMockHknp() {
    let nextBody = 1;
    const transforms = new Map<number, [number[], number[]]>();
    const bodyShapes = new Map<number, string[]>();
    const massProperties = new Map<number, any[]>();
    const shapeMassProperties = (shape: string[]): any[] =>
        shape[0] === "scaled-shape" ? [[0, 2, 0], 1, [2 / 3, 2 / 3, 2 / 3], [0, 0, 0, 1]] : [[0, 1, 0], 1, [1 / 6, 1 / 6, 1 / 6], [0, 0, 0, 1]];
    return {
        transforms,
        MotionType: { STATIC: 0, KINEMATIC: 1, DYNAMIC: 2 },
        ActivationState: { ACTIVE: 0, INACTIVE: 1 },
        Result: { RESULT_OK: 0 },
        HP_World_Create: vi.fn(() => [0, { id: "world" }]),
        HP_World_SetGravity: vi.fn(),
        HP_World_AddBody: vi.fn(),
        HP_World_RemoveBody: vi.fn(),
        HP_World_Step: vi.fn(),
        HP_World_Release: vi.fn(),
        HP_Body_Create: vi.fn(() => [0, [nextBody++]]),
        HP_Body_SetMotionType: vi.fn(),
        HP_Body_SetLinearVelocity: vi.fn(),
        HP_Body_SetAngularVelocity: vi.fn(),
        HP_Body_SetActivationState: vi.fn(),
        HP_Body_ApplyImpulse: vi.fn(),
        HP_Body_SetQTransform: vi.fn((body: number[], transform: [number[], number[]]) => {
            transforms.set(body[0]!, [transform[0].slice(), transform[1].slice()]);
        }),
        HP_Body_SetTargetQTransform: vi.fn(),
        HP_Body_GetQTransform: vi.fn((body: number[]) => [0, transforms.get(body[0]!)!]),
        HP_Shape_CreateBox: vi.fn(() => [0, ["shape"]]),
        HP_Shape_CreateContainer: vi.fn(() => [0, ["scaled-shape"]]),
        HP_Shape_AddChild: vi.fn(),
        HP_Body_SetShape: vi.fn((body: number[], shape: string[]) => bodyShapes.set(body[0]!, shape)),
        HP_Body_GetShape: vi.fn((body: number[]) => [0, bodyShapes.get(body[0]!) ?? ["shape"]]),
        HP_Shape_BuildMassProperties: vi.fn((shape: string[]) => [0, shapeMassProperties(shape)]),
        HP_Body_SetMassProperties: vi.fn((body: number[], properties: any[]) => {
            massProperties.set(
                body[0]!,
                properties.map((value) => (Array.isArray(value) ? [...value] : value))
            );
        }),
        HP_Body_GetMassProperties: vi.fn((body: number[]) => [0, massProperties.get(body[0]!) ?? shapeMassProperties(bodyShapes.get(body[0]!) ?? ["shape"])]),
        HP_Body_Release: vi.fn(),
        HP_Shape_Release: vi.fn(),
        HP_QueryCollector_Release: vi.fn(),
    };
}

function makeScene(): SceneContext {
    return { _beforeRender: [] } as unknown as SceneContext;
}

function makeThinMesh(): Mesh {
    const matrices = new Float32Array(32);
    matrices[0] = matrices[5] = matrices[10] = matrices[15] = 1;
    matrices[12] = -2;
    matrices[13] = 5;
    matrices[16] = matrices[21] = matrices[26] = matrices[31] = 1;
    matrices[28] = 3;
    matrices[29] = 8;
    return {
        _gpu: {},
        _cpuPositions: new Float32Array(),
        worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        worldMatrixVersion: 0,
        position: { x: 50, y: 60, z: 70, set: vi.fn() },
        rotationQuaternion: { x: 0, y: 0, z: 0, w: 1, set: vi.fn() },
        thinInstances: {
            matrices,
            count: 2,
            _capacity: 2,
            _version: 1,
            _gpuBuffer: null,
            _gpuVersion: 0,
            _dirtyMin: 0,
            _dirtyMax: 2,
            _colorVersion: 0,
            _colorDirtyMin: 0,
            _colorDirtyMax: 0,
            _colorGpuBuffer: null,
            _colorGpuBufferStorage: false,
            _colorGpuVersion: 0,
            _gpuCullingEnabled: false,
        },
    } as unknown as Mesh;
}

function stepFrame(scene: SceneContext): void {
    for (const cb of [...scene._beforeRender]) {
        cb(1000 / 60);
    }
}

function multiplyMatrices(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
    const result = new Array<number>(16);
    for (let column = 0; column < 4; column++) {
        for (let row = 0; row < 4; row++) {
            result[column * 4 + row] = a[row]! * b[column * 4]! + a[row + 4]! * b[column * 4 + 1]! + a[row + 8]! * b[column * 4 + 2]! + a[row + 12]! * b[column * 4 + 3]!;
        }
    }
    return result;
}

function determinant3(matrix: ArrayLike<number>): number {
    return (
        matrix[0]! * (matrix[5]! * matrix[10]! - matrix[6]! * matrix[9]!) +
        matrix[1]! * (matrix[6]! * matrix[8]! - matrix[4]! * matrix[10]!) +
        matrix[2]! * (matrix[4]! * matrix[9]! - matrix[5]! * matrix[8]!)
    );
}

describe("thin-instance physics bodies", () => {
    it("creates one native body per matrix and ignores the carrier mesh transform", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);

        expect(world._hknp).not.toBe(hknp);
        expect(Object.getPrototypeOf(world._hknp)).toBe(hknp);
        expect(getPhysicsBodyInstanceCount(body)).toBe(2);
        expect(hknp.HP_Body_Create).toHaveBeenCalledTimes(2);
        expect(hknp.HP_World_AddBody).toHaveBeenCalledTimes(2);
        expect(Array.from(hknp.transforms.values())).toEqual([
            [
                [-2, 5, 0],
                [0, 0, 0, 1],
            ],
            [
                [3, 8, 0],
                [0, 0, 0, 1],
            ],
        ]);
    });

    it("rejects an empty thin-instance buffer instead of creating an ordinary body", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const mesh = makeThinMesh();
        mesh.thinInstances!.count = 0;

        expect(() => createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC)).toThrow("non-empty matrix buffer");
        expect(hknp.HP_Body_Create).not.toHaveBeenCalled();
    });

    it("validates thin aggregates before allocating an owned shape", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const mesh = makeThinMesh();
        mesh.thinInstances!.count = 0;

        expect(() => createPhysicsAggregate(world, mesh, PhysicsShapeType.BOX, { mass: 1 })).toThrow("non-empty matrix buffer");
        expect(hknp.HP_Shape_CreateBox).not.toHaveBeenCalled();

        mesh.thinInstances!.count = 2;
        Object.assign(world, { _fo: {} });
        expect(() => createPhysicsAggregate(world, mesh, PhysicsShapeType.BOX, { mass: 1 })).toThrow("floating-origin worlds");
        expect(hknp.HP_Shape_CreateBox).not.toHaveBeenCalled();
    });

    it("removes positive and mirrored scale before extracting native body rotations", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const mesh = makeThinMesh();
        const matrices = mesh.thinInstances!.matrices;
        matrices[0] = 0;
        matrices[1] = 2;
        matrices[4] = -2;
        matrices[5] = 0;
        matrices[10] = 2;
        matrices[16] = -2;
        matrices[21] = 2;
        matrices[26] = 2;

        createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC);

        const scaledRotation = hknp.transforms.get(1)![1];
        expect(scaledRotation[0]).toBeCloseTo(0);
        expect(scaledRotation[1]).toBeCloseTo(0);
        expect(scaledRotation[2]).toBeCloseTo(Math.SQRT1_2);
        expect(scaledRotation[3]).toBeCloseTo(Math.SQRT1_2);
        const mirroredRotation = hknp.transforms.get(2)![1];
        expect(mirroredRotation[0]).toBeCloseTo(0);
        expect(mirroredRotation[1]).toBeCloseTo(0);
        expect(mirroredRotation[2]).toBeCloseTo(1);
        expect(mirroredRotation[3]).toBeCloseTo(0);
    });

    it("preserves carrier-world placement and signed instance scale across native write-back", async () => {
        const hknp = makeMockHknp();
        const scene = makeScene();
        const mesh = makeThinMesh();
        mesh.thinInstances!.count = 1;
        Object.defineProperty(mesh, "worldMatrix", { value: new Float32Array([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1]) });
        mesh.thinInstances!.matrices.set([-2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1]);
        const world = createHavokWorld(scene, hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC);
        const nativeIdentity = world._thin!.instance(body, 0);

        expect(hknp.transforms.get(1)![0]).toEqual([4, 25, 37]);

        hknp.transforms.set(1, [
            [8, 9, 10],
            [0, Math.SQRT1_2, 0, Math.SQRT1_2],
        ]);
        stepFrame(scene);

        const effective = multiplyMatrices(mesh.worldMatrix, mesh.thinInstances!.matrices);
        expect(effective.slice(12, 15)).toEqual([8, 9, 10]);
        expect(Math.hypot(effective[0]!, effective[1]!, effective[2]!)).toBeCloseTo(2);
        expect(Math.hypot(effective[4]!, effective[5]!, effective[6]!)).toBeCloseTo(3);
        expect(Math.hypot(effective[8]!, effective[9]!, effective[10]!)).toBeCloseTo(4);
        expect(determinant3(effective)).toBeCloseTo(-24);
        expect([
            effective[0]! + 2 * effective[4]! + 3 * effective[8]! + effective[12]!,
            effective[1]! + 2 * effective[5]! + 3 * effective[9]! + effective[13]!,
            effective[2]! + 2 * effective[6]! + 3 * effective[10]! + effective[14]!,
        ]).toEqual([20, 3, 8]);
        expect(world._thin!.instance(body, 0)).toBe(nativeIdentity);
    });

    it("retains authored sub-picoradian basis components during native write-back", async () => {
        const hknp = makeMockHknp();
        const scene = makeScene();
        const mesh = makeThinMesh();
        mesh.thinInstances!.count = 1;
        const world = createHavokWorld(scene, hknp);
        await enableHavokThinInstancePhysics(world);
        createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC);
        hknp.transforms.set(1, [
            [0, 0, 0],
            [0, 0, 2.5e-13, 1],
        ]);

        stepFrame(scene);

        expect(Math.abs(mesh.thinInstances!.matrices[1]!)).toBeGreaterThan(4.9e-13);
        expect(Math.abs(mesh.thinInstances!.matrices[4]!)).toBeGreaterThan(4.9e-13);
    });

    it("activates thin detection only after explicit enable and validates in the installed seam", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        const mesh = makeThinMesh();

        const ordinary = createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC);
        expect(getPhysicsBodyInstanceCount(ordinary)).toBe(1);

        await enableHavokThinInstancePhysics(world);
        mesh.thinInstances!.count = 0;
        expect(() => createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC)).toThrow("non-empty matrix buffer");

        mesh.thinInstances!.count = 2;
        Object.assign(world, { _fo: {} });
        expect(() => createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC)).toThrow("floating-origin worlds");
    });

    it("keeps one thin context across concurrent enable calls", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        const firstEnable = enableHavokThinInstancePhysics(world);
        const secondEnable = enableHavokThinInstancePhysics(world);

        await firstEnable;
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);
        await secondEnable;

        expect(getPhysicsBodyInstanceCount(body)).toBe(2);
        expect(world._thin!.resolve(2)?.[0]).toBe(body);
    });

    it("reuses one transform payload across animated thin-instance prestep synchronization", async () => {
        const hknp = makeMockHknp();
        const scene = makeScene();
        const mesh = makeThinMesh();
        const world = createHavokWorld(scene, hknp);
        await enableHavokThinInstancePhysics(world);
        createPhysicsBody(world, mesh, PhysicsMotionType.ANIMATED);
        mesh.thinInstances!.matrices[12] = 4;
        mesh.thinInstances!.matrices[28] = 9;
        for (const offset of [0, 16]) {
            mesh.thinInstances!.matrices[offset] = 0;
            mesh.thinInstances!.matrices[offset + 1] = 1;
            mesh.thinInstances!.matrices[offset + 4] = -1;
            mesh.thinInstances!.matrices[offset + 5] = 0;
        }

        stepFrame(scene);

        expect(hknp.HP_Body_SetQTransform.mock.calls[2]![1]).toBe(hknp.HP_Body_SetQTransform.mock.calls[3]![1]);
        expect(hknp.HP_Body_SetQTransform.mock.calls[2]![1][1][2]).toBeCloseTo(Math.SQRT1_2);
        expect(hknp.HP_Body_SetQTransform.mock.calls[2]![1][1][3]).toBeCloseTo(Math.SQRT1_2);
        expect(hknp.transforms.get(1)![0][0]).toBe(4);
        expect(hknp.transforms.get(2)![0][0]).toBe(9);
    });

    it("uses the carrier target for ACTION prestep without allocating per instance", async () => {
        const hknp = makeMockHknp();
        const scene = makeScene();
        const mesh = makeThinMesh();
        const world = createHavokWorld(scene, hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, mesh, PhysicsMotionType.ANIMATED);
        setPhysicsBodyPrestepType(body, PhysicsPrestepType.ACTION);

        stepFrame(scene);

        expect(hknp.HP_Body_SetTargetQTransform).toHaveBeenCalledTimes(2);
        expect(hknp.HP_Body_SetTargetQTransform.mock.calls[0]![1]).toBe(hknp.HP_Body_SetTargetQTransform.mock.calls[1]![1]);
        expect(hknp.HP_Body_SetTargetQTransform.mock.calls[0]![1]).toEqual([
            [50, 60, 70],
            [0, 0, 0, 1],
        ]);
    });

    it("propagates a shared shape and mass to every native instance", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);
        const shape = { _hkShape: ["shape"], _type: PhysicsShapeType.BOX } as PhysicsShape;

        setPhysicsBodyShape(world, body, shape);
        setPhysicsBodyMass(world, body, 2);

        expect(hknp.HP_Body_SetShape).toHaveBeenCalledTimes(2);
        expect(hknp.HP_Body_SetMassProperties).toHaveBeenCalledTimes(2);
        expect(hknp.HP_Body_SetMassProperties.mock.calls.map((call) => call[1][1])).toEqual([2, 2]);
    });

    it("derives mass properties from each attached differently scaled shape", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const mesh = makeThinMesh();
        mesh.thinInstances!.matrices[16] = 2;
        mesh.thinInstances!.matrices[21] = 2;
        mesh.thinInstances!.matrices[26] = 2;
        const body = createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC);
        const shape = { _hkShape: ["shape"], _type: PhysicsShapeType.BOX } as PhysicsShape;
        setPhysicsBodyShape(world, body, shape);

        setPhysicsBodyMass(world, body, 1);

        const properties = hknp.HP_Body_SetMassProperties.mock.calls.slice(-2).map((call) => call[1]);
        expect(properties[0]).toEqual([[0, 1, 0], 1, [1 / 6, 1 / 6, 1 / 6], [0, 0, 0, 1]]);
        expect(properties[1]).toEqual([[0, 2, 0], 1, [2 / 3, 2 / 3, 2 / 3], [0, 0, 0, 1]]);
    });

    it("applies explicit overrides and rotation locks to each instance's derived properties", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const mesh = makeThinMesh();
        mesh.thinInstances!.matrices[16] = 2;
        mesh.thinInstances!.matrices[21] = 2;
        mesh.thinInstances!.matrices[26] = 2;
        const body = createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC);
        setPhysicsBodyShape(world, body, { _hkShape: ["shape"], _type: PhysicsShapeType.BOX } as PhysicsShape);

        setPhysicsBodyMassProperties(world, body, {
            centerOfMass: { x: 7, y: 8, z: 9 },
            mass: 3,
            inertia: { x: 4, y: 5, z: 6 },
        });
        expect(hknp.HP_Body_SetMassProperties.mock.calls.slice(-2).map((call) => call[1])).toEqual([
            [[7, 8, 9], 3, [4, 5, 6], [0, 0, 0, 1]],
            [[7, 8, 9], 3, [4, 5, 6], [0, 0, 0, 1]],
        ]);

        lockPhysicsBodyRotationAxes(world, body, ["z"]);
        setPhysicsBodyMassProperties(world, body, { mass: 4 });
        expect(hknp.HP_Body_SetMassProperties.mock.calls.slice(-2).map((call) => call[1])).toEqual([
            [[0, 1, 0], 4, [1 / 6, 1 / 6, 0], [0, 0, 0, 1]],
            [[0, 2, 0], 4, [2 / 3, 2 / 3, 0], [0, 0, 0, 1]],
        ]);

        unlockPhysicsBodyRotationAxes(world, body, ["z"]);
        expect(hknp.HP_Body_SetMassProperties.mock.calls.slice(-2).map((call) => call[1])).toEqual([
            [[0, 1, 0], 4, [1 / 6, 1 / 6, 1 / 6], [0, 0, 0, 1]],
            [[0, 2, 0], 4, [2 / 3, 2 / 3, 2 / 3], [0, 0, 0, 1]],
        ]);
    });

    it("scales shared collider geometry to each effective non-unit instance basis", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const mesh = makeThinMesh();
        mesh.thinInstances!.count = 1;
        Object.defineProperty(mesh, "worldMatrix", { value: new Float32Array([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1]) });
        mesh.thinInstances!.matrices.set([-2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1]);
        const body = createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC);
        const shape = { _hkShape: ["shape"], _type: PhysicsShapeType.BOX } as PhysicsShape;

        setPhysicsBodyShape(world, body, shape);

        expect(hknp.HP_Shape_CreateContainer).toHaveBeenCalledTimes(1);
        expect(hknp.HP_Shape_AddChild).toHaveBeenCalledWith(
            ["scaled-shape"],
            ["shape"],
            [
                [0, 0, 0],
                [0, 0, 0, 1],
                [2, -3, 4],
            ]
        );
        expect(hknp.HP_Body_SetShape).toHaveBeenCalledWith([1], ["scaled-shape"]);
    });

    it("fans direct body controls only for a thin primary handle", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);
        hknp.HP_Body_SetMotionType.mockClear();

        applyPhysicsBodyImpulse(body, { x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 });
        setPhysicsBodyLinearVelocity(world, body, { x: 7, y: 8, z: 9 });
        setPhysicsBodyAngularVelocity(world, body, { x: 10, y: 11, z: 12 });
        setPhysicsBodyMotionType(world, body, PhysicsMotionType.ANIMATED);

        expect(hknp.HP_Body_ApplyImpulse).toHaveBeenCalledTimes(2);
        expect(hknp.HP_Body_SetLinearVelocity).toHaveBeenCalledTimes(2);
        expect(hknp.HP_Body_SetAngularVelocity).toHaveBeenCalledTimes(2);
        expect(hknp.HP_Body_SetMotionType).toHaveBeenCalledTimes(2);

        const instanceHandle = world._thin!.resolve(1)![1];
        hknp.HP_Body_ApplyImpulse.mockClear();
        world._hknp.HP_Body_ApplyImpulse(instanceHandle, [4, 5, 6], [1, 2, 3]);
        expect(hknp.HP_Body_ApplyImpulse).toHaveBeenCalledTimes(1);
        expect(hknp.HP_Body_ApplyImpulse).toHaveBeenCalledWith(instanceHandle, [4, 5, 6], [1, 2, 3]);
    });

    it("applies an implicit-point impulse at each instance position", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);
        hknp.HP_Body_ApplyImpulse.mockClear();

        applyPhysicsImpulse(world, body, { x: 1, y: 2, z: 3 });

        expect(hknp.HP_Body_ApplyImpulse.mock.calls.map((call) => call[1])).toEqual([
            [-2, 5, 0],
            [3, 8, 0],
        ]);
    });

    it("fans a public transform through the facade and flushes every thin matrix", async () => {
        const hknp = makeMockHknp();
        const mesh = makeThinMesh();
        mesh.position.set = vi.fn((x, y, z) => Object.assign(mesh.position, { x, y, z }));
        mesh.rotationQuaternion.set = vi.fn((x, y, z, w) => Object.assign(mesh.rotationQuaternion, { x, y, z, w }));
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC);

        setPhysicsBodyTransform(world, body, { x: 7, y: 8, z: 9 }, { x: 0, y: 0, z: 0, w: 1 });

        expect(hknp.transforms.get(1)![0]).toEqual([7, 8, 9]);
        expect(hknp.transforms.get(2)![0]).toEqual([7, 8, 9]);
        expect(Array.from(mesh.thinInstances!.matrices.slice(12, 15))).toEqual([7, 8, 9]);
        expect(Array.from(mesh.thinInstances!.matrices.slice(28, 31))).toEqual([7, 8, 9]);
        expect(mesh.thinInstances!._version).toBe(2);
        expect(mesh.position).toMatchObject({ x: 50, y: 60, z: 70 });
        expect(mesh.rotationQuaternion).toMatchObject({ x: 0, y: 0, z: 0, w: 1 });
        expect(mesh.position.set).not.toHaveBeenCalled();
        expect(mesh.rotationQuaternion.set).not.toHaveBeenCalled();
    });

    it("restores captured thin transforms and velocities without replacing resources", async () => {
        const hknp = makeMockHknp();
        const scene = makeScene();
        const mesh = makeThinMesh();
        const matrices = mesh.thinInstances!.matrices;
        const world = createHavokWorld(scene, hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC);
        capturePhysicsBodyInstanceResetState(world, body);
        hknp.transforms.set(1, [
            [20, 21, 22],
            [0, 0, 0, 1],
        ]);
        hknp.transforms.set(2, [
            [30, 31, 32],
            [0, 0, 0, 1],
        ]);
        stepFrame(scene);

        resetPhysicsBodyInstances(world, body);

        expect(hknp.HP_Body_Create).toHaveBeenCalledTimes(2);
        expect(hknp.HP_Body_Release).not.toHaveBeenCalled();
        expect(mesh.thinInstances!.matrices).toBe(matrices);
        expect(Array.from(hknp.transforms.values())).toEqual([
            [
                [-2, 5, 0],
                [0, 0, 0, 1],
            ],
            [
                [3, 8, 0],
                [0, 0, 0, 1],
            ],
        ]);
        expect(hknp.HP_Body_SetLinearVelocity.mock.calls.slice(-2).map((call) => call[1])).toEqual([
            [0, 0, 0],
            [0, 0, 0],
        ]);
        expect(hknp.HP_Body_SetAngularVelocity.mock.calls.slice(-2).map((call) => call[1])).toEqual([
            [0, 0, 0],
            [0, 0, 0],
        ]);
        expect(hknp.HP_Body_SetActivationState).toHaveBeenCalledTimes(2);
        expect(hknp.HP_Body_SetActivationState).toHaveBeenLastCalledWith([2], 1);
    });

    it("restores multiple signed-scale instances through an unchanged carrier", async () => {
        const hknp = makeMockHknp();
        const scene = makeScene();
        const mesh = makeThinMesh();
        Object.defineProperty(mesh, "worldMatrix", { value: new Float32Array([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1]) });
        mesh.thinInstances!.matrices.set([-2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1], 0);
        mesh.thinInstances!.matrices.set([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, -5, -6, -7, 1], 16);
        const authoredMatrices = mesh.thinInstances!.matrices.slice();
        const world = createHavokWorld(scene, hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC);
        capturePhysicsBodyInstanceResetState(world, body);
        const authoredNative = [...hknp.transforms.values()].map(([position, rotation]) => [position.slice(), rotation.slice()]);
        hknp.transforms.set(1, [
            [20, 21, 22],
            [0, 0, 0, 1],
        ]);
        hknp.transforms.set(2, [
            [30, 31, 32],
            [0, 0, 0, 1],
        ]);
        stepFrame(scene);
        hknp.HP_Body_SetQTransform.mockClear();

        resetPhysicsBodyInstances(world, body);

        expect(hknp.HP_Body_SetQTransform).toHaveBeenCalledTimes(2);
        expect([...hknp.transforms.values()]).toEqual(authoredNative);
        expect(mesh.thinInstances!.matrices).not.toBe(authoredMatrices);
        expect(mesh.thinInstances!.matrices).toEqual(authoredMatrices);

        (mesh.worldMatrix as unknown as Float32Array)[12] = 11;
        expect(() => resetPhysicsBodyInstances(world, body)).toThrow("carrier world transform");
    });

    it("rejects reset capture for ordinary and disposed bodies", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const ordinaryMesh = makeThinMesh();
        ordinaryMesh.thinInstances = undefined;
        const ordinary = createPhysicsBody(world, ordinaryMesh, PhysicsMotionType.DYNAMIC);
        expect(() => capturePhysicsBodyInstanceResetState(world, ordinary)).toThrow("thin-instance physics body");

        const thin = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);
        capturePhysicsBodyInstanceResetState(world, thin);
        removePhysicsBody(world, thin);
        expect(() => resetPhysicsBodyInstances(world, thin)).toThrow("does not belong");
    });

    it("writes every simulated transform back to the matrix slab once per step", async () => {
        const hknp = makeMockHknp();
        const scene = makeScene();
        const mesh = makeThinMesh();
        const world = createHavokWorld(scene, hknp);
        await enableHavokThinInstancePhysics(world);
        createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC);
        hknp.transforms.set(1, [
            [1, 2, 3],
            [0, 0, 0, 1],
        ]);
        hknp.transforms.set(2, [
            [4, 5, 6],
            [0, 0, 0, 1],
        ]);

        stepFrame(scene);

        expect(Array.from(mesh.thinInstances!.matrices.slice(12, 15))).toEqual([1, 2, 3]);
        expect(Array.from(mesh.thinInstances!.matrices.slice(28, 31))).toEqual([4, 5, 6]);
        expect(mesh.thinInstances!._version).toBe(2);
        expect(mesh.thinInstances!._dirtyMin).toBe(0);
        expect(mesh.thinInstances!._dirtyMax).toBe(2);
        expect(mesh.position.set).not.toHaveBeenCalled();
    });

    it("removes and releases every native instance during disposal", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);

        disposePhysics(world);

        expect(hknp.HP_World_RemoveBody).toHaveBeenCalledTimes(2);
        expect(hknp.HP_Body_Release).toHaveBeenCalledTimes(2);
    });

    it("removes and releases thin instances immediately outside after-step draining", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);

        removePhysicsBody(world, body);

        expect(hknp.HP_World_RemoveBody).toHaveBeenCalledTimes(2);
        expect(hknp.HP_Body_Release).toHaveBeenCalledTimes(2);
        expect(world._thin!.resolve(1)).toBeNull();
        expect(world._thin!.resolve(2)).toBeNull();
    });

    it("reports Babylon.js-compatible collider indices for native collision events", async () => {
        const hknp = makeMockHknp();
        const memory = new ArrayBuffer(256);
        const address = 16;
        const ints = new Int32Array(memory, address);
        const floats = new Float32Array(memory, address);
        ints[0] = 1;
        ints[2] = 2;
        ints[18] = 1;
        floats[10] = 3;
        floats[11] = 8;
        floats[12] = 0;
        floats[13] = 1;
        floats[14] = 0;
        floats[15] = 0;
        floats[26] = 2.75;
        floats[27] = 8;
        floats[28] = 0;
        floats[34] = 4.5;
        const setEventMask = vi.fn();
        Object.assign(hknp, {
            HEAPU8: new Uint8Array(memory),
            EventType: {
                COLLISION_STARTED: { value: 1 },
                COLLISION_CONTINUED: { value: 2 },
                COLLISION_FINISHED: { value: 4 },
            },
            HP_World_GetCollisionEvents: vi.fn(() => [0, address]),
            HP_World_GetNextCollisionEvent: vi.fn(() => 0),
            HP_Body_SetEventMask: setEventMask,
        });

        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);
        const received = vi.fn();

        setPhysicsBodyCollisionEventsEnabled(world, body, true);
        onPhysicsCollision(world, received);
        const thinScan = vi.spyOn(world._thin!, "resolve");
        world._afterStep![0]!(1 / 60);

        expect(setEventMask).toHaveBeenCalledTimes(2);
        expect(thinScan).not.toHaveBeenCalled();
        expect(received).toHaveBeenCalledWith({
            collider: body,
            colliderIndex: 1,
            collidedAgainst: body,
            collidedAgainstIndex: 0,
            type: "STARTED",
            point: { x: 3, y: 8, z: 0 },
            normal: { x: 1, y: 0, z: 0 },
            impulse: 4.5,
            distance: -0.25,
        });
    });

    it("reports thin-instance indices from trigger events", async () => {
        const hknp = makeMockHknp();
        const memory = new ArrayBuffer(64);
        const address = 16;
        const event = new Int32Array(memory, address);
        event[0] = 8;
        event[2] = 2;
        event[6] = 1;
        Object.assign(hknp, {
            HEAPU8: new Uint8Array(memory),
            HP_World_GetTriggerEvents: vi.fn(() => [0, address]),
            HP_World_GetNextTriggerEvent: vi.fn(() => 0),
        });
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.STATIC);
        const received = vi.fn();

        onPhysicsTriggerBodies(world, received);
        world._afterStep![0]!(1 / 60);

        expect(received).toHaveBeenCalledWith({ type: "ENTERED", bodyA: body, bodyAIndex: 1, bodyB: body, bodyBIndex: 0 });
    });

    it("reports collisions when a participant is removed before event draining", async () => {
        const hknp = makeMockHknp();
        const releasedIds: number[] = [];
        let nextBodyId = 1;
        hknp.HP_Body_Create.mockImplementation(() => [0, [releasedIds.pop() ?? nextBodyId++]]);
        hknp.HP_Body_Release.mockImplementation((handle: number[]) => {
            releasedIds.push(handle[0]!);
        });
        const memory = new ArrayBuffer(256);
        const address = 16;
        const ints = new Int32Array(memory, address);
        ints[0] = 1;
        ints[2] = 2;
        ints[18] = 1;
        Object.assign(hknp, {
            HEAPU8: new Uint8Array(memory),
            EventType: {
                COLLISION_STARTED: { value: 1 },
                COLLISION_CONTINUED: { value: 2 },
                COLLISION_FINISHED: { value: 4 },
            },
            HP_World_GetCollisionEvents: vi.fn(() => [0, address]),
            HP_World_GetNextCollisionEvent: vi.fn(() => 0),
        });
        const scene = makeScene();
        const world = createHavokWorld(scene, hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);
        const received = vi.fn();
        onPhysicsAfterStep(world, () => {
            removePhysicsBody(world, body);
            expect(hknp.HP_Body_Release).not.toHaveBeenCalled();
            createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);
        });
        onPhysicsCollision(world, received);

        stepFrame(scene);

        expect(received).toHaveBeenCalledWith(expect.objectContaining({ collider: body, colliderIndex: 1, collidedAgainst: body, collidedAgainstIndex: 0 }));
        expect(world._thin!.resolve(3)?.[2]).toBe(0);
        expect(world._thin!.resolve(4)?.[2]).toBe(1);
        expect(hknp.HP_Body_Release).toHaveBeenCalledTimes(2);
        const reusedBody = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);
        expect(world._thin!.resolve(2)).toEqual([reusedBody, expect.any(Array), 0]);
        expect(world._thin!.resolve(1)).toEqual([reusedBody, expect.any(Array), 1]);
    });

    it("matches ordinary collision body handles across number and BigInt IDs", () => {
        const hknp = makeMockHknp();
        const memory = new ArrayBuffer(256);
        const address = 16;
        const ints = new Int32Array(memory, address);
        ints[0] = 1;
        ints[2] = 1;
        ints[18] = 1;
        Object.assign(hknp, {
            HEAPU8: new Uint8Array(memory),
            EventType: {
                COLLISION_STARTED: { value: 1 },
                COLLISION_CONTINUED: { value: 2 },
                COLLISION_FINISHED: { value: 4 },
            },
            HP_World_GetCollisionEvents: vi.fn(() => [0, address]),
            HP_World_GetNextCollisionEvent: vi.fn(() => 0),
        });
        const scene = makeScene();
        const world = createHavokWorld(scene, hknp);
        const mesh = makeThinMesh();
        mesh.thinInstances = undefined;
        const body = createPhysicsBody(world, mesh, PhysicsMotionType.STATIC);
        body._hkBody[0] = BigInt(1);
        const received = vi.fn();
        onPhysicsCollision(world, received);

        stepFrame(scene);

        expect(received).toHaveBeenCalledWith(expect.objectContaining({ collider: body, collidedAgainst: body }));
    });

    it("reports ordinary collisions when a participant is removed before event draining", () => {
        const hknp = makeMockHknp();
        const memory = new ArrayBuffer(256);
        const address = 16;
        const ints = new Int32Array(memory, address);
        ints[0] = 1;
        ints[2] = 1;
        ints[18] = 1;
        Object.assign(hknp, {
            HEAPU8: new Uint8Array(memory),
            EventType: {
                COLLISION_STARTED: { value: 1 },
                COLLISION_CONTINUED: { value: 2 },
                COLLISION_FINISHED: { value: 4 },
            },
            HP_World_GetCollisionEvents: vi.fn(() => [0, address]),
            HP_World_GetNextCollisionEvent: vi.fn(() => 0),
        });
        const scene = makeScene();
        const world = createHavokWorld(scene, hknp);
        const mesh = makeThinMesh();
        mesh.thinInstances = undefined;
        const body = createPhysicsBody(world, mesh, PhysicsMotionType.DYNAMIC);
        const received = vi.fn();
        onPhysicsAfterStep(world, () => {
            removePhysicsBody(world, body);
            expect(hknp.HP_Body_Release).not.toHaveBeenCalled();
        });
        onPhysicsCollision(world, received);

        stepFrame(scene);

        expect(received).toHaveBeenCalledWith(expect.objectContaining({ collider: body, collidedAgainst: body }));
        expect(hknp.HP_Body_Release).toHaveBeenCalledWith(body._hkBody);
        expect(world._bodies).not.toContain(body);
    });

    it("reports the thin-instance index from a raycast hit", async () => {
        const hknp = makeMockHknp();
        Object.assign(hknp, {
            HP_QueryCollector_Create: vi.fn(() => [0, ["collector"]]),
            HP_World_CastRayWithCollector: vi.fn(),
            HP_QueryCollector_GetNumHits: vi.fn(() => [0, 1]),
            HP_QueryCollector_GetCastRayResult: vi.fn(() => [0, [0.5, [[2], null, null, [0, 4, 0], [0, 1, 0], -1]]]),
        });
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.STATIC);

        const result = physicsRaycast(world, { x: 0, y: 10, z: 0 }, { x: 0, y: 0, z: 0 });

        expect(result.body).toBe(body);
        expect(result.bodyIndex).toBe(1);
    });

    it("applies character-controller impulses to the struck native instance", async () => {
        const hknp = makeMockHknp();
        const getLinearVelocity = vi.fn(() => [0, [-1, 0, 0]]);
        const applyImpulse = vi.fn();
        Object.assign(hknp, {
            HP_Body_GetMassProperties: vi.fn(() => [0, [[0, 0, 0], 2]]),
            HP_Body_GetQTransform: vi.fn(() => [
                0,
                [
                    [3, 8, 0],
                    [0, 0, 0, 1],
                ],
            ]),
            HP_Body_GetAngularVelocity: vi.fn(() => [0, [0, 0, 0]]),
            HP_Body_GetLinearVelocity: getLinearVelocity,
            HP_Body_ApplyImpulse: applyImpulse,
        });
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.DYNAMIC);
        const firstHandle = world._thin!.resolve(1)![1];
        const secondHandle = world._thin!.resolve(2)![1];
        expect(firstHandle).not.toBe(body._hkBody);
        expect(world._thin!.resolve(1)![1]).toBe(firstHandle);
        interface MutableController {
            _manifold: unknown[];
            _velocity: { x: number; y: number; z: number };
            _world: typeof world;
            _findBody(id: unknown, contact: { nativeBody: unknown; instanceIndex: number }): PhysicsBody | null;
            _getComWorld(body: PhysicsBody, nativeBody: unknown): { x: number; y: number; z: number };
            _resolveContacts(deltaTime: number, gravity: { x: number; y: number; z: number }): void;
            characterStrength: number;
            characterMass: number;
            onTriggerCollisionObservable: CharacterCollisionObservable;
        }
        const controller = Object.create(PhysicsCharacterController.prototype) as MutableController;
        controller._world = world;
        controller._velocity = { x: 0, y: 0, z: 0 };
        controller._manifold = [
            {
                position: { x: 3, y: 8, z: 0 },
                normal: { x: 1, y: 0, z: 0 },
                distance: 0,
                fraction: 0,
                body,
                nativeBody: firstHandle,
                instanceIndex: 0,
                allowedPenetration: 0,
            },
        ];
        controller.characterStrength = 1;
        controller.characterMass = 1;
        controller.onTriggerCollisionObservable = new CharacterCollisionObservable();
        const collision = vi.fn();
        controller.onTriggerCollisionObservable.add(collision);

        const resolvedFirst = { nativeBody: null, instanceIndex: -1 };
        expect(controller._findBody(firstHandle[0], resolvedFirst)).toBe(body);
        expect(resolvedFirst).toEqual({ nativeBody: firstHandle, instanceIndex: 0 });
        const resolvedSecond = { nativeBody: null, instanceIndex: -1 };
        expect(controller._findBody(secondHandle[0], resolvedSecond)).toBe(body);
        expect(resolvedSecond).toEqual({ nativeBody: secondHandle, instanceIndex: 1 });
        expect(controller._getComWorld(body, firstHandle)).toEqual({ x: 3, y: 8, z: 0 });
        controller._resolveContacts(1 / 60, { x: 0, y: 0, z: 0 });

        expect(collision).toHaveBeenCalledWith(expect.objectContaining({ collider: body, colliderIndex: 0 }));
        expect(getLinearVelocity).toHaveBeenCalledWith(firstHandle);
        expect(applyImpulse).toHaveBeenCalledTimes(1);
        expect(applyImpulse).toHaveBeenCalledWith(firstHandle, [3, 8, 0], expect.any(Array));
        expect(applyImpulse).not.toHaveBeenCalledWith(secondHandle, expect.anything(), expect.anything());
    });

    it("drops tracked instance handles and contacts on controller disposal", async () => {
        const hknp = makeMockHknp();
        const world = createHavokWorld(makeScene(), hknp);
        await enableHavokThinInstancePhysics(world);
        const body = createPhysicsBody(world, makeThinMesh(), PhysicsMotionType.ANIMATED);
        const instanceHandle = world._thin!.resolve(2)![1] as object;
        interface DisposableController {
            _world: typeof world;
            _body: PhysicsBody;
            _shape: PhysicsShape;
            _startCollector: unknown;
            _castCollector: unknown;
            _bodyTracking: WeakMap<object, { prev: number[]; frameId: number }>;
            _manifold: unknown[];
            dispose(): void;
        }
        const controller = Object.create(PhysicsCharacterController.prototype) as DisposableController;
        controller._world = world;
        controller._body = body;
        controller._shape = { _hkShape: ["shape"], _type: PhysicsShapeType.CAPSULE };
        controller._startCollector = ["start"];
        controller._castCollector = ["cast"];
        controller._bodyTracking = new WeakMap([[instanceHandle, { prev: new Array(16), frameId: 1 }]]);
        controller._manifold = [{ body, nativeBody: instanceHandle }];

        controller.dispose();

        expect(controller._bodyTracking.has(instanceHandle)).toBe(false);
        expect(controller._manifold).toHaveLength(0);
    });
});
