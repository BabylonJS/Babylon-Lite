/**
 * Havok Physics V2 shape queries (proximity + cast) for Babylon Lite.
 *
 * Kept in a standalone module so the query path adds bytes only to scenes that
 * actually import {@link shapeProximity} or {@link shapeCast}. The per-frame
 * `_stepWorld` core in `havok.ts` intentionally does NOT reference this code, so
 * ordinary physics scenes pay zero for it.
 *
 * Both queries broadphase against the bodies already present in the world, so the
 * target body must be in the world (and at least one step must have run to build the
 * broadphase) before a hit is reported. Hit positions assume a normal near-origin
 * world: the floating-origin offset is zero, so no offset correction is applied.
 *
 * ```ts
 *   const prox = shapeProximity(world, { shape, position, rotation, maxDistance: 10 });
 *   if (prox.hasHit) {
 *       // prox.inputHitPoint = closest point on the query shape (query-shape local space)
 *       // prox.hitPoint      = closest point on the hit body (world space)
 *   }
 *   const cast = shapeCast(world, { shape, rotation, startPosition, endPosition });
 *   if (cast.hasHit) {
 *       // cast.hitPoint = first contact on the hit body (world space)
 *   }
 * ```
 */

import type { Quat, Vec3 } from "../math/types.js";
import type { PhysicsShape, PhysicsWorld } from "./havok.js";

/** Query parameters for {@link shapeProximity}. */
export interface ShapeProximityQuery {
    /** Shape to test for proximity. */
    shape: PhysicsShape;
    /** World-space position of the query shape. */
    position: Vec3;
    /** World-space orientation of the query shape. */
    rotation: Quat;
    /** Maximum distance to search for a nearby body. */
    maxDistance: number;
    /** Whether trigger volumes count as hits. Default `false`. */
    shouldHitTriggers?: boolean;
}

/** Query parameters for {@link shapeCast}. */
export interface ShapeCastQuery {
    /** Shape to sweep through the world. */
    shape: PhysicsShape;
    /** World-space orientation held constant during the sweep. */
    rotation: Quat;
    /** World-space sweep start position. */
    startPosition: Vec3;
    /** World-space sweep end position. */
    endPosition: Vec3;
    /** Whether trigger volumes count as hits. Default `false`. */
    shouldHitTriggers?: boolean;
}

/** Result of a {@link shapeProximity} query. */
export interface ShapeProximityResult {
    /** Whether a body was found within `maxDistance`. */
    hasHit: boolean;
    /** Distance between the closest points. */
    distance: number;
    /** Closest point on the query shape (query-shape local space in a zero-offset world). */
    inputHitPoint: Vec3;
    /** Closest point on the hit body (world space). */
    hitPoint: Vec3;
    /** Surface normal at the query-shape closest point. */
    inputHitNormal: Vec3;
    /** Surface normal at the hit-body closest point. */
    hitNormal: Vec3;
}

/** Result of a {@link shapeCast} query. */
export interface ShapeCastResult {
    /** Whether the swept shape hit a body. */
    hasHit: boolean;
    /** Fraction along the sweep (`startPosition`→`endPosition`) where contact first occurs. */
    fraction: number;
    /** Contact point on the swept shape (query-shape space). */
    inputHitPoint: Vec3;
    /** Contact point on the hit body (world space). */
    hitPoint: Vec3;
    /** Surface normal at the swept-shape contact. */
    inputHitNormal: Vec3;
    /** Surface normal at the hit-body contact. */
    hitNormal: Vec3;
}

/** Ignore-none body filter handle: a single zero body id. */
const IGNORE_NONE = [BigInt(0)];

/** Lazily create (and cache on the world) the single-hit Havok query collector. */
function getCollector(world: PhysicsWorld): any {
    if (!world._queryCollector) {
        world._queryCollector = world._hknp.HP_QueryCollector_Create(1)[1];
    }
    return world._queryCollector;
}

