import {
    addToScene,
    applyPhysicsBodyForce,
    bakeSkeleton,
    cloneTransformNode,
    createPhysicsBody,
    createPhysicsConstraint,
    createPhysicsShape,
    createTransformNode,
    getBoneByName,
    onPhysicsAfterStep,
    PhysicsConstraintType,
    PhysicsMotionType,
    PhysicsPrestepType,
    PhysicsShapeType,
    releasePhysicsConstraint,
    releasePhysicsShape,
    removeFromScene,
    removePhysicsBody,
    setBoneWorldPoseDeferred,
    setPhysicsBodyAngularVelocity,
    setPhysicsBodyLinearVelocity,
    setPhysicsBodyMass,
    setPhysicsBodyMotionType,
    setPhysicsBodyPrestepType,
    setPhysicsBodyShape,
    setPhysicsShapeMaterial,
    setPhysicsBodyTransform,
} from "babylon-lite";
import type { PhysicsWorld, Quat, SceneContext, SceneNode, Vec3 } from "babylon-lite";
import { THROW_FORCE } from "./constants.js";
import type { BodyRecord, BunnyRigJoint, PlayroomAssets, RagdollState, WorldState } from "./types.js";

function quaternionMultiply(a: Quat, b: Quat): Quat {
    return {
        x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
        y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
        z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
        w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    };
}

function quaternionInverse(q: Quat): Quat {
    const inverseLengthSquared = 1 / Math.max(1e-12, q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    return { x: -q.x * inverseLengthSquared, y: -q.y * inverseLengthSquared, z: -q.z * inverseLengthSquared, w: q.w * inverseLengthSquared };
}

function normalizeQuaternion(q: Quat): Quat {
    const inverseLength = 1 / Math.max(1e-12, Math.hypot(q.x, q.y, q.z, q.w));
    return { x: q.x * inverseLength, y: q.y * inverseLength, z: q.z * inverseLength, w: q.w * inverseLength };
}

function multiplyQuaternionToRef(a: Quat, b: Quat, result: Quat): void {
    result.x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
    result.y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
    result.z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
    result.w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
    const inverseLength = 1 / Math.max(1e-12, Math.hypot(result.x, result.y, result.z, result.w));
    result.x *= inverseLength;
    result.y *= inverseLength;
    result.z *= inverseLength;
    result.w *= inverseLength;
}

function rotateVectorToRef(rotation: Quat, vector: Vec3, result: Vec3): void {
    const { x, y, z, w } = rotation;
    const inverseLengthSquared = 1 / Math.max(1e-12, x * x + y * y + z * z + w * w);
    const dot = x * vector.x + y * vector.y + z * vector.z;
    const crossX = y * vector.z - z * vector.y;
    const crossY = z * vector.x - x * vector.z;
    const crossZ = x * vector.y - y * vector.x;
    const vectorScale = w * w - x * x - y * y - z * z;
    result.x = (2 * dot * x + vectorScale * vector.x + 2 * w * crossX) * inverseLengthSquared;
    result.y = (2 * dot * y + vectorScale * vector.y + 2 * w * crossY) * inverseLengthSquared;
    result.z = (2 * dot * z + vectorScale * vector.z + 2 * w * crossZ) * inverseLengthSquared;
}

export function bindWorldRotation(joint: BunnyRigJoint): Quat {
    const matrix = joint.bindWorldMatrix;
    const m00 = matrix[0]!;
    const m01 = matrix[4]!;
    const m02 = matrix[8]!;
    const m10 = matrix[1]!;
    const m11 = matrix[5]!;
    const m12 = matrix[9]!;
    const m20 = matrix[2]!;
    const m21 = matrix[6]!;
    const m22 = matrix[10]!;
    const trace = m00 + m11 + m22;
    let rotation: Quat;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        rotation = { x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s, w: s * 0.25 };
    } else if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        rotation = { x: s * 0.25, y: (m01 + m10) / s, z: (m02 + m20) / s, w: (m21 - m12) / s };
    } else if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        rotation = { x: (m01 + m10) / s, y: s * 0.25, z: (m12 + m21) / s, w: (m02 - m20) / s };
    } else {
        const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
        rotation = { x: (m02 + m20) / s, y: (m12 + m21) / s, z: s * 0.25, w: (m10 - m01) / s };
    }
    return normalizeQuaternion(rotation);
}

