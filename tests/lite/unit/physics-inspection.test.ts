import { describe, expect, it, vi } from "vitest";
import type { SceneContext } from "../../../packages/babylon-lite/src/scene/scene-core";
import type { Mesh } from "../../../packages/babylon-lite/src/mesh/mesh";
import type { PhysicsMassProperties, PhysicsWorld, HavokThinInstanceContext } from "../../../packages/babylon-lite/src/physics/havok";
import { createTransformNode } from "../../../packages/babylon-lite/src/scene/transform-node";
import { createHeightFieldShape } from "../../../packages/babylon-lite/src/physics/havok-heightfield";
import { lockPhysicsBodyRotationAxes } from "../../../packages/babylon-lite/src/physics/havok-rotation-locks";
import { getPhysicsConstraintDebug } from "../../../packages/babylon-lite/src/physics/physics-viewer";
import {
    createHavokWorld,
    createPhysicsBody,
    createPhysicsAggregate,
    createPhysicsShape,
    createPhysicsConstraint,
    disposePhysics,
    getPhysicsBodies,
    getPhysicsConstraints,
    getPhysicsBodyWorld,
    getPhysicsBodyShape,
    getPhysicsBodyPrestepType,
    getPhysicsBodyMassPropertiesToRef,
    getPhysicsBodyLinearDamping,
    setPhysicsBodyLinearDamping,
    getPhysicsBodyAngularDamping,
    setPhysicsBodyAngularDamping,
    getPhysicsBodyGravityFactor,
    setPhysicsBodyGravityFactor,
    getPhysicsBodyLinearVelocityToRef,
    getPhysicsBodyAngularVelocityToRef,
    getPhysicsShapeType,
    getPhysicsShapeParameters,
    getPhysicsShapeMaterialToRef,
    getPhysicsShapeFilterMembershipMask,
    getPhysicsShapeFilterCollideMask,
    getPhysicsShapeDensity,
    getPhysicsShapeChildCount,
    isPhysicsConstraintEnabled,
    setPhysicsConstraintEnabled,
    PhysicsMotionType,
    PhysicsShapeType,
    PhysicsPrestepType,
    PhysicsConstraintType,
    releasePhysicsConstraint,
    removePhysicsBody,
    setPhysicsBodyShape,
    setPhysicsBodyPrestepType,
} from "../../../packages/babylon-lite/src/physics/havok";

