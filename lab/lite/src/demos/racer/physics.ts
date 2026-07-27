/**
 * Racer physics — the kit's dynamic-sphere model. A hidden Havok ball (a DYNAMIC
 * rigid body) is the car's physical stand-in: the vehicle controller drives the
 * ball's velocity toward its heading and reads the ball's settled planar position
 * back each frame, so the car carries momentum and bounces off the barriers
 * naturally instead of being kinematically clamped.
 *
 * Static box colliders trace the road edges (from `track.walls`) and a large flat
 * floor gives the ball something to rest on. The ball is a touch wider than the
 * car so the visible body stays behind the barriers, even angled through a corner.
 */

import type { EngineContext, PhysicsWorld, SceneContext } from "babylon-lite";
import {
    addToScene,
    applyPhysicsBodyForce,
    createBox,
    createPhysicsAggregate,
    createSphere,
    getPhysicsBodyLinearVelocity,
    onPhysicsCollision,
    physicsRaycast,
    PhysicsShapeType,
    setPhysicsBodyCollisionEventsEnabled,
    setPhysicsShapeFilterMembershipMask,
} from "babylon-lite";

import type { BumpCollider, Wall } from "./track.js";

const WALL_HEIGHT = 4; // barrier collider height — well above the ball's top (rest 1.2 + radius 1.2 = 2.4) so a driven ball can't roll over it
const BALL_RADIUS = 1.2; // car-ball radius (a bit wider than the car half-width → body stays behind walls)
const BALL_MASS = 5;
const BALL_FRICTION = 0.2;
const BALL_RESTITUTION = 0.2; // a gentle bounce off barriers
const BALL_REST_Y = BALL_RADIUS; // rests on the floor collider, whose top is at y = 0
const IMPACT_MIN_IMPULSE = 5; // Havok contact impulse below which a touch is too gentle to "thud"
const IMPACT_MAX_NORMAL_Y = 0.5; // ignore near-vertical contacts (the floor); barriers are horizontal
// Collision-filter groups so the ground-probe ray hits ONLY the road surface (floor + bumps), not the ball or walls.
const GROUP_BALL = 1 << 0;
const GROUP_GROUND = 1 << 1; // flat floor + bump domes
const GROUP_WALL = 1 << 2;
const RAY_TOP = 6; // ground-probe ray span: from well above the tallest bump down through the floor
const RAY_BOTTOM = -3;

/** The dynamic sphere that physically stands in for the car. */
export interface CarBall {
    /** Push the ball's horizontal velocity toward `(vx, vz)` m/s with a central force the barrier solver can still override (grip = response rate). */
    drive(vx: number, vz: number, grip: number): void;
    /** Ball centre in world space — its X/Z is the car's planar position, its Y rises over bumps. */
    position(): { x: number; y: number; z: number };
    /** Ball centre Y when resting on flat ground — subtract from `position().y` for the ride height. */
    readonly restY: number;
    /** Road-surface height (world Y) directly under `(x, z)`, via a downward ray that ignores the ball and walls. */
    heightAt(x: number, z: number): number;
    /** Set to be notified when the ball strikes a barrier; argument is the impact strength (≈ m/s). */
    onImpact: ((strength: number) => void) | null;
}

/** Build the static barrier colliders (invisible boxes) from the track's wall segments. */
export function buildBarriers(engine: EngineContext, scene: SceneContext, world: PhysicsWorld, walls: readonly Wall[]): void {
    for (const w of walls) {
        const box = createBox(engine, 1);
        box.position.set(w.cx, WALL_HEIGHT / 2, w.cz);
        box.scaling.set(w.sx, WALL_HEIGHT, w.sz);
        if (w.rot) {
            const h = w.rot / 2;
            box.rotationQuaternion.set(0, Math.sin(h), 0, Math.cos(h));
        }
        box.visible = false;
        addToScene(scene, box);
        const agg = createPhysicsAggregate(world, box, PhysicsShapeType.BOX, { mass: 0, extents: { x: w.sx, y: WALL_HEIGHT, z: w.sz } });
        setPhysicsShapeFilterMembershipMask(world, agg.shape, GROUP_WALL);
    }
}