function rotateVector(rotation: Quat, vector: Vec3): Vec3 {
    const qVector = { x: vector.x, y: vector.y, z: vector.z, w: 0 };
    const rotated = quaternionMultiply(quaternionMultiply(rotation, qVector), quaternionInverse(rotation));
    return { x: rotated.x, y: rotated.y, z: rotated.z };
}

export function colliderOffsetWorld(joint: BunnyRigJoint): Vec3 {
    return rotateVector(bindWorldRotation(joint), {
        x: joint.axis[0] * joint.boxOffset,
        y: joint.axis[1] * joint.boxOffset,
        z: joint.axis[2] * joint.boxOffset,
    });
}

export function currentColliderOffsetWorld(joint: BunnyRigJoint, bodyRotation: Quat): Vec3 {
    return rotateVector(bodyRotation, colliderOffsetWorld(joint));
}

function scaledDimensions(joint: BunnyRigJoint): Vec3 {
    const size = joint.size;
    return {
        x: joint.width ?? size ?? 0.1,
        y: joint.height ?? size ?? 0.1,
        z: joint.depth ?? size ?? 0.1,
    };
}

export function ragdollBodyPosition(joint: BunnyRigJoint, launch: Vec3): Vec3 {
    const offset = colliderOffsetWorld(joint);
    return {
        x: launch.x + joint.bindWorldPosition[0] + offset.x,
        y: launch.y + joint.bindWorldPosition[1] + offset.y,
        z: launch.z + joint.bindWorldPosition[2] + offset.z,
    };
}

export function ragdollJointPivots(parent: BunnyRigJoint, child: BunnyRigJoint, launch: Vec3): { pivotA: Vec3; pivotB: Vec3 } {
    const anchor = {
        x: launch.x + child.bindWorldPosition[0],
        y: launch.y + child.bindWorldPosition[1],
        z: launch.z + child.bindWorldPosition[2],
    };
    const parentPosition = ragdollBodyPosition(parent, launch);
    const childPosition = ragdollBodyPosition(child, launch);
    return {
        pivotA: { x: anchor.x - parentPosition.x, y: anchor.y - parentPosition.y, z: anchor.z - parentPosition.z },
        pivotB: { x: anchor.x - childPosition.x, y: anchor.y - childPosition.y, z: anchor.z - childPosition.z },
    };
}

function addBody(scene: SceneContext, physics: PhysicsWorld, world: WorldState, joint: BunnyRigJoint, launch: Vec3): BodyRecord {
    const position = ragdollBodyPosition(joint, launch);
    const node = createTransformNode(`ragdoll-${joint.name}`, position.x, position.y, position.z);
    const shape = createPhysicsShape(physics, { type: PhysicsShapeType.BOX, parameters: { extents: scaledDimensions(joint) } });
    setPhysicsShapeMaterial(physics, shape, 0.6, 0);
    const body = createPhysicsBody(physics, node, PhysicsMotionType.DYNAMIC);
    setPhysicsBodyPrestepType(body, PhysicsPrestepType.DISABLED);
    setPhysicsBodyShape(physics, body, shape);
    setPhysicsBodyMass(physics, body, 0.08);
    const record: BodyRecord = {
        id: world.nextBodyId++,
        family: "ragdoll",
        body,
        mesh: node,
        mass: 0.08,
        shape,
        scored: new Set(),
        audioTags: ["soft", "projectile"],
        active: true,
        resetGeneration: 0,
    };
    world.records.push(record);
    world.bodiesByObject.set(body, record);
    world.shapes.push(shape);
    addToScene(scene, node);
    return record;
}

function cloneBunny(scene: SceneContext, assets: PlayroomAssets): SceneNode {
    const visualRoot = cloneTransformNode(assets.bunnyRoot);
    const visit = (node: SceneNode): void => {
        if ("material" in node) {
            node.scaling.set(assets.rig.gameScale, assets.rig.gameScale, assets.rig.gameScale);
        }
        for (const child of node.children) {
            visit(child);
        }
    };
    visit(visualRoot);
    addToScene(scene, visualRoot);
    return visualRoot;
}

