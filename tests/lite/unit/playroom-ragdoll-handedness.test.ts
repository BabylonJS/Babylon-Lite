import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
    createHavokWorld,
    createSceneContext,
    createTransformNode,
    disposePhysics,
    PhysicsConstraintType,
    releasePhysicsConstraint,
    releasePhysicsShape,
    setPhysicsBodyTransform,
} from "../../../packages/babylon-lite/src/index.js";
import type { EngineContext, PhysicsWorld, SurfaceContext, Skeleton, Vec3 } from "../../../packages/babylon-lite/src/index.js";
import { createBunnyRagdoll, syncBunnyPose } from "../../../lab/lite/src/demos/playroom/ragdoll.js";
import type { BunnyRigMetadata, PlayroomAssets, WorldState } from "../../../lab/lite/src/demos/playroom/types.js";
import source from "../fixtures/playroom-source-ragdoll.json";

const rig = JSON.parse(readFileSync(resolve(process.cwd(), "lab/public/playroom/gltf/bunny-rig.json"), "utf8")) as BunnyRigMetadata;
const require = createRequire(resolve(process.cwd(), "lab/package.json"));
const HavokPhysics = require("@babylonjs/havok") as (options: { wasmBinary: Uint8Array }) => Promise<PhysicsWorld["_hknp"]>;
let hknp: PhysicsWorld["_hknp"];

beforeAll(async () => {
    hknp = await HavokPhysics({ wasmBinary: readFileSync(resolve(process.cwd(), "lab/public/HavokPhysics.wasm")) });
});

function reflected(values: readonly number[]): number[] {
    return [-values[0]!, values[1]!, values[2]!];
}

function expectNumbers(actual: ArrayLike<number>, expected: readonly number[], label: string): void {
    expect(actual.length, label).toBe(expected.length);
    expected.forEach((value, index) => expect(actual[index], `${label}[${index}]`).toBeCloseTo(value, 5));
}

function vector(value: Vec3): number[] {
    return [value.x, value.y, value.z];
}

function stub<T extends object>(value: Partial<T>): T {
    return value as T;
}

function fixture() {
    const surface = stub<SurfaceContext>({ engine: stub<EngineContext>({}) });
    const scene = createSceneContext(surface, { defaultRenderTask: false });
    scene.fixedDeltaMs = 1000 / 60;
    const physics = createHavokWorld(scene, hknp);
    const bones = rig.joints.map((joint, index) => ({ name: joint.name, _nodeIndex: index }));
    const skeleton: Skeleton = {
        bones,
        _byName: new Map(bones.map((bone) => [bone.name, bone])),
        _overrides: new Map(),
        _worldOverrides: new Map(),
        _bake: () => {},
    };
    const assets = { rig, bunnyRoot: createTransformNode("bunny"), bunnySkeleton: skeleton } as PlayroomAssets;
    const world = { nextBodyId: 1, records: [], bodiesByObject: new Map(), shapes: [], constraints: [] } as unknown as WorldState;
    const launch = { x: 1.2, y: 0.9, z: -0.7 };
    const extents = new Map<bigint, number[]>();
    const createBox = hknp.HP_Shape_CreateBox;
    hknp.HP_Shape_CreateBox = (center: number[], rotation: number[], size: number[]) => {
        const result = createBox(center, rotation, size) as [unknown, [bigint]];
        extents.set(result[1][0], size.slice());
        return result;
    };
    let ragdoll;
    try {
        ragdoll = createBunnyRagdoll(scene, physics, assets, world, launch);
    } finally {
        hknp.HP_Shape_CreateBox = createBox;
    }
    return {
        physics,
        assets,
        ragdoll,
        extents,
        skeleton,
        launch,
        dispose(): void {
            ragdoll.constraints.forEach((constraint) => releasePhysicsConstraint(physics, constraint));
            disposePhysics(physics);
            world.shapes.forEach((shape) => releasePhysicsShape(physics, shape));
        },
    };
}

