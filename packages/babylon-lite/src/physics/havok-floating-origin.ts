/**
 * Havok multi-region floating origin (Large World Rendering).
 *
 * This module is **dynamic-imported only when the engine has `useFloatingOrigin: true`**
 * (from `createHavokWorld`), so non-floating-origin physics scenes never pull this code into
 * their bundle.
 *
 * Under floating origin, bodies far apart in world space are simulated in separate regions —
 * each a native Havok world with a fixed `origin`. Bodies are stored in region-local coordinates
 * (`worldPos - origin`, near zero), so the float32 Havok solver keeps full precision at large
 * world coordinates. Node transforms remain true world coordinates; the eye-relative render path
 * is handled independently.
 *
 * Mirrors Babylon.js's `scene.floatingOriginMode` + Havok plugin `floatingOriginWorldRadius`.
 */

import type { Vec3 } from "../math/types.js";
import type { PhysicsBody, PhysicsWorld } from "./havok.js";
import { PhysicsMotionType } from "./havok.js";

/**
 * A simulation region: a native Havok world whose bodies are simulated relative to a fixed
 * `origin`. `_regions[0]` is the default region (origin at the world origin).
 */
export interface WorldRegion {
    /** @internal */ _world: any;
    /** Floating origin (world-space centre) this region's bodies are stored relative to. */
    origin: Vec3;
    /** This region's gravity vector `[x, y, z]`. */
    gravity: number[];
}

/**
 * Floating-origin runtime stored on `PhysicsWorld._fo` (present only when floating origin is on).
 * Holds region state plus the standalone hooks the core physics module calls in place of its
 * single-world fast path.
 */
export interface HavokFloatingOriginContext {
    /** All simulation regions; `regions[0]` is the default (origin-centred) region. */
    regions: WorldRegion[];
    /** Region capture radius (metres). */
    radius: number;
    /** Most recently set world-wide gravity `[x, y, z]`; seeds newly created regions. */
    gravity: number[];
    placeBody(world: PhysicsWorld, body: PhysicsBody, startsAsleep: boolean): void;
    step(world: PhysicsWorld): void;
    setGravity(world: PhysicsWorld, gravity: number[], worldPosition?: Vec3): void;
    getRegionGravity(world: PhysicsWorld, worldPosition: Vec3): number[];
    setVelocityLimits(world: PhysicsWorld, maxLinear: number, maxAngular: number): void;
    dispose(world: PhysicsWorld): void;
}

/**
 * Builds the floating-origin context, seeding it with the world's default region (the native world
 * already created by `createHavokWorld`, centred at the origin).
 */
export function createHavokFloatingOriginContext(hkWorld: any, gravity: number[], radius: number): HavokFloatingOriginContext {
    return {
        regions: [{ _world: hkWorld, origin: { x: 0, y: 0, z: 0 }, gravity: [...gravity] }],
        radius,
        gravity: [...gravity],
        placeBody: _placeBody,
        step: _step,
        setGravity: _setGravity,
        getRegionGravity: _getRegionGravity,
        setVelocityLimits: _setVelocityLimits,
        dispose: _dispose,
    };
}

// ─── Region lookup / creation ────────────────────────────────────────

/** Returns the region whose origin is within the capture radius of `pos`, or null. */
function _findRegion(fo: HavokFloatingOriginContext, pos: Vec3): WorldRegion | null {
    const r2 = fo.radius * fo.radius;
    for (const region of fo.regions) {
        const dx = pos.x - region.origin.x;
        const dy = pos.y - region.origin.y;
        const dz = pos.z - region.origin.z;
        if (dx * dx + dy * dy + dz * dz <= r2) {
            return region;
        }
    }
    return null;
}

/** Returns an existing region containing `pos`, or creates a new one centred at `pos`. */
function _getOrCreateRegion(world: PhysicsWorld, pos: Vec3): WorldRegion {
    const fo = world._fo!;
    const found = _findRegion(fo, pos);
    if (found) {
        return found;
    }
    const hknp = world._hknp;
    const newWorld = hknp.HP_World_Create()[1];
    hknp.HP_World_SetGravity(newWorld, fo.gravity);
    const limits = hknp.HP_World_GetSpeedLimit(world._hkWorld);
    hknp.HP_World_SetSpeedLimit(newWorld, limits[1], limits[2]);
    const region: WorldRegion = {
        _world: newWorld,
        origin: { x: pos.x, y: pos.y, z: pos.z },
        gravity: [...fo.gravity],
    };
    fo.regions.push(region);
    return region;
}

// ─── Hooks ───────────────────────────────────────────────────────────

function _placeBody(world: PhysicsWorld, body: PhysicsBody, startsAsleep: boolean): void {
    const hknp = world._hknp;
    const node = body.node;
    const region = _getOrCreateRegion(world, node.position);
    hknp.HP_World_AddBody(region._world, body._hkBody, startsAsleep);
    const p = node.position;
    const q = node.rotationQuaternion;
    const o = region.origin;
    hknp.HP_Body_SetQTransform(body._hkBody, [
        [p.x - o.x, p.y - o.y, p.z - o.z],
        [q.x, q.y, q.z, q.w],
    ]);
    body._region = region;
}