export function createBunnyRagdoll(scene: SceneContext, physics: PhysicsWorld, assets: PlayroomAssets, world: WorldState, launch: Vec3): RagdollState {
    const visualRoot = cloneBunny(scene, assets);
    const records = assets.rig.joints.map((joint) => addBody(scene, physics, world, joint, launch));
    const jointIndexByName = new Map(assets.rig.joints.map((joint, index) => [joint.name, index]));
    const byName = new Map(assets.rig.joints.map((joint, index) => [joint.name, { joint, record: records[index]! }]));
    const constraints = [];
    for (const joint of assets.rig.joints) {
        if (!joint.nearestConfiguredParent) {
            continue;
        }
        const parent = byName.get(joint.nearestConfiguredParent)!;
        const child = byName.get(joint.name)!;
        const pivots = ragdollJointPivots(parent.joint, joint, launch);
        const constraint = createPhysicsConstraint(physics, parent.record.body, child.record.body, PhysicsConstraintType.BALL_AND_SOCKET, {
            pivotA: pivots.pivotA,
            pivotB: pivots.pivotB,
            axisA: { x: (joint.jointAxis ?? joint.axis)[0], y: (joint.jointAxis ?? joint.axis)[1], z: (joint.jointAxis ?? joint.axis)[2] },
            axisB: { x: (joint.jointAxis ?? joint.axis)[0], y: (joint.jointAxis ?? joint.axis)[1], z: (joint.jointAxis ?? joint.axis)[2] },
            collision: false,
        });
        constraints.push(constraint);
        world.constraints.push(constraint);
    }
    const bones = Object.fromEntries(assets.rig.joints.map((joint) => [joint.name, getBoneByName(assets.bunnySkeleton, joint.name)]));
    const root = byName.get(assets.rig.root)!.record;
    const jointBindPoses = assets.rig.joints.map((joint) => {
        const parentIndex = joint.nearestConfiguredParent === null ? -1 : jointIndexByName.get(joint.nearestConfiguredParent)!;
        const parent = parentIndex < 0 ? null : assets.rig.joints[parentIndex]!;
        return {
            rotation: bindWorldRotation(joint),
            colliderOffset: colliderOffsetWorld(joint),
            parentIndex,
            parentLocalOffset:
                parent === null
                    ? { x: 0, y: 0, z: 0 }
                    : rotateVector(quaternionInverse(bindWorldRotation(parent)), {
                          x: joint.bindWorldPosition[0] - parent.bindWorldPosition[0],
                          y: joint.bindWorldPosition[1] - parent.bindWorldPosition[1],
                          z: joint.bindWorldPosition[2] - parent.bindWorldPosition[2],
                      }),
        };
    });
    const jointDepth = (index: number): number => {
        const parentIndex = jointBindPoses[index]!.parentIndex;
        return parentIndex < 0 ? 0 : jointDepth(parentIndex) + 1;
    };
    const ragdoll: RagdollState = {
        records,
        constraints,
        bones,
        root,
        visualRoot,
        restTransforms: records.map((record) => ({
            position: { x: record.mesh.position.x, y: record.mesh.position.y, z: record.mesh.position.z },
            rotation: {
                x: record.mesh.rotationQuaternion.x,
                y: record.mesh.rotationQuaternion.y,
                z: record.mesh.rotationQuaternion.z,
                w: record.mesh.rotationQuaternion.w,
            },
        })),
        jointBindPoses,
        poseOrder: assets.rig.joints.map((_, index) => index).sort((left, right) => jointDepth(left) - jointDepth(right)),
        posePositions: assets.rig.joints.map(() => ({ x: 0, y: 0, z: 0 })),
        poseRotations: assets.rig.joints.map(() => ({ x: 0, y: 0, z: 0, w: 1 })),
        launched: false,
    };
    syncBunnyPose(assets, ragdoll);
    return ragdoll;
}

export function syncBunnyPose(assets: PlayroomAssets, ragdoll: RagdollState): void {
    for (const index of ragdoll.poseOrder) {
        const joint = assets.rig.joints[index]!;
        const bone = ragdoll.bones[joint.name];
        const record = ragdoll.records[index]!;
        if (!bone) {
            continue;
        }
        const bodyRotation = record.mesh.rotationQuaternion;
        const bindPose = ragdoll.jointBindPoses[index]!;
        const position = ragdoll.posePositions[index]!;
        const rotation = ragdoll.poseRotations[index]!;
        multiplyQuaternionToRef(bodyRotation, bindPose.rotation, rotation);
        if (bindPose.parentIndex < 0) {
            rotateVectorToRef(bodyRotation, bindPose.colliderOffset, position);
            position.x = record.mesh.position.x - position.x;
            position.y = record.mesh.position.y - position.y;
            position.z = record.mesh.position.z - position.z;
        } else {
            const parentPosition = ragdoll.posePositions[bindPose.parentIndex]!;
            rotateVectorToRef(ragdoll.poseRotations[bindPose.parentIndex]!, bindPose.parentLocalOffset, position);
            position.x += parentPosition.x;
            position.y += parentPosition.y;
            position.z += parentPosition.z;
        }
        setBoneWorldPoseDeferred(
            assets.bunnySkeleton,
            bone,
            position.x / assets.rig.gameScale,
            position.y / assets.rig.gameScale,
            position.z / assets.rig.gameScale,
            rotation.x,
            rotation.y,
            rotation.z,
            rotation.w
        );
    }
    bakeSkeleton(assets.bunnySkeleton);
}