/** Convert a Havok hit tuple's position/normal slots into plain `Vec3`s. */
function hitVec(slot: number[]): Vec3 {
    return { x: slot[0]!, y: slot[1]!, z: slot[2]! };
}

/**
 * Find the closest point between a query shape and the nearest body in the world.
 *
 * The query shape is positioned at `position`/`rotation` and tested against the world's
 * broadphase. When a body is found within `maxDistance`, `inputHitPoint` is the closest
 * point on the query shape and `hitPoint` is the closest point on the hit body (world
 * space). Run at least one physics step first so the broadphase exists.
 * @param world - The physics world to query.
 * @param query - Query shape, transform, and search distance.
 * @returns The proximity result; `hasHit` is `false` when nothing is within range.
 */
export function shapeProximity(world: PhysicsWorld, query: ShapeProximityQuery): ShapeProximityResult {
    const hknp = world._hknp;
    const collector = getCollector(world);
    const { position: p, rotation: r } = query;
    const hkQuery = [query.shape._hkShape, [p.x, p.y, p.z], [r.x, r.y, r.z, r.w], query.maxDistance, query.shouldHitTriggers ?? false, IGNORE_NONE];
    hknp.HP_World_ShapeProximityWithCollector(world._hkWorld, collector, hkQuery);

    if (hknp.HP_QueryCollector_GetNumHits(collector)[1] > 0) {
        const [distance, hitInputData, hitShapeData] = hknp.HP_QueryCollector_GetShapeProximityResult(collector, 0)[1];
        return {
            hasHit: true,
            distance,
            inputHitPoint: hitVec(hitInputData[3]),
            hitPoint: hitVec(hitShapeData[3]),
            inputHitNormal: hitVec(hitInputData[4]),
            hitNormal: hitVec(hitShapeData[4]),
        };
    }
    return emptyResult() as ShapeProximityResult;
}

/**
 * Sweep a shape from `startPosition` to `endPosition` (orientation fixed) and return the
 * first body it hits.
 *
 * `hitPoint` is the world-space contact point on the hit body; `fraction` is where along
 * the sweep contact first occurs. Run at least one physics step first so the broadphase exists.
 * @param world - The physics world to query.
 * @param query - Swept shape, orientation, and start/end positions.
 * @returns The cast result; `hasHit` is `false` when the sweep clears every body.
 */
export function shapeCast(world: PhysicsWorld, query: ShapeCastQuery): ShapeCastResult {
    const hknp = world._hknp;
    const collector = getCollector(world);
    const { rotation: r, startPosition: s, endPosition: e } = query;
    const hkQuery = [query.shape._hkShape, [r.x, r.y, r.z, r.w], [s.x, s.y, s.z], [e.x, e.y, e.z], query.shouldHitTriggers ?? false, IGNORE_NONE];
    hknp.HP_World_ShapeCastWithCollector(world._hkWorld, collector, hkQuery);

    if (hknp.HP_QueryCollector_GetNumHits(collector)[1] > 0) {
        const [fraction, hitInputData, hitShapeData] = hknp.HP_QueryCollector_GetShapeCastResult(collector, 0)[1];
        return {
            hasHit: true,
            fraction,
            inputHitPoint: hitVec(hitInputData[3]),
            hitPoint: hitVec(hitShapeData[3]),
            inputHitNormal: hitVec(hitInputData[4]),
            hitNormal: hitVec(hitShapeData[4]),
        };
    }
    return emptyResult() as ShapeCastResult;
}

/** Zeroed no-hit result shared by both queries. */
function emptyResult(): ShapeProximityResult & ShapeCastResult {
    const zero = (): Vec3 => ({ x: 0, y: 0, z: 0 });
    return {
        hasHit: false,
        distance: 0,
        fraction: 0,
        inputHitPoint: zero(),
        hitPoint: zero(),
        inputHitNormal: zero(),
        hitNormal: zero(),
    };
}
