import type { NativeMassProperties } from "./havok-mass-properties.js";
import type { PhysicsBody, PhysicsRotationAxis, PhysicsWorld } from "./havok.js";

export function cloneMassProperties(properties: any[]): NativeMassProperties {
    return [[...properties[0]], properties[1], [...properties[2]], [...properties[3]]];
}

/**
 * Lock angular motion around selected body-local axes.
 * Havok represents a locked angular degree of freedom with zero inertia.
 * Locks are cumulative and remain active when the body's mass properties are rebuilt.
 */
export function lockPhysicsBodyRotationAxes(world: PhysicsWorld, body: PhysicsBody, axes: readonly PhysicsRotationAxis[]): void {
    const requestedMask = physicsRotationAxesMask(axes);
    if (requestedMask === 0) {
        return;
    }
    const count = world._thin?.count(body);
    if (count !== undefined) {
        lockThinBodyRotationAxes(world, body, requestedMask, count);
        return;
    }
    const previousMask = body._rotationLockMask ?? 0;
    const mask = previousMask | requestedMask;
    if (mask === previousMask) {
        return;
    }
    let source = body._rotationLockSource;
    if (previousMask === 0) {
        const hknp = world._hknp;
        const result = hknp.HP_Body_GetMassProperties(body._hkBody);
        const ok = hknp.Result?.RESULT_OK ?? 0;
        if (result[0] !== ok) {
            throw new Error("Failed to read physics body mass properties.");
        }
        source = cloneMassProperties(result[1]);
    }
    const massProperties = cloneMassProperties(source!);
    applyBodyRotationLocks(massProperties, mask);
    world._hknp.HP_Body_SetMassProperties(body._hkBody, massProperties);
    body._rotationLockMask = mask;
    body._rotationLockSource = source;
    body._massPropertiesTransform ??= (properties) => {
        body._rotationLockSource = cloneMassProperties(properties);
        applyBodyRotationLocks(properties, body._rotationLockMask ?? 0);
    };
}

/**
 * Unlock angular motion around selected body-local axes.
 * Axes that remain locked continue to be reapplied when mass properties are rebuilt.
 */
export function unlockPhysicsBodyRotationAxes(world: PhysicsWorld, body: PhysicsBody, axes: readonly PhysicsRotationAxis[]): void {
    const requestedMask = physicsRotationAxesMask(axes);
    const count = world._thin?.count(body);
    if (count !== undefined) {
        unlockThinBodyRotationAxes(world, body, requestedMask, count);
        return;
    }
    const previousMask = body._rotationLockMask ?? 0;
    const mask = previousMask & ~requestedMask;
    if (mask === previousMask) {
        return;
    }
    const massProperties = cloneMassProperties(body._rotationLockSource!);
    applyBodyRotationLocks(massProperties, mask);
    world._hknp.HP_Body_SetMassProperties(body._hkBody, massProperties);
    body._rotationLockMask = mask || undefined;
    if (mask === 0) {
        body._rotationLockSource = undefined;
        body._massPropertiesTransform = undefined;
    }
}

function lockThinBodyRotationAxes(world: PhysicsWorld, body: PhysicsBody, requestedMask: number, count: number): void {
    const previousMask = body._rotationLockMask ?? 0;
    const mask = previousMask | requestedMask;
    if (mask === previousMask) {
        return;
    }
    let sources = body._rotationLockSources;
    if (previousMask === 0) {
        sources = new Array<NativeMassProperties>(count);
        const ok = world._hknp.Result?.RESULT_OK ?? 0;
        for (let index = 0; index < count; index++) {
            const result = world._hknp.HP_Body_GetMassProperties(world._thin!.instance(body, index));
            if (result[0] !== ok) {
                throw new Error("Failed to read physics body mass properties.");
            }
            sources[index] = cloneMassProperties(result[1]);
        }
    }
    applyThinBodyRotationLocks(world, body, sources!, mask, count);
    body._rotationLockSources = sources;
    body._rotationLockMask = mask;
    body._massPropertiesTransform ??= (properties, instanceIndex) => {
        sources![instanceIndex!] = cloneMassProperties(properties);
        applyBodyRotationLocks(properties, body._rotationLockMask ?? 0);
    };
}