export function installBunnyPoseSync(physics: PhysicsWorld, assets: PlayroomAssets, getRagdoll: () => RagdollState | null, isDisposed: () => boolean): void {
    onPhysicsAfterStep(physics, () => {
        const ragdoll = getRagdoll();
        if (!isDisposed() && ragdoll) {
            syncBunnyPose(assets, ragdoll);
        }
    });
}

export function launchBunny(physics: PhysicsWorld, ragdoll: RagdollState, direction: Vec3): void {
    if (ragdoll.launched) {
        return;
    }
    const point = ragdoll.root.mesh.position;
    applyPhysicsBodyForce(physics, ragdoll.root.body, { x: direction.x * THROW_FORCE, y: direction.y * THROW_FORCE, z: direction.z * THROW_FORCE }, point);
    ragdoll.launched = true;
}

function restoreBodyTransforms(physics: PhysicsWorld, ragdoll: RagdollState, rootPosition: Vec3): void {
    const rootIndex = ragdoll.records.indexOf(ragdoll.root);
    const rootRest = ragdoll.restTransforms[rootIndex]!;
    const delta = {
        x: rootPosition.x - rootRest.position.x,
        y: rootPosition.y - rootRest.position.y,
        z: rootPosition.z - rootRest.position.z,
    };
    for (let index = 0; index < ragdoll.records.length; index++) {
        const record = ragdoll.records[index]!;
        const rest = ragdoll.restTransforms[index]!;
        setPhysicsBodyTransform(
            physics,
            record.body,
            { x: rest.position.x + delta.x, y: rest.position.y + delta.y, z: rest.position.z + delta.z },
            { x: rest.rotation.x, y: rest.rotation.y, z: rest.rotation.z, w: rest.rotation.w }
        );
    }
}

function clearBodyVelocities(physics: PhysicsWorld, ragdoll: RagdollState): void {
    for (const record of ragdoll.records) {
        setPhysicsBodyLinearVelocity(physics, record.body, { x: 0, y: 0, z: 0 });
        setPhysicsBodyAngularVelocity(physics, record.body, { x: 0, y: 0, z: 0 });
    }
}

export function relocateBunny(physics: PhysicsWorld, ragdoll: RagdollState, rootPosition: Vec3): void {
    for (const record of ragdoll.records) {
        setPhysicsBodyMotionType(physics, record.body, PhysicsMotionType.DYNAMIC);
    }
    for (const record of ragdoll.records) {
        setPhysicsBodyPrestepType(record.body, PhysicsPrestepType.DISABLED);
    }
    restoreBodyTransforms(physics, ragdoll, rootPosition);
    clearBodyVelocities(physics, ragdoll);
    ragdoll.launched = false;
}

export function disposeBunny(scene: SceneContext, physics: PhysicsWorld, world: WorldState, ragdoll: RagdollState): void {
    for (const constraint of ragdoll.constraints) {
        releasePhysicsConstraint(physics, constraint);
    }
    for (const record of ragdoll.records) {
        if (world.bodiesByObject.has(record.body)) {
            removePhysicsBody(physics, record.body);
            world.bodiesByObject.delete(record.body);
        }
        if (record.shape) {
            releasePhysicsShape(physics, record.shape);
        }
        removeFromScene(scene, record.mesh);
    }
    world.constraints.splice(0, world.constraints.length, ...world.constraints.filter((constraint) => !ragdoll.constraints.includes(constraint)));
    world.records.splice(0, world.records.length, ...world.records.filter((record) => !ragdoll.records.includes(record)));
    world.shapes.splice(0, world.shapes.length, ...world.shapes.filter((shape) => !ragdoll.records.some((record) => record.shape === shape)));
    removeFromScene(scene, ragdoll.visualRoot);
}