describe("The Playroom right-handed source to left-handed ragdoll", () => {
    it("reflects every native body and joint while preserving the source physical definition", () => {
        const test = fixture();
        try {
            expect(test.ragdoll.records).toHaveLength(10);
            expect(test.ragdoll.constraints).toHaveLength(9);
            for (const reference of source.bodies) {
                const record = test.ragdoll.records.find((record) => record.mesh.name === `ragdoll-${reference.name}`)!;
                const transform = hknp.HP_Body_GetQTransform(record.body._hkBody)[1] as number[][];
                expectNumbers(
                    transform[0]!,
                    reflected(reference.position).map((value, axis) => value + vector(test.launch)[axis]!),
                    `${reference.name} position`
                );
                expectNumbers(transform[1]!, [0, 0, 0, 1], `${reference.name} initial rotation`);
                expectNumbers(test.extents.get(record.shape!._hkShape[0])!, reference.extents, `${reference.name} box dimensions`);
                const mass = hknp.HP_Body_GetMassProperties(record.body._hkBody)[1] as [number[], number, number[], number[]];
                expect(mass[1]).toBeCloseTo(source.mass, 6);
                expectNumbers(mass[0], [0, 0, 0], `${reference.name} center of mass`);
                expectNumbers(mass[2], reference.inertia, `${reference.name} inertia`);
                const material = hknp.HP_Shape_GetMaterial(record.shape!._hkShape)[1] as number[];
                expectNumbers(material.slice(0, 3), [source.friction, source.friction, source.restitution], `${reference.name} material`);
                if (reference.parent) {
                    const constraint = test.ragdoll.constraints.find((constraint) => constraint.bodyB === record.body)!;
                    expect(constraint.type).toBe(PhysicsConstraintType.BALL_AND_SOCKET);
                    expect(constraint.bodyA.node.name).toBe(`ragdoll-${reference.parent}`);
                    expectNumbers(vector(constraint.options.pivotA!), reflected(reference.pivotA!), `${reference.name} parent pivot`);
                    expectNumbers(vector(constraint.options.pivotB!), reflected(reference.pivotB!), `${reference.name} child pivot`);
                    expectNumbers(vector(constraint.options.axisA!), reflected(reference.axis!), `${reference.name} parent axis`);
                    expectNumbers(vector(constraint.options.axisB!), reflected(reference.axis!), `${reference.name} child axis`);
                    expect(hknp.HP_Constraint_GetCollisionsEnabled(constraint._hkConstraint)[1]).toBe(0);
                    ["LINEAR_X", "LINEAR_Y", "LINEAR_Z", "ANGULAR_X", "ANGULAR_Y", "ANGULAR_Z"].forEach((axis, index) => {
                        expect(hknp.HP_Constraint_GetAxisMode(constraint._hkConstraint, hknp.ConstraintAxis[axis])[1]).toBe(hknp.ConstraintAxisLimitMode[source.axisModes[index]!]);
                    });
                }
            }
        } finally {
            test.dispose();
        }
    });

    it.each([0, 0.73])("preserves the reflected authored bone frames under a source Y rotation of %s radians", (angle) => {
        const test = fixture();
        try {
            const c = Math.cos(angle);
            const s = Math.sin(angle);
            // Apply one known rigid rotation to the source, then reflect X into Lite world space.
            const rotateSource = (x: number, y: number, z: number): number[] => [c * x + s * z, y, -s * x + c * z];
            for (const reference of source.bodies) {
                const record = test.ragdoll.records.find((record) => record.mesh.name === `ragdoll-${reference.name}`)!;
                const position = reflected(rotateSource(reference.position[0]!, reference.position[1]!, reference.position[2]!));
                setPhysicsBodyTransform(
                    test.physics,
                    record.body,
                    { x: test.launch.x + position[0]!, y: test.launch.y + position[1]!, z: test.launch.z + position[2]! },
                    { x: 0, y: -Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) }
                );
            }
            syncBunnyPose(test.assets, test.ragdoll);
            for (const [index, joint] of rig.joints.entries()) {
                const actual = test.skeleton._worldOverrides.get(index)!;
                const sourceMatrix = joint.bindWorldMatrix;
                for (let axis = 0; axis < 3; axis++) {
                    const offset = axis * 4;
                    const expected = reflected(rotateSource(sourceMatrix[offset]!, sourceMatrix[offset + 1]!, sourceMatrix[offset + 2]!));
                    expectNumbers(actual.subarray(offset, offset + 3), expected, `${joint.name} bind axis ${axis}`);
                }
                const position = reflected(rotateSource(sourceMatrix[12]!, sourceMatrix[13]!, sourceMatrix[14]!));
                expectNumbers(
                    actual.subarray(12, 15),
                    position.map((value, axis) => value + vector(test.launch)[axis]! / rig.gameScale),
                    `${joint.name} bone position`
                );
            }
        } finally {
            test.dispose();
        }
    });
});