/** A large invisible floor (top at y = 0) so the dynamic car-ball has something to rest and roll on. */
export function buildGroundCollider(engine: EngineContext, scene: SceneContext, world: PhysicsWorld): void {
    const floor = createBox(engine, 1);
    floor.position.set(0, -0.5, 0); // centre 0.5 below → top surface at y = 0
    floor.scaling.set(400, 1, 400);
    floor.visible = false;
    addToScene(scene, floor);
    const agg = createPhysicsAggregate(world, floor, PhysicsShapeType.BOX, { mass: 0, extents: { x: 400, y: 1, z: 400 } });
    setPhysicsShapeFilterMembershipMask(world, agg.shape, GROUP_GROUND);
}

/**
 * Build the static sphere colliders for the speed bumps. Each is a buried sphere whose cap pokes up ≈ the
 * visible dome, so the ball physically rides up and over it (a ball rolls over a sphere far more smoothly
 * than over a triangle-mesh collider). Tagged GROUP_GROUND so the car's ground-probe ray sees them.
 */
export function buildBumpColliders(engine: EngineContext, scene: SceneContext, world: PhysicsWorld, bumps: readonly BumpCollider[]): void {
    for (const b of bumps) {
        const sphere = createSphere(engine, { diameter: b.radius * 2, segments: 8 });
        sphere.position.set(b.x, b.y, b.z);
        sphere.visible = false;
        addToScene(scene, sphere);
        const agg = createPhysicsAggregate(world, sphere, PhysicsShapeType.SPHERE, { mass: 0, radius: b.radius });
        setPhysicsShapeFilterMembershipMask(world, agg.shape, GROUP_GROUND);
    }
}

/**
 * Create the car's dynamic collision ball. The vehicle controller drives its
 * velocity toward the heading each frame (`drive`) and reads the settled centre
 * (`position`) back, so the ball owns the planar motion and barrier collisions.
 */
export function createCarBall(engine: EngineContext, scene: SceneContext, world: PhysicsWorld, startX: number, startZ: number): CarBall {
    const ball = createSphere(engine, { diameter: BALL_RADIUS * 2, segments: 8 });
    ball.position.set(startX, BALL_REST_Y, startZ);
    ball.visible = false;
    addToScene(scene, ball);
    const { body, shape } = createPhysicsAggregate(world, ball, PhysicsShapeType.SPHERE, {
        mass: BALL_MASS,
        radius: BALL_RADIUS,
        friction: BALL_FRICTION,
        restitution: BALL_RESTITUTION,
    });
    setPhysicsShapeFilterMembershipMask(world, shape, GROUP_BALL); // so the ground-probe ray (collideWith GROUND) ignores it

    const carBall: CarBall = {
        onImpact: null,
        restY: BALL_REST_Y,
        drive(vx, vz, grip) {
            const v = getPhysicsBodyLinearVelocity(world, body);
            // Steer toward the target horizontal velocity with a CENTRAL FORCE (not setLinearVelocity):
            // the contact solver keeps final say at the barriers, so the ball presses against a wall
            // instead of a directly-set velocity overriding the solver and burrowing straight through.
            const fx = (vx - v.x) * grip * BALL_MASS;
            const fz = (vz - v.z) * grip * BALL_MASS;
            applyPhysicsBodyForce(world, body, { x: fx, y: 0, z: fz }, { x: ball.position.x, y: ball.position.y, z: ball.position.z });
        },
        position: () => ({ x: ball.position.x, y: ball.position.y, z: ball.position.z }),
        heightAt: (x, z) => {
            const hit = physicsRaycast(world, { x, y: RAY_TOP, z }, { x, y: RAY_BOTTOM, z }, { collideWith: GROUP_GROUND });
            return hit.hasHit ? hit.hitPoint.y : 0;
        },
    };

    // Real barrier impacts: enable Havok contact events on the ball and forward the firm,
    // roughly-horizontal ones (a wall thud) — skipping the floor and gentle grazes.
    setPhysicsBodyCollisionEventsEnabled(world, body, true);
    onPhysicsCollision(world, (info) => {
        if (info.type !== "STARTED" || Math.abs(info.normal.y) > IMPACT_MAX_NORMAL_Y || info.impulse < IMPACT_MIN_IMPULSE) {
            return;
        }
        carBall.onImpact?.(info.impulse / BALL_MASS);
    });
    return carBall;
}