function _step(world: PhysicsWorld): void {
    const hknp = world._hknp;
    const bodies = world._bodies;
    const regions = world._fo!.regions;

    // Re-region bodies that drifted out of their region BEFORE stepping.
    for (let i = 0; i < bodies.length; i++) {
        _reRegionBody(world, bodies[i]!);
    }

    // Pre-step: sync ANIMATED bodies from node → Havok.
    for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i]!;
        if (b.motionType === (PhysicsMotionType.ANIMATED as number)) {
            _syncNodeToBody(hknp, b);
        }
    }

    // Step every region world.
    for (let i = 0; i < regions.length; i++) {
        hknp.HP_World_Step(regions[i]!._world, world._timestep);
    }

    // Post-step: sync DYNAMIC bodies from Havok → node.
    for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i]!;
        if (b.motionType === (PhysicsMotionType.DYNAMIC as number)) {
            _syncBodyToNode(hknp, b);
        }
    }

    // Reclaim regions emptied by migration.
    _gcRegions(world);
}

function _setGravity(world: PhysicsWorld, gravity: number[], worldPosition?: Vec3): void {
    const fo = world._fo!;
    const hknp = world._hknp;
    if (worldPosition) {
        const region = _getOrCreateRegion(world, worldPosition);
        region.gravity = gravity;
        hknp.HP_World_SetGravity(region._world, gravity);
        return;
    }
    fo.gravity = gravity;
    for (const region of fo.regions) {
        region.gravity = gravity;
        hknp.HP_World_SetGravity(region._world, gravity);
    }
}

function _getRegionGravity(world: PhysicsWorld, worldPosition: Vec3): number[] {
    return _getOrCreateRegion(world, worldPosition).gravity;
}

function _setVelocityLimits(world: PhysicsWorld, maxLinear: number, maxAngular: number): void {
    for (const region of world._fo!.regions) {
        world._hknp.HP_World_SetSpeedLimit(region._world, maxLinear, maxAngular);
    }
}

function _dispose(world: PhysicsWorld): void {
    const hknp = world._hknp;
    const bodies = world._bodies;
    for (let i = bodies.length - 1; i >= 0; i--) {
        const b = bodies[i]!;
        hknp.HP_World_RemoveBody(b._region!._world, b._hkBody);
        hknp.HP_Body_Release(b._hkBody);
    }
    bodies.length = 0;
    const regions = world._fo!.regions;
    for (const region of regions) {
        hknp.HP_World_Release(region._world);
    }
    regions.length = 0;
}

// ─── Migration & sync ────────────────────────────────────────────────

/**
 * Moves a body to the correct region if it has drifted past `radius * 1.2` (hysteresis) from its
 * current region's origin, preserving linear and angular velocity. Uses a one-second velocity
 * look-ahead to prefer joining an existing target region over spawning a throwaway one.
 */
function _reRegionBody(world: PhysicsWorld, body: PhysicsBody): void {
    const hknp = world._hknp;
    const fo = world._fo!;
    const current = body._region!;

    const t = hknp.HP_Body_GetQTransform(body._hkBody)[1];
    const localPos = t[0];
    const orientation = t[1];

    // Distance from region origin == magnitude of the local position.
    const margin = fo.radius * 1.2;
    if (localPos[0] * localPos[0] + localPos[1] * localPos[1] + localPos[2] * localPos[2] <= margin * margin) {
        return;
    }

    const wx = localPos[0] + current.origin.x;
    const wy = localPos[1] + current.origin.y;
    const wz = localPos[2] + current.origin.z;

    const linVel = hknp.HP_Body_GetLinearVelocity(body._hkBody)[1];
    const angVel = hknp.HP_Body_GetAngularVelocity(body._hkBody)[1];

    const worldPos: Vec3 = { x: wx, y: wy, z: wz };
    const lookAhead: Vec3 = { x: wx + linVel[0], y: wy + linVel[1], z: wz + linVel[2] };

    let next = _findRegion(fo, lookAhead);
    if (!next || next === current) {
        next = _findRegion(fo, worldPos);
    }
    if (!next || next === current) {
        next = _getOrCreateRegion(world, worldPos);
    }
    if (next === current) {
        return;
    }

    hknp.HP_World_RemoveBody(current._world, body._hkBody);
    const o = next.origin;
    hknp.HP_Body_SetQTransform(body._hkBody, [[wx - o.x, wy - o.y, wz - o.z], orientation]);
    hknp.HP_World_AddBody(next._world, body._hkBody, false);
    hknp.HP_Body_SetLinearVelocity(body._hkBody, linVel);
    hknp.HP_Body_SetAngularVelocity(body._hkBody, angVel);
    body._region = next;
}

/** Releases any non-default region that no longer holds any bodies. */
function _gcRegions(world: PhysicsWorld): void {
    const regions = world._fo!.regions;
    if (regions.length <= 1) {
        return;
    }
    const hknp = world._hknp;
    const used = new Set<WorldRegion>();
    for (let i = 0; i < world._bodies.length; i++) {
        used.add(world._bodies[i]!._region!);
    }
    for (let i = regions.length - 1; i >= 1; i--) {
        const region = regions[i]!;
        if (!used.has(region)) {
            hknp.HP_World_Release(region._world);
            regions.splice(i, 1);
        }
    }
}

function _syncBodyToNode(hknp: any, body: PhysicsBody): void {
    const t = hknp.HP_Body_GetQTransform(body._hkBody)[1];
    const pos = t[0]; // [x, y, z] in region-local space
    const rot = t[1]; // [x, y, z, w]
    const o = body._region!.origin;
    const node = body.node;
    node.position.set(pos[0] + o.x, pos[1] + o.y, pos[2] + o.z);
    node.rotationQuaternion.set(rot[0], rot[1], rot[2], rot[3]);
}

function _syncNodeToBody(hknp: any, body: PhysicsBody): void {
    const node = body.node;
    const p = node.position;
    const q = node.rotationQuaternion;
    const o = body._region!.origin;
    hknp.HP_Body_SetQTransform(body._hkBody, [
        [p.x - o.x, p.y - o.y, p.z - o.z],
        [q.x, q.y, q.z, q.w],
    ]);
}