function setup() {
    let mass = [[1, 2, 3], 12, [4, 5, 6], [0, 0, 0, 1]];
    const enabled = new Map<unknown, boolean>();
    const hknp = {
        Result: { RESULT_OK: 7 },
        MotionType: { STATIC: 0, DYNAMIC: 2 },
        ConstraintAxis: { LINEAR_X: 0, LINEAR_Y: 1, LINEAR_Z: 2 },
        ConstraintAxisLimitMode: { LOCKED: 0 },
        MaterialCombine: { MINIMUM: 0 },
        HP_World_Create: vi.fn(() => [7, {}]),
        HP_World_SetGravity: vi.fn(),
        HP_World_AddBody: vi.fn(),
        HP_World_RemoveBody: vi.fn(),
        HP_World_Release: vi.fn(),
        HP_Body_Create: vi.fn(() => [7, {}]),
        HP_Body_SetMotionType: vi.fn(),
        HP_Body_SetQTransform: vi.fn(),
        HP_Body_SetShape: vi.fn(),
        HP_Body_Release: vi.fn(),
        HP_Body_GetMassProperties: vi.fn(() => [7, mass]),
        HP_Body_SetMassProperties: vi.fn((_body: unknown, value: typeof mass) => {
            mass = value;
        }),
        HP_Body_GetLinearDamping: vi.fn(() => [7, 0.1]),
        HP_Body_SetLinearDamping: vi.fn(),
        HP_Body_GetAngularDamping: vi.fn(() => [7, 0.2]),
        HP_Body_SetAngularDamping: vi.fn(),
        HP_Body_GetGravityFactor: vi.fn(() => [7, 0.3]),
        HP_Body_SetGravityFactor: vi.fn(),
        HP_Body_GetLinearVelocity: vi.fn(() => [7, [1, 2, 3]]),
        HP_Body_GetAngularVelocity: vi.fn(() => [7, [4, 5, 6]]),
        HP_Shape_CreateSphere: vi.fn(() => [7, {}]),
        HP_Shape_CreateBox: vi.fn(() => [7, {}]),
        HP_Shape_CreateContainer: vi.fn(() => [7, {}]),
        HP_Shape_CreateMesh: vi.fn(() => [7, {}]),
        HP_Shape_CreateConvexHull: vi.fn(() => [7, {}]),
        HP_Shape_CreateHeightField: vi.fn(() => [7, {}]),
        HP_Shape_SetMaterial: vi.fn(),
        HP_Shape_GetMaterial: vi.fn(() => [7, [0.8, 0.4, 0.9, 0, 0]]),
        HP_Shape_GetFilterInfo: vi.fn(() => [7, [0x12, 0x34]]),
        HP_Shape_GetDensity: vi.fn(() => [7, 2.5]),
        HP_Shape_GetNumChildren: vi.fn(() => [7, 3]),
        HP_Constraint_Create: vi.fn(() => [7, {}]),
        HP_Constraint_SetParentBody: vi.fn(),
        HP_Constraint_SetChildBody: vi.fn(),
        HP_Constraint_SetAnchorInParent: vi.fn(),
        HP_Constraint_SetAnchorInChild: vi.fn(),
        HP_Constraint_SetAxisMode: vi.fn(),
        HP_Constraint_SetCollisionsEnabled: vi.fn(),
        HP_Constraint_SetEnabled: vi.fn((joint: unknown, value: boolean) => enabled.set(joint, value)),
        HP_Constraint_GetEnabled: vi.fn((joint: unknown) => [7, enabled.get(joint) ? 1 : 0]),
        HP_Constraint_Release: vi.fn(),
        HEAPU8: new Uint8Array(1024),
        _malloc: vi.fn(() => 0),
        _free: vi.fn(),
    };
    const scene = { _beforeRender: [], _disposables: [] } as unknown as SceneContext;
    const world = createHavokWorld(scene, hknp);
    const node = createTransformNode("body");
    const body = createPhysicsBody(world, node, PhysicsMotionType.STATIC);
    return { hknp, scene, world, node, body };
}

function massOut(): Required<PhysicsMassProperties> {
    return { mass: 0, centerOfMass: { x: 0, y: 0, z: 0 }, inertia: { x: 0, y: 0, z: 0 }, inertiaOrientation: { x: 0, y: 0, z: 0, w: 1 } };
}

function thin(world: PhysicsWorld) {
    const handles = ["instance0", "instance1", "instance2"];
    world._thin = {
        instance: vi.fn((_body, index: number) => handles[index]),
        count: vi.fn(() => handles.length),
    } as unknown as HavokThinInstanceContext;
    return handles;
}

