import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
    createHavokWorld,
    createPhysicsBody,
    createTransformNode,
    PhysicsMotionType,
    PhysicsPrestepType,
    setPhysicsBodyAngularVelocity,
    setPhysicsBodyLinearVelocity,
    setPhysicsBodyTransform,
} from "../../../packages/babylon-lite/src/index.js";
import type { Bone, PhysicsWorld, Quat, SceneContext, Skeleton } from "../../../packages/babylon-lite/src/index.js";
import {
    bindWorldRotation,
    colliderOffsetWorld,
    launchBunny,
    ragdollBodyPosition,
    ragdollJointPivots,
    relocateBunny,
    syncBunnyPose,
} from "../../../lab/lite/src/demos/playroom/ragdoll.js";
import type { BodyRecord, BunnyRigMetadata, PlayroomAssets, RagdollState } from "../../../lab/lite/src/demos/playroom/types.js";

const rig = JSON.parse(readFileSync(resolve(process.cwd(), "lab", "public", "playroom", "gltf", "bunny-rig.json"), "utf8")) as BunnyRigMetadata;
const identity: Quat = { x: 0, y: 0, z: 0, w: 1 };

function multiplyQuaternions(a: Quat, b: Quat): Quat {
    return {
        x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
        y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
        z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
        w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    };
}

function rotateByQuaternion(rotation: Quat, vector: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const inverse = { x: -rotation.x, y: -rotation.y, z: -rotation.z, w: rotation.w };
    const rotated = multiplyQuaternions(multiplyQuaternions(rotation, { ...vector, w: 0 }), inverse);
    return { x: rotated.x, y: rotated.y, z: rotated.z };
}

function makeLifecycleFixture(): { physics: PhysicsWorld; ragdoll: RagdollState; hknp: ReturnType<typeof makeHavok>; events: string[] } {
    const events: string[] = [];
    const hknp = makeHavok(events);
    const physics = createHavokWorld({ _beforeRender: [], fixedDeltaMs: 1000 / 60 } as unknown as SceneContext, hknp);
    const launch = { x: 0, y: 0.9, z: 0 };
    const records = rig.joints.map((joint, index) => {
        const position = ragdollBodyPosition(joint, launch);
        const node = createTransformNode(`test-${joint.name}`, position.x, position.y, position.z);
        const body = createPhysicsBody(physics, node, PhysicsMotionType.DYNAMIC);
        return {
            id: index,
            family: "ragdoll",
            body,
            mesh: node,
            mass: 0.08,
            scored: new Set<number>(),
            audioTags: ["soft", "projectile"],
        } satisfies BodyRecord;
    });
    const root = records[rig.joints.findIndex((joint) => joint.name === rig.root)]!;
    const ragdoll = {
        records,
        constraints: [],
        bones: {},
        root,
        visualRoot: root.mesh,
        launched: false,
        restTransforms: records.map((record) => ({
            position: { x: record.mesh.position.x, y: record.mesh.position.y, z: record.mesh.position.z },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
        })),
    } as unknown as RagdollState;
    for (const record of records) {
        setPhysicsBodyLinearVelocity(physics, record.body, { x: 3, y: 4, z: 5 });
        setPhysicsBodyAngularVelocity(physics, record.body, { x: 6, y: 7, z: 8 });
        record.mesh.position.set(record.mesh.position.x + 10, record.mesh.position.y - 5, record.mesh.position.z + 2);
        record.mesh.rotationQuaternion.set(0.5, 0.5, 0.5, 0.5);
    }
    hknp.HP_Body_SetLinearVelocity.mockClear();
    hknp.HP_Body_SetAngularVelocity.mockClear();
    hknp.HP_Body_SetMotionType.mockClear();
    hknp.HP_Body_SetQTransform.mockClear();
    events.length = 0;
    return { physics, ragdoll, hknp, events };
}

function makeHavok(events: string[]) {
    let nextBody = 1;
    const transforms = new Map<number, [number[], number[]]>();
    const linearVelocities = new Map<number, number[]>();
    const angularVelocities = new Map<number, number[]>();
    const appliedForcePoints: number[][] = [];
    return {
        transforms,
        linearVelocities,
        angularVelocities,
        appliedForcePoints,
        MotionType: { STATIC: 0, KINEMATIC: 1, DYNAMIC: 2 },
        HP_World_Create: vi.fn(() => [0, ["world"]]),
        HP_World_SetGravity: vi.fn(),
        HP_World_AddBody: vi.fn(),
        HP_Body_Create: vi.fn(() => [0, [nextBody++]]),
        HP_Body_SetMotionType: vi.fn((body: number[], motion: number) => events.push(`motion:${body[0]}:${motion}`)),
        HP_Body_SetQTransform: vi.fn((body: number[], transform: [number[], number[]]) => {
            transforms.set(body[0]!, [transform[0].slice(), transform[1].slice()]);
            events.push(`transform:${body[0]}`);
        }),
        HP_Body_SetLinearVelocity: vi.fn((body: number[], velocity: number[]) => {
            linearVelocities.set(body[0]!, velocity.slice());
            events.push(`linear:${body[0]}`);
        }),
        HP_Body_SetAngularVelocity: vi.fn((body: number[], velocity: number[]) => {
            angularVelocities.set(body[0]!, velocity.slice());
            events.push(`angular:${body[0]}`);
        }),
        HP_Body_ApplyImpulse: vi.fn((body: number[], point: number[], impulse: number[]) => {
            appliedForcePoints.push(point.slice());
            events.push(`force:${body[0]}:${Math.hypot(...impulse) * 60}`);
        }),
    };
}