function unlockThinBodyRotationAxes(world: PhysicsWorld, body: PhysicsBody, requestedMask: number, count: number): void {
    const previousMask = body._rotationLockMask ?? 0;
    const mask = previousMask & ~requestedMask;
    if (mask === previousMask) {
        return;
    }
    applyThinBodyRotationLocks(world, body, body._rotationLockSources!, mask, count);
    body._rotationLockMask = mask || undefined;
    if (mask === 0) {
        body._rotationLockSources = undefined;
        body._massPropertiesTransform = undefined;
    }
}

function applyThinBodyRotationLocks(world: PhysicsWorld, body: PhysicsBody, sources: NativeMassProperties[], mask: number, count: number): void {
    for (let index = 0; index < count; index++) {
        const massProperties = cloneMassProperties(sources[index]!);
        applyBodyRotationLocks(massProperties, mask);
        world._hknp.HP_Body_SetMassProperties(world._thin!.instance(body, index), massProperties);
    }
}

function physicsRotationAxesMask(axes: readonly PhysicsRotationAxis[]): number {
    let mask = 0;
    for (const axis of axes) {
        if (axis === "x") {
            mask |= 1;
        } else if (axis === "y") {
            mask |= 2;
        } else if (axis === "z") {
            mask |= 4;
        } else {
            throw new Error(`Unknown physics rotation axis "${String(axis)}".`);
        }
    }
    return mask;
}

export function applyBodyRotationLocks(properties: NativeMassProperties, mask: number): void {
    if (mask === 0) {
        return;
    }
    const inertia = properties[2];
    const q = properties[3];
    const x = q[0]!,
        y = q[1]!,
        z = q[2]!,
        w = q[3]!;
    const xx = x * x,
        yy = y * y,
        zz = z * z,
        xy = x * y,
        xz = x * z,
        yz = y * z,
        xw = x * w,
        yw = y * w,
        zw = z * w;
    const r00 = 1 - 2 * (yy + zz),
        r01 = 2 * (xy - zw),
        r02 = 2 * (xz + yw),
        r10 = 2 * (xy + zw),
        r11 = 1 - 2 * (xx + zz),
        r12 = 2 * (yz - xw),
        r20 = 2 * (xz - yw),
        r21 = 2 * (yz + xw),
        r22 = 1 - 2 * (xx + yy);
    const ixx = r00 * r00 * inertia[0]! + r01 * r01 * inertia[1]! + r02 * r02 * inertia[2]!;
    const iyy = r10 * r10 * inertia[0]! + r11 * r11 * inertia[1]! + r12 * r12 * inertia[2]!;
    const izz = r20 * r20 * inertia[0]! + r21 * r21 * inertia[1]! + r22 * r22 * inertia[2]!;
    if (mask === 1) {
        setSingleAxisLockedInertia(properties, 0, iyy, izz, r10 * r20 * inertia[0]! + r11 * r21 * inertia[1]! + r12 * r22 * inertia[2]!);
        return;
    }
    if (mask === 2) {
        setSingleAxisLockedInertia(properties, 1, ixx, izz, -(r00 * r20 * inertia[0]! + r01 * r21 * inertia[1]! + r02 * r22 * inertia[2]!));
        return;
    }
    if (mask === 4) {
        setSingleAxisLockedInertia(properties, 2, ixx, iyy, r00 * r10 * inertia[0]! + r01 * r11 * inertia[1]! + r02 * r12 * inertia[2]!);
        return;
    }
    properties[2] = [mask & 1 ? 0 : ixx, mask & 2 ? 0 : iyy, mask & 4 ? 0 : izz];
    properties[3] = [0, 0, 0, 1];
}

function setSingleAxisLockedInertia(properties: NativeMassProperties, axis: number, a: number, b: number, coupling: number): void {
    if (coupling === 0) {
        properties[2] = axis === 0 ? [0, a, b] : axis === 1 ? [a, 0, b] : [a, b, 0];
        properties[3] = [0, 0, 0, 1];
        return;
    }
    const mean = (a + b) * 0.5;
    const radius = Math.hypot((a - b) * 0.5, coupling);
    const halfAngle = Math.atan2(2 * coupling, a - b) * 0.25;
    const s = Math.sin(halfAngle);
    const q = [0, 0, 0, Math.cos(halfAngle)];
    q[axis] = s;
    properties[2] = axis === 0 ? [0, mean + radius, mean - radius] : axis === 1 ? [mean + radius, 0, mean - radius] : [mean + radius, mean - radius, 0];
    properties[3] = q;
}