describe("physics inspection", () => {
    it("writes native mass properties into the same output and nested vectors", () => {
        const { world, body } = setup();
        const out = massOut();
        const { centerOfMass, inertia, inertiaOrientation } = out;
        expect(getPhysicsBodyMassPropertiesToRef(world, body, out)).toBe(out);
        expect(out).toEqual({ mass: 12, centerOfMass: { x: 1, y: 2, z: 3 }, inertia: { x: 4, y: 5, z: 6 }, inertiaOrientation: { x: 0, y: 0, z: 0, w: 1 } });
        expect(out.centerOfMass).toBe(centerOfMass);
        expect(out.inertia).toBe(inertia);
        expect(out.inertiaOrientation).toBe(inertiaOrientation);
    });

    it("rejects failed mass reads without changing output", () => {
        const { world, body, hknp } = setup();
        hknp.HP_Body_GetMassProperties.mockReturnValueOnce([3, []]);
        const out = massOut();
        expect(() => getPhysicsBodyMassPropertiesToRef(world, body, out)).toThrow("Failed to read physics body mass properties.");
        expect(out.mass).toBe(0);
    });

    it("reads a selected thin instance and preserves the owning world association", () => {
        const { world, body, hknp } = setup();
        const handles = thin(world);
        getPhysicsBodyMassPropertiesToRef(world, body, massOut(), 2);
        expect(hknp.HP_Body_GetMassProperties).toHaveBeenLastCalledWith(handles[2]);
        expect(getPhysicsBodyWorld(body)).toBe(world);
        removePhysicsBody(world, body);
        expect(getPhysicsBodyWorld(body)).toBe(world);
    });

    it("reads native post-lock inertia rather than the unlocked source", () => {
        const { world, body } = setup();
        lockPhysicsBodyRotationAxes(world, body, ["x"]);
        expect(getPhysicsBodyMassPropertiesToRef(world, body, massOut()).inertia).toEqual({ x: 0, y: 5, z: 6 });
    });

    it.each([
        [getPhysicsBodyLinearDamping, setPhysicsBodyLinearDamping, "HP_Body_GetLinearDamping", "HP_Body_SetLinearDamping", 0.1],
        [getPhysicsBodyAngularDamping, setPhysicsBodyAngularDamping, "HP_Body_GetAngularDamping", "HP_Body_SetAngularDamping", 0.2],
        [getPhysicsBodyGravityFactor, setPhysicsBodyGravityFactor, "HP_Body_GetGravityFactor", "HP_Body_SetGravityFactor", 0.3],
    ] as const)("reads and fans out %s without extending the thin facade", (get, set, getName, setName, value) => {
        const { world, body, hknp } = setup();
        expect(get(world, body)).toBe(value);
        expect(hknp[getName]).toHaveBeenLastCalledWith(body._hkBody);
        set(world, body, 0.6);
        expect(hknp[setName]).toHaveBeenCalledExactlyOnceWith(body._hkBody, 0.6);
        hknp[setName].mockClear();
        const handles = thin(world);
        expect(get(world, body, 1)).toBe(value);
        expect(hknp[getName]).toHaveBeenLastCalledWith(handles[1]);
        set(world, body, 0.7);
        expect(hknp[setName].mock.calls).toEqual(handles.map((handle) => [handle, 0.7]));
    });

    it.each([
        [getPhysicsBodyLinearVelocityToRef, "HP_Body_GetLinearVelocity", { x: 1, y: 2, z: 3 }],
        [getPhysicsBodyAngularVelocityToRef, "HP_Body_GetAngularVelocity", { x: 4, y: 5, z: 6 }],
    ] as const)("reuses velocity storage for %s and selects thin handles", (get, name, expected) => {
        const { world, body, hknp } = setup();
        const out = { x: 0, y: 0, z: 0 };
        expect(get(world, body, out)).toBe(out);
        expect(out).toEqual(expected);
        expect(hknp[name]).toHaveBeenLastCalledWith(body._hkBody);
        const handles = thin(world);
        expect(get(world, body, out, 2)).toBe(out);
        expect(hknp[name]).toHaveBeenLastCalledWith(handles[2]);
    });

    it("reports JS prestep and base shape state", () => {
        const { world, body } = setup();
        expect(getPhysicsBodyPrestepType(body)).toBe(PhysicsPrestepType.TELEPORT);
        setPhysicsBodyPrestepType(body, PhysicsPrestepType.ACTION);
        expect(getPhysicsBodyPrestepType(body)).toBe(PhysicsPrestepType.ACTION);
        expect(getPhysicsBodyShape(body)).toBeNull();
        const shape = createPhysicsShape(world, { type: PhysicsShapeType.SPHERE });
        setPhysicsBodyShape(world, body, shape);
        expect(getPhysicsBodyShape(body)).toBe(shape);
    });

    it("caches primitive parameters by reference and aggregate auto-sized parameters", () => {
        const { world, node } = setup();
        const parameters = { radius: 2 };
        const primitive = createPhysicsShape(world, { type: PhysicsShapeType.SPHERE, parameters });
        expect(getPhysicsShapeType(primitive)).toBe(PhysicsShapeType.SPHERE);
        expect(getPhysicsShapeParameters(primitive)).toBe(parameters);
        parameters.radius = 3;
        expect(getPhysicsShapeParameters(primitive)?.radius).toBe(3);
        const aggregate = createPhysicsAggregate(world, node as Mesh, PhysicsShapeType.BOX, { mass: 0 });
        expect(getPhysicsShapeType(aggregate.shape)).toBe(PhysicsShapeType.BOX);
        expect(getPhysicsShapeParameters(aggregate.shape)?.extents).toEqual({ x: 1, y: 1, z: 1 });
        expect(getPhysicsBodies(world)).toContain(aggregate.body);
    });

    it("reports type but no primitive parameters for container, mesh, hull and heightfield paths", () => {
        const { world, node } = setup();
        const mesh = Object.assign(node, {
            _gpu: {},
            _cpuPositions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            _cpuIndices: new Uint32Array([0, 1, 2]),
        });
        for (const type of [PhysicsShapeType.CONTAINER, PhysicsShapeType.MESH, PhysicsShapeType.CONVEX_HULL]) {
            const shape = createPhysicsShape(world, { type, mesh });
            expect(getPhysicsShapeType(shape)).toBe(type);
            expect(getPhysicsShapeParameters(shape)).toBeNull();
        }
        const heightfield = createHeightFieldShape(world, {
            numHeightFieldSamplesX: 2,
            numHeightFieldSamplesZ: 2,
            heightFieldSizeX: 1,
            heightFieldSizeZ: 1,
            heightFieldData: new Float32Array(4),
        });
        expect(getPhysicsShapeType(heightfield)).toBe(PhysicsShapeType.HEIGHTFIELD);
        expect(getPhysicsShapeParameters(heightfield)).toBeNull();
    });

    it("maps material indices, filter masks, density and child count", () => {
        const { world, hknp } = setup();
        const shape = createPhysicsShape(world, { type: PhysicsShapeType.CONTAINER });
        const out = { friction: 0, staticFriction: 0, restitution: 0 };
        expect(getPhysicsShapeMaterialToRef(world, shape, out)).toBe(out);
        expect(out).toEqual({ friction: 0.4, staticFriction: 0.8, restitution: 0.9 });
        expect(hknp.HP_Shape_GetMaterial).toHaveBeenCalledWith(shape._hkShape);
        expect(getPhysicsShapeFilterMembershipMask(world, shape)).toBe(0x12);
        expect(getPhysicsShapeFilterCollideMask(world, shape)).toBe(0x34);
        expect(hknp.HP_Shape_GetFilterInfo).toHaveBeenCalledWith(shape._hkShape);
        expect(getPhysicsShapeDensity(world, shape)).toBe(2.5);
        expect(hknp.HP_Shape_GetDensity).toHaveBeenCalledWith(shape._hkShape);
        expect(getPhysicsShapeChildCount(world, shape)).toBe(3);
        expect(hknp.HP_Shape_GetNumChildren).toHaveBeenCalledWith(shape._hkShape);
        hknp.HP_Shape_GetNumChildren.mockReturnValueOnce([7, 0]);
        expect(getPhysicsShapeChildCount(world, createPhysicsShape(world, { type: PhysicsShapeType.SPHERE }))).toBe(0);
    });

    it("tracks constraints lazily, releases idempotently and does not delist on body removal", () => {
        const { world, body, hknp } = setup();
        expect(getPhysicsConstraints(world)).toEqual([]);
        expect(world).not.toHaveProperty("_constraints");
        const a = createPhysicsConstraint(world, body, body, PhysicsConstraintType.BALL_AND_SOCKET);
        const constraints = getPhysicsConstraints(world);
        const b = createPhysicsConstraint(world, body, body, PhysicsConstraintType.BALL_AND_SOCKET);
        expect(constraints).toBe(getPhysicsConstraints(world));
        expect(constraints).toEqual([a, b]);
        removePhysicsBody(world, body);
        expect(constraints).toEqual([a, b]);
        releasePhysicsConstraint(world, a);
        releasePhysicsConstraint(world, a);
        expect(constraints).toEqual([b]);
        expect(hknp.HP_Constraint_Release).toHaveBeenCalledExactlyOnceWith(a._hkConstraint);
    });

    it.each([false, true])("disposes all live constraints once before native world disposal (floating origin: %s)", (floatingOrigin) => {
        const { world, body, hknp } = setup();
        const a = createPhysicsConstraint(world, body, body, PhysicsConstraintType.BALL_AND_SOCKET);
        const b = createPhysicsConstraint(world, body, body, PhysicsConstraintType.BALL_AND_SOCKET);
        const c = createPhysicsConstraint(world, body, body, PhysicsConstraintType.BALL_AND_SOCKET);
        releasePhysicsConstraint(world, a);
        const constraints = getPhysicsConstraints(world);
        const releaseWorld = () => {
            expect(b._isDisposed).toBe(true);
            expect(c._isDisposed).toBe(true);
            expect(constraints).toEqual([]);
        };
        if (floatingOrigin) {
            world._fo = { dispose: vi.fn(releaseWorld) } as unknown as NonNullable<PhysicsWorld["_fo"]>;
        } else {
            hknp.HP_World_Release.mockImplementation(releaseWorld);
        }
        disposePhysics(world);
        disposePhysics(world);
        releasePhysicsConstraint(world, b);
        releasePhysicsConstraint(world, c);
        expect(hknp.HP_Constraint_Release.mock.calls).toEqual([[a._hkConstraint], [b._hkConstraint], [c._hkConstraint]]);
        expect(getPhysicsBodyWorld(body)).toBe(world);
    });

    it("round trips native enable state and lazily caches debug identity, axes and zero pivots", () => {
        const { world, body, hknp } = setup();
        const constraint = createPhysicsConstraint(world, body, body, PhysicsConstraintType.BALL_AND_SOCKET);
        expect(constraint._debug).toBeUndefined();
        expect(isPhysicsConstraintEnabled(world, constraint)).toBe(true);
        setPhysicsConstraintEnabled(world, constraint, false);
        expect(isPhysicsConstraintEnabled(world, constraint)).toBe(false);
        expect(hknp.HP_Constraint_GetEnabled).toHaveBeenCalledWith(constraint._hkConstraint);
        const debug = getPhysicsConstraintDebug(constraint);
        expect(getPhysicsConstraintDebug(constraint)).toBe(debug);
        expect(debug).toMatchObject({ bodyA: body, bodyB: body, type: constraint.type, pivotA: { x: 0, y: 0, z: 0 }, pivotB: { x: 0, y: 0, z: 0 } });
        expect(debug.axisA).toBe(constraint.options.axisA);
        expect(debug.axisB).toBe(constraint.options.axisB);
        expect(debug.perpAxisA).toBe(constraint.options.perpAxisA);
        expect(debug.perpAxisB).toBe(constraint.options.perpAxisB);
        const pivot = { x: 1, y: 2, z: 3 };
        const explicit = createPhysicsConstraint(world, body, body, PhysicsConstraintType.BALL_AND_SOCKET, { pivotA: pivot, pivotB: pivot });
        expect(getPhysicsConstraintDebug(explicit).pivotA).toBe(pivot);
        expect(getPhysicsConstraintDebug(explicit).pivotB).toBe(pivot);
    });

    it("uses body-local handles and values under floating origin with no region math", () => {
        const { world, body, hknp } = setup();
        world._fo = {} as NonNullable<PhysicsWorld["_fo"]>;
        body._region = { origin: { x: 1e9, y: 2e9, z: 3e9 } } as NonNullable<typeof body._region>;
        expect(getPhysicsBodyMassPropertiesToRef(world, body, massOut()).centerOfMass).toEqual({ x: 1, y: 2, z: 3 });
        expect(getPhysicsBodyLinearVelocityToRef(world, body, { x: 0, y: 0, z: 0 })).toEqual({ x: 1, y: 2, z: 3 });
        expect(getPhysicsBodyAngularVelocityToRef(world, body, { x: 0, y: 0, z: 0 })).toEqual({ x: 4, y: 5, z: 6 });
        expect(getPhysicsBodyLinearDamping(world, body)).toBe(0.1);
        expect(getPhysicsBodyAngularDamping(world, body)).toBe(0.2);
        expect(getPhysicsBodyGravityFactor(world, body)).toBe(0.3);
        setPhysicsBodyLinearDamping(world, body, 1);
        setPhysicsBodyAngularDamping(world, body, 2);
        setPhysicsBodyGravityFactor(world, body, 3);
        expect(hknp.HP_Body_GetMassProperties).toHaveBeenCalledWith(body._hkBody);
        expect(hknp.HP_Body_SetLinearDamping).toHaveBeenCalledExactlyOnceWith(body._hkBody, 1);
        expect(hknp.HP_Body_SetAngularDamping).toHaveBeenCalledExactlyOnceWith(body._hkBody, 2);
        expect(hknp.HP_Body_SetGravityFactor).toHaveBeenCalledExactlyOnceWith(body._hkBody, 3);
    });
});