describe("The Playroom ragdoll bind conversion", () => {
    it("rotates configured collider offsets by each bone bind-world orientation", () => {
        const armRight = rig.joints.find((joint) => joint.name === "arm_r")!;
        const armLeft = rig.joints.find((joint) => joint.name === "arm_l")!;
        expect(colliderOffsetWorld(armRight).x).toBeCloseTo(-0.06, 5);
        expect(colliderOffsetWorld(armLeft).x).toBeCloseTo(0.06, 5);
        expect(ragdollBodyPosition(armRight, { x: 0, y: 0.9, z: 0 }).x).toBeCloseTo(armRight.bindWorldPosition[0] - 0.06, 5);
    });

    it("submits every configured joint as one absolute world-pose batch", () => {
        const bones = rig.joints.map((joint, index) => ({ name: joint.name, _nodeIndex: index }) satisfies Bone);
        const bake = vi.fn();
        const skeleton = {
            bones,
            _byName: new Map(bones.map((bone) => [bone.name, bone])),
            _overrides: new Map(),
            _worldOverrides: new Map(),
            _bake: bake,
        } satisfies Skeleton;
        const records = rig.joints.map((joint, index) => {
            const mesh = createTransformNode(`pose-${joint.name}`, 3 + index * 0.2, 4 - index * 0.1, -2 + index * 0.05);
            mesh.rotationQuaternion.set(0, Math.SQRT1_2, 0, Math.SQRT1_2);
            return { mesh } as BodyRecord;
        });
        const ragdoll = {
            records,
            bones: Object.fromEntries(bones.map((bone) => [bone.name, bone])),
            root: records[rig.joints.findIndex((joint) => joint.name === rig.root)]!,
            jointBindPoses: rig.joints.map((joint) => {
                const parentIndex = joint.nearestConfiguredParent === null ? -1 : rig.joints.findIndex((candidate) => candidate.name === joint.nearestConfiguredParent);
                const parent = parentIndex < 0 ? null : rig.joints[parentIndex]!;
                const parentRotation = parent === null ? identity : bindWorldRotation(parent);
                return {
                    rotation: bindWorldRotation(joint),
                    colliderOffset: colliderOffsetWorld(joint),
                    parentIndex,
                    parentLocalOffset:
                        parent === null
                            ? { x: 0, y: 0, z: 0 }
                            : rotateByQuaternion(
                                  { x: -parentRotation.x, y: -parentRotation.y, z: -parentRotation.z, w: parentRotation.w },
                                  {
                                      x: joint.bindWorldPosition[0] - parent.bindWorldPosition[0],
                                      y: joint.bindWorldPosition[1] - parent.bindWorldPosition[1],
                                      z: joint.bindWorldPosition[2] - parent.bindWorldPosition[2],
                                  }
                              ),
                };
            }),
            poseOrder: rig.joints
                .map((_, index) => index)
                .sort((left, right) => {
                    const depth = (index: number): number => {
                        const parent = rig.joints[index]!.nearestConfiguredParent;
                        return parent === null ? 0 : depth(rig.joints.findIndex((joint) => joint.name === parent)) + 1;
                    };
                    return depth(left) - depth(right);
                }),
            posePositions: rig.joints.map(() => ({ x: 0, y: 0, z: 0 })),
            poseRotations: rig.joints.map(() => ({ x: 0, y: 0, z: 0, w: 1 })),
        } as unknown as RagdollState;
        const assets = { rig, bunnySkeleton: skeleton } as unknown as PlayroomAssets;

        syncBunnyPose(assets, ragdoll);

        expect(bake).toHaveBeenCalledTimes(1);
        expect(skeleton._overrides.size).toBe(0);
        expect(skeleton._worldOverrides.size).toBe(rig.joints.length);
        for (const [index, joint] of rig.joints.entries()) {
            const matrix = skeleton._worldOverrides.get(index)!;
            const expectedPosition = ragdoll.posePositions[index]!;
            [expectedPosition.x, expectedPosition.y, expectedPosition.z].forEach((value, axis) => expect(matrix[12 + axis]).toBeCloseTo(value / rig.gameScale, 5));
            const bodyRotation = records[index]!.mesh.rotationQuaternion;
            const desiredRotation = multiplyQuaternions(bodyRotation, bindWorldRotation(joint));
            const expectedAxes = [
                rotateByQuaternion(desiredRotation, { x: -1, y: 0, z: 0 }),
                rotateByQuaternion(desiredRotation, { x: 0, y: 1, z: 0 }),
                rotateByQuaternion(desiredRotation, { x: 0, y: 0, z: 1 }),
            ];
            expectedAxes.forEach((axis, axisIndex) => {
                const offset = axisIndex * 4;
                expect(matrix[offset]).toBeCloseTo(axis.x, 5);
                expect(matrix[offset + 1]).toBeCloseTo(axis.y, 5);
                expect(matrix[offset + 2]).toBeCloseTo(axis.z, 5);
            });
        }
        const armIndex = rig.joints.findIndex((joint) => joint.name === "arm_r");
        const armMatrix = skeleton._worldOverrides.get(armIndex)!;
        expect(armMatrix[12]).not.toBeCloseTo(records[armIndex]!.mesh.position.x / rig.gameScale, 2);
    });

    it("keeps joint anchors coincident and uses source joint axes", () => {
        const parent = rig.joints.find((joint) => joint.name === "root")!;
        const child = rig.joints.find((joint) => joint.name === "arm_r")!;
        const launch = { x: 1, y: 2, z: 3 };
        const pivots = ragdollJointPivots(parent, child, launch);
        const parentBody = ragdollBodyPosition(parent, launch);
        const childBody = ragdollBodyPosition(child, launch);
        expect(parentBody.x + pivots.pivotA.x).toBeCloseTo(childBody.x + pivots.pivotB.x, 6);
        expect(parentBody.y + pivots.pivotA.y).toBeCloseTo(childBody.y + pivots.pivotB.y, 6);
        expect(child.jointAxis).toEqual([0, 0, 1]);
        expect(Math.hypot(...Object.values(bindWorldRotation(child)))).toBeCloseTo(1, 6);
    });

    it("restores every body at the spawn pose but leaves it dynamic with physics-driven transforms", () => {
        const { physics, ragdoll, hknp } = makeLifecycleFixture();

        relocateBunny(physics, ragdoll, { x: 0, y: 1, z: 0 });

        expect(ragdoll.launched).toBe(false);
        expect(hknp.HP_Body_SetQTransform).toHaveBeenCalledTimes(10);
        expect(hknp.HP_Body_SetLinearVelocity).toHaveBeenCalledTimes(10);
        expect(hknp.HP_Body_SetAngularVelocity).toHaveBeenCalledTimes(10);
        for (const [index, record] of ragdoll.records.entries()) {
            expect(record.body.motionType).toBe(PhysicsMotionType.DYNAMIC);
            expect(record.body._prestepType).toBe(PhysicsPrestepType.DISABLED);
            expect(hknp.linearVelocities.get(index + 1)).toEqual([0, 0, 0]);
            expect(hknp.angularVelocities.get(index + 1)).toEqual([0, 0, 0]);
            expect(hknp.transforms.get(index + 1)![1]).toEqual([0, 0, 0, 1]);
        }
    });

    it("applies one source-strength force from the current dynamic pose without teleporting on Kick", () => {
        const { physics, ragdoll, hknp, events } = makeLifecycleFixture();
        relocateBunny(physics, ragdoll, { x: 0, y: 1, z: 0 });
        const settledPosition = { x: 0.25, y: 0.22, z: -0.15 };
        setPhysicsBodyTransform(physics, ragdoll.root.body, settledPosition, identity);
        events.length = 0;
        hknp.HP_Body_SetMotionType.mockClear();
        hknp.HP_Body_SetQTransform.mockClear();
        hknp.HP_Body_SetLinearVelocity.mockClear();
        hknp.HP_Body_SetAngularVelocity.mockClear();
        hknp.HP_Body_ApplyImpulse.mockClear();

        launchBunny(physics, ragdoll, { x: 0.6, y: 0, z: 0.8 });
        launchBunny(physics, ragdoll, { x: 0.6, y: 0, z: 0.8 });

        expect(ragdoll.launched).toBe(true);
        expect(ragdoll.records.every((record) => record.body.motionType === PhysicsMotionType.DYNAMIC)).toBe(true);
        expect(ragdoll.records.every((record) => record.body._prestepType === PhysicsPrestepType.DISABLED)).toBe(true);
        expect(hknp.HP_Body_ApplyImpulse).toHaveBeenCalledTimes(1);
        expect(hknp.HP_Body_SetMotionType).not.toHaveBeenCalled();
        expect(hknp.HP_Body_SetQTransform).not.toHaveBeenCalled();
        expect(hknp.HP_Body_SetLinearVelocity).not.toHaveBeenCalled();
        expect(hknp.HP_Body_SetAngularVelocity).not.toHaveBeenCalled();
        expect(ragdoll.root.mesh.position).toMatchObject(settledPosition);
        expect(hknp.appliedForcePoints).toEqual([[settledPosition.x, settledPosition.y, settledPosition.z]]);
        expect(Number(events.find((event) => event.startsWith("force:"))!.split(":")[2])).toBeCloseTo(500, 6);
    });
});
