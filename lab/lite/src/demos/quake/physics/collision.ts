// Clean-room Quake player physics: collision against the BSP's pre-expanded
// clip hull (hull 1) plus walk/gravity/jump/step movement. Reimplemented from
// the publicly documented SV_RecursiveHullCheck / SV_FlyMove / SV_WalkMove
// algorithms; no GPL source copied.
//
// All math is in Quake space (X fwd, Y left, Z up). The demo maps the resulting
// origin into engine space for the camera.

import type { BspData, BspClipNodes, BspNodes, BspPlane } from "../bsp/parse-bsp.js";

const CONTENTS_SOLID = -2;
// Liquid leaf contents (Quake): water=-3, slime=-4, lava=-5. Note CONTENTS_SKY
// is -6, so a plain `<= -3` test would wrongly classify sky leaves as liquid.
const CONTENTS_EMPTY = -1;
const CONTENTS_WATER = -3;
const CONTENTS_LAVA = -5;
const DIST_EPSILON = 0.03125;

const GRAVITY = 800;
const MAXSPEED = 320;
const ACCELERATE = 10;
const AIR_ACCELERATE = 7;
const FRICTION = 4;
const STOPSPEED = 100;
const STEPSIZE = 18;
const JUMPSPEED = 270;
const VIEW_HEIGHT = 22;

// Swimming (SV_WaterMove): water is slower, idle drifts you down, jump swims up.
const WATER_ACCELERATE = 10;
const WATER_SPEED_SCALE = 0.7;
const WATER_SINK_SPEED = 60;

// Water jump (SV_CheckWaterJump): at the surface, facing a ledge, launch up and
// out so the player can climb onto platforms. During WATERJUMP_TIME seconds the
// horizontal velocity is locked so the scripted arc carries them over the lip.
const WATERJUMP_UP = 350;
const WATERJUMP_FWD = 50;
const WATERJUMP_TIME = 2;

export interface MoveInput {
    /** Desired horizontal move in Quake space (already rotated by view yaw). */
    forward: number;
    side: number;
    jump: boolean;
}

interface Trace {
    fraction: number;
    endpos: [number, number, number];
    planeNormal: [number, number, number] | null;
    startSolid: boolean;
    allSolid: boolean;
}

type V3 = [number, number, number];

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** True for water/slime/lava leaf contents (−3…−5), excluding sky (−6) and solid. */
const isLiquid = (c: number): boolean => c <= CONTENTS_WATER && c >= CONTENTS_LAVA;

export class QuakePhysics {
    private readonly clip: BspClipNodes;
    private readonly planes: BspPlane[];
    private readonly headNode: number;

    // Hull 0 (point hull) — the rendering BSP tree, used for exact line-of-sight.
    private readonly nodes: BspNodes;
    private readonly worldRoot0: number;

    readonly origin: V3;
    readonly velocity: V3 = [0, 0, 0];
    onGround = false;

    /** Liquid immersion: 0 none, 1 feet, 2 waist (swimming), 3 fully submerged. */
    waterLevel = 0;
    /** Leaf contents of the liquid the player is in (water/slime/lava) or empty. */
    waterType = CONTENTS_EMPTY;

    /** Moving brush models (doors/plats) to also collide against. */
    brushHulls: { headNode: number; offset: V3 }[] = [];
    /** The brush hull index the player is currently standing on, or -1. */
    groundBrush = -1;
    private _root = 0;
    /** Cooldown after a water-jump launch; also preserves launch velocity while still submerged. */
    private waterJumpTime = 0;

    constructor(bsp: BspData, spawn: V3) {
        this.clip = bsp.clipNodes;
        this.planes = bsp.planes;
        // hull 1 (player box) root of the world model.
        this.headNode = bsp.models[0]?.headNode[1] ?? 0;
        this.nodes = bsp.nodes;
        // hull 0 (point hull) root of the world model.
        this.worldRoot0 = bsp.models[0]?.headNode[0] ?? 0;
        this.origin = [spawn[0], spawn[1], spawn[2]];
    }

    get eye(): V3 {
        return [this.origin[0], this.origin[1], this.origin[2] + VIEW_HEIGHT];
    }

    /** Public point/box trace against the world + moving brush hulls. */
    castMove(start: V3, end: V3): { fraction: number; endpos: V3; normal: V3 | null } {
        const tr = this.trace(start, end);
        return { fraction: tr.fraction, endpos: [tr.endpos[0], tr.endpos[1], tr.endpos[2]], normal: tr.planeNormal };
    }

    /**
     * Exact point line-of-sight test (eye → target) against hull 0 plus any
     * closed mover (door/plat). Returns true when nothing solid lies between.
     *
     * Visibility must use the point hull, not the player clip hull: the expanded
     * clip hull pushes floors/walls ~24 units outward, so a monster's eye point
     * lands *inside* solid and the box trace reports a clear path — which made
     * monsters shoot through walls. The point hull has no such expansion.
     */
    visible(start: V3, end: V3): boolean {
        if (!this.point0Recurse(this.worldRoot0, start, end)) return false;
        // Movers are thin brush models (doors/plats); use their clip hull so a
        // closed door still blocks sight. Start is virtually never inside a mover.
        for (const bh of this.brushHulls) {
            const s: V3 = [start[0] - bh.offset[0], start[1] - bh.offset[1], start[2] - bh.offset[2]];
            const e: V3 = [end[0] - bh.offset[0], end[1] - bh.offset[1], end[2] - bh.offset[2]];
            if (this.traceHull(bh.headNode, s, e).fraction < 0.99) return false;
        }
        return true;
    }

    /** Recurse hull 0: true if the segment p1→p2 never enters a solid leaf. */
    private point0Recurse(num: number, p1: V3, p2: V3): boolean {
        if (num < 0) return this.nodes.leafContents[-num - 1]! !== CONTENTS_SOLID;
        const plane = this.planes[this.nodes.planeNum[num]!]!;
        const t1 = dot(plane.normal, p1) - plane.planeDist;
        const t2 = dot(plane.normal, p2) - plane.planeDist;
        if (t1 >= 0 && t2 >= 0) return this.point0Recurse(this.nodes.child0[num]!, p1, p2);
        if (t1 < 0 && t2 < 0) return this.point0Recurse(this.nodes.child1[num]!, p1, p2);
        const frac = t1 / (t1 - t2);
        const mid: V3 = [p1[0] + frac * (p2[0] - p1[0]), p1[1] + frac * (p2[1] - p1[1]), p1[2] + frac * (p2[2] - p1[2])];
        const side = t1 < 0 ? 1 : 0;
        const near = side === 0 ? this.nodes.child0[num]! : this.nodes.child1[num]!;
        const far = side === 0 ? this.nodes.child1[num]! : this.nodes.child0[num]!;
        if (!this.point0Recurse(near, p1, mid)) return false;
        return this.point0Recurse(far, mid, p2);
    }

    // ─── Hull queries ──────────────────────────────────────────────────────
    /** pointContents starting from an arbitrary clip node. */
    private hullContentsAt(num: number, p: V3): number {
        while (num >= 0) {
            const plane = this.planes[this.clip.planeNum[num]!]!;
            const d = dot(plane.normal, p) - plane.planeDist;
            num = d < 0 ? this.clip.child1[num]! : this.clip.child0[num]!;
        }
        return num;
    }

    private trace(start: V3, end: V3): Trace {
        // World hull.
        let best = this.traceHull(this.headNode, start, end);
        let bestBrush = -1;
        // Moving brush hulls (offset into their local space, then map back).
        for (let i = 0; i < this.brushHulls.length; i++) {
            const bh = this.brushHulls[i]!;
            const s: V3 = [start[0] - bh.offset[0], start[1] - bh.offset[1], start[2] - bh.offset[2]];
            const e: V3 = [end[0] - bh.offset[0], end[1] - bh.offset[1], end[2] - bh.offset[2]];
            const tr = this.traceHull(bh.headNode, s, e);
            if (tr.fraction < best.fraction) {
                best = {
                    fraction: tr.fraction,
                    endpos: [tr.endpos[0] + bh.offset[0], tr.endpos[1] + bh.offset[1], tr.endpos[2] + bh.offset[2]],
                    planeNormal: tr.planeNormal,
                    startSolid: tr.startSolid,
                    allSolid: tr.allSolid,
                };
                bestBrush = i;
            }
        }
        this._lastBrush = bestBrush;
        return best;
    }

    private _lastBrush = -1;

    private traceHull(root: number, start: V3, end: V3): Trace {
        const tr: Trace = { fraction: 1, endpos: [end[0], end[1], end[2]], planeNormal: null, startSolid: false, allSolid: true };
        this._root = root;
        this.recurse(root, 0, 1, start, end, tr);
        return tr;
    }

    private recurse(num: number, p1f: number, p2f: number, p1: V3, p2: V3, tr: Trace): boolean {
        if (num < 0) {
            if (num !== CONTENTS_SOLID) tr.allSolid = false;
            else tr.startSolid = true;
            return true; // empty
        }
        const plane = this.planes[this.clip.planeNum[num]!]!;
        const t1 = dot(plane.normal, p1) - plane.planeDist;
        const t2 = dot(plane.normal, p2) - plane.planeDist;
        const child0 = this.clip.child0[num]!;
        const child1 = this.clip.child1[num]!;
        if (t1 >= 0 && t2 >= 0) return this.recurse(child0, p1f, p2f, p1, p2, tr);
        if (t1 < 0 && t2 < 0) return this.recurse(child1, p1f, p2f, p1, p2, tr);

        let frac = t1 < 0 ? (t1 + DIST_EPSILON) / (t1 - t2) : (t1 - DIST_EPSILON) / (t1 - t2);
        frac = Math.max(0, Math.min(1, frac));
        let midf = p1f + (p2f - p1f) * frac;
        const mid: V3 = [p1[0] + frac * (p2[0] - p1[0]), p1[1] + frac * (p2[1] - p1[1]), p1[2] + frac * (p2[2] - p1[2])];
        const side = t1 < 0 ? 1 : 0;
        const nearChild = side === 0 ? child0 : child1;
        const farChild = side === 0 ? child1 : child0;

        if (!this.recurse(nearChild, p1f, midf, p1, mid, tr)) return false;

        if (this.hullContentsAt(farChild, mid) !== CONTENTS_SOLID) {
            return this.recurse(farChild, midf, p2f, mid, p2, tr);
        }
        if (tr.allSolid) return false; // never got out of solid

        // Impact: record the plane (flip if we hit the back side).
        tr.planeNormal = side === 0 ? [plane.normal[0], plane.normal[1], plane.normal[2]] : [-plane.normal[0], -plane.normal[1], -plane.normal[2]];

        // Back up until just outside solid.
        let f = frac;
        while (this.hullContentsAt(this._root, mid) === CONTENTS_SOLID) {
            f -= 0.1;
            if (f < 0) {
                tr.fraction = midf;
                tr.endpos = [mid[0], mid[1], mid[2]];
                return false;
            }
            midf = p1f + (p2f - p1f) * f;
            mid[0] = p1[0] + f * (p2[0] - p1[0]);
            mid[1] = p1[1] + f * (p2[1] - p1[1]);
            mid[2] = p1[2] + f * (p2[2] - p1[2]);
        }
        tr.fraction = midf;
        tr.endpos = [mid[0], mid[1], mid[2]];
        return false;
    }

    // ─── Movement ──────────────────────────────────────────────────────────
    /** Slide the origin along velocity for dt, clipping against up to 4 planes. */
    private flyMove(dt: number): void {
        let timeLeft = dt;
        const planes: V3[] = [];
        const primalVel: V3 = [this.velocity[0], this.velocity[1], this.velocity[2]];
        for (let bump = 0; bump < 4 && timeLeft > 0; bump++) {
            const v = this.velocity;
            if (v[0] === 0 && v[1] === 0 && v[2] === 0) break;
            const end: V3 = [this.origin[0] + v[0] * timeLeft, this.origin[1] + v[1] * timeLeft, this.origin[2] + v[2] * timeLeft];
            const tr = this.trace(this.origin, end);
            if (tr.fraction > 0) {
                this.origin[0] = tr.endpos[0];
                this.origin[1] = tr.endpos[1];
                this.origin[2] = tr.endpos[2];
                planes.length = 0;
            }
            if (tr.fraction === 1) break;
            timeLeft -= timeLeft * tr.fraction;
            if (!tr.planeNormal) break;
            planes.push(tr.planeNormal);

            // Clip velocity to all accumulated planes.
            let i = 0;
            for (; i < planes.length; i++) {
                this.clipVelocity(this.velocity, planes[i]!, 1.0);
                let ok = true;
                for (let j = 0; j < planes.length; j++) {
                    if (j !== i && dot(this.velocity, planes[j]!) < 0) {
                        ok = false;
                        break;
                    }
                }
                if (ok) break;
            }
            if (i === planes.length) {
                // Wedged into a crease: slide along the crease direction.
                if (planes.length >= 2) {
                    const dir = this.cross(planes[0]!, planes[1]!);
                    const d = dot(dir, this.velocity);
                    this.velocity[0] = dir[0] * d;
                    this.velocity[1] = dir[1] * d;
                    this.velocity[2] = dir[2] * d;
                } else {
                    this.velocity[0] = this.velocity[1] = this.velocity[2] = 0;
                    break;
                }
            }
            // Avoid bouncing straight back the way we came.
            if (dot(this.velocity, primalVel) <= 0) {
                this.velocity[0] = this.velocity[1] = this.velocity[2] = 0;
                break;
            }
        }
    }

    private clipVelocity(v: V3, normal: V3, overbounce: number): void {
        const backoff = dot(v, normal) * overbounce;
        v[0] -= normal[0] * backoff;
        v[1] -= normal[1] * backoff;
        v[2] -= normal[2] * backoff;
    }

    private cross(a: V3, b: V3): V3 {
        const c: V3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        const len = Math.hypot(c[0], c[1], c[2]) || 1;
        return [c[0] / len, c[1] / len, c[2] / len];
    }

    private applyFriction(dt: number): void {
        const v = this.velocity;
        const speed = Math.hypot(v[0], v[1], v[2]);
        if (speed < 1) {
            v[0] = 0;
            v[1] = 0;
            return;
        }
        const control = speed < STOPSPEED ? STOPSPEED : speed;
        let newSpeed = speed - dt * control * FRICTION;
        if (newSpeed < 0) newSpeed = 0;
        newSpeed /= speed;
        v[0] *= newSpeed;
        v[1] *= newSpeed;
        v[2] *= newSpeed;
    }

    private accelerate(wishDir: V3, wishSpeed: number, accel: number, dt: number): void {
        const currentSpeed = dot(this.velocity, wishDir);
        const addSpeed = wishSpeed - currentSpeed;
        if (addSpeed <= 0) return;
        let accelSpeed = accel * dt * wishSpeed;
        if (accelSpeed > addSpeed) accelSpeed = addSpeed;
        this.velocity[0] += accelSpeed * wishDir[0];
        this.velocity[1] += accelSpeed * wishDir[1];
        this.velocity[2] += accelSpeed * wishDir[2];
    }

    /** Leaf contents at a point via the hull-0 point tree (water/slime/lava/solid/empty). */
    private pointContents(p: V3): number {
        let num = this.worldRoot0;
        while (num >= 0) {
            const plane = this.planes[this.nodes.planeNum[num]!]!;
            const d = dot(plane.normal, p) - plane.planeDist;
            num = d < 0 ? this.nodes.child1[num]! : this.nodes.child0[num]!;
        }
        return this.nodes.leafContents[-num - 1]!;
    }

    /** Sample feet/waist/eye to classify how deep the player is in a liquid. */
    private checkWater(): void {
        const o = this.origin;
        this.waterLevel = 0;
        this.waterType = CONTENTS_EMPTY;
        // Just above the feet (player box bottom ≈ origin − 24).
        const feet = this.pointContents([o[0], o[1], o[2] - 23]);
        if (!isLiquid(feet)) return; // empty/solid/sky → not in a liquid
        this.waterType = feet;
        this.waterLevel = 1;
        if (isLiquid(this.pointContents([o[0], o[1], o[2]]))) {
            this.waterLevel = 2;
            if (isLiquid(this.pointContents([o[0], o[1], o[2] + VIEW_HEIGHT]))) this.waterLevel = 3;
        }
    }

    /**
     * Swim (SV_WaterMove): full 3-D movement with no gravity. Look direction
     * (yaw+pitch) drives the forward axis so looking down + forward dives; jump
     * swims straight up; releasing all keys drifts you gently downward.
     */
    private waterMove(dt: number, input: MoveInput, yaw: number, pitch: number): void {
        const cp = Math.cos(pitch);
        const fwd: V3 = [Math.cos(yaw) * cp, Math.sin(yaw) * cp, Math.sin(pitch)];
        const right: V3 = [Math.sin(yaw), -Math.cos(yaw), 0];
        const wish: V3 = [fwd[0] * input.forward + right[0] * input.side, fwd[1] * input.forward + right[1] * input.side, fwd[2] * input.forward];
        if (input.jump) wish[2] += MAXSPEED;
        else if (input.forward === 0 && input.side === 0) wish[2] -= WATER_SINK_SPEED;

        let wishSpeed = Math.hypot(wish[0], wish[1], wish[2]);
        const wishDir: V3 = wishSpeed > 0 ? [wish[0] / wishSpeed, wish[1] / wishSpeed, wish[2] / wishSpeed] : [0, 0, 0];
        if (wishSpeed > MAXSPEED) wishSpeed = MAXSPEED;
        wishSpeed *= WATER_SPEED_SCALE;

        // 3-D water friction.
        const v = this.velocity;
        const speed = Math.hypot(v[0], v[1], v[2]);
        if (speed > 0) {
            const control = speed < STOPSPEED ? STOPSPEED : speed;
            let newSpeed = speed - dt * control * FRICTION;
            if (newSpeed < 0) newSpeed = 0;
            const scale = newSpeed / speed;
            v[0] *= scale;
            v[1] *= scale;
            v[2] *= scale;
        }

        this.accelerate(wishDir, wishSpeed, WATER_ACCELERATE, dt);
        this.flyMove(dt);
    }

    /**
     * Quake's SV_CheckWaterJump: when treading at the surface and looking at a
     * ledge, detect a solid wall just in front with open space above it and fling
     * the player up and out so they can mount the platform. Returns true if the
     * jump was launched.
     */
    private checkWaterJump(yaw: number): boolean {
        // Only hop out when not plunging downward.
        if (this.velocity[2] < -180) return false;
        const o = this.origin;
        const flat: V3 = [Math.cos(yaw), Math.sin(yaw), 0];
        // Solid wall ~24 units ahead at head height?
        const spot: V3 = [o[0] + 24 * flat[0], o[1] + 24 * flat[1], o[2] + 8];
        if (this.pointContents(spot) !== CONTENTS_SOLID) return false;
        // Open air just above that wall (the ledge surface we want to land on)?
        spot[2] += 24;
        if (this.pointContents(spot) !== CONTENTS_EMPTY) return false;
        // Launch up and out.
        this.velocity[0] = flat[0] * WATERJUMP_FWD;
        this.velocity[1] = flat[1] * WATERJUMP_FWD;
        this.velocity[2] = WATERJUMP_UP;
        this.waterJumpTime = WATERJUMP_TIME;
        return true;
    }

    private checkGround(): void {
        if (this.velocity[2] > 180) {
            this.onGround = false;
            return;
        }
        const end: V3 = [this.origin[0], this.origin[1], this.origin[2] - 2];
        const tr = this.trace(this.origin, end);
        this.onGround = tr.fraction < 1 && tr.planeNormal !== null && tr.planeNormal[2] > 0.7;
        this.groundBrush = this.onGround ? this._lastBrush : -1;
        if (this.onGround) {
            this.origin[0] = tr.endpos[0];
            this.origin[1] = tr.endpos[1];
            this.origin[2] = tr.endpos[2];
        }
    }

    private walkMove(dt: number): void {
        const startOrigin: V3 = [this.origin[0], this.origin[1], this.origin[2]];
        const startVel: V3 = [this.velocity[0], this.velocity[1], this.velocity[2]];

        // Attempt 1: plain ground slide.
        this.flyMove(dt);
        const downOrigin: V3 = [this.origin[0], this.origin[1], this.origin[2]];
        const downVel: V3 = [this.velocity[0], this.velocity[1], this.velocity[2]];

        // Attempt 2: step up, slide, step down (stairs).
        this.origin[0] = startOrigin[0];
        this.origin[1] = startOrigin[1];
        this.origin[2] = startOrigin[2];
        this.velocity[0] = startVel[0];
        this.velocity[1] = startVel[1];
        this.velocity[2] = startVel[2];

        const up = this.trace(this.origin, [this.origin[0], this.origin[1], this.origin[2] + STEPSIZE]);
        this.origin[0] = up.endpos[0];
        this.origin[1] = up.endpos[1];
        this.origin[2] = up.endpos[2];
        this.flyMove(dt);
        // Step back down.
        const down = this.trace(this.origin, [this.origin[0], this.origin[1], this.origin[2] - STEPSIZE]);
        const landed = down.planeNormal !== null && down.planeNormal[2] >= 0.7;
        if (landed) {
            this.origin[0] = down.endpos[0];
            this.origin[1] = down.endpos[1];
            this.origin[2] = down.endpos[2];
        }
        const stepOrigin: V3 = [this.origin[0], this.origin[1], this.origin[2]];

        const downDist = (downOrigin[0] - startOrigin[0]) ** 2 + (downOrigin[1] - startOrigin[1]) ** 2;
        const stepDist = (stepOrigin[0] - startOrigin[0]) ** 2 + (stepOrigin[1] - startOrigin[1]) ** 2;
        if (!landed || downDist > stepDist) {
            this.origin[0] = downOrigin[0];
            this.origin[1] = downOrigin[1];
            this.origin[2] = downOrigin[2];
            this.velocity[0] = downVel[0];
            this.velocity[1] = downVel[1];
            this.velocity[2] = downVel[2];
        } else {
            this.velocity[2] = downVel[2];
        }
    }

    /** Advance the simulation by dt seconds given the desired move and view angles. */
    update(dt: number, input: MoveInput, yaw: number, pitch: number): void {
        this.checkWater();
        if (this.waterJumpTime > 0) this.waterJumpTime -= dt;

        // Waist-deep or more → swim (3-D, no gravity).
        if (this.waterLevel >= 2) {
            this.onGround = false;
            this.groundBrush = -1;
            // Mid water-jump: keep the scripted velocity so we rise out cleanly.
            if (this.waterJumpTime > 0) {
                this.flyMove(dt);
                return;
            }
            // At the surface, looking at a ledge, press jump/forward to vault out.
            if ((input.jump || input.forward > 0) && this.checkWaterJump(yaw)) {
                this.flyMove(dt);
                return;
            }
            this.waterMove(dt, input, yaw, pitch);
            return;
        }

        // Build wish direction in the horizontal plane from view yaw.
        const fwd: V3 = [Math.cos(yaw), Math.sin(yaw), 0];
        const right: V3 = [Math.sin(yaw), -Math.cos(yaw), 0];
        const wishX = fwd[0] * input.forward + right[0] * input.side;
        const wishY = fwd[1] * input.forward + right[1] * input.side;
        let wishSpeed = Math.hypot(wishX, wishY);
        const wishDir: V3 = wishSpeed > 0 ? [wishX / wishSpeed, wishY / wishSpeed, 0] : [0, 0, 0];
        if (wishSpeed > MAXSPEED) wishSpeed = MAXSPEED;

        this.checkGround();

        if (this.onGround) {
            this.waterJumpTime = 0;
            this.applyFriction(dt);
            this.velocity[2] = 0;
            this.accelerate(wishDir, wishSpeed, ACCELERATE, dt);
            if (input.jump) {
                this.velocity[2] = JUMPSPEED;
                this.onGround = false;
                this.flyMove(dt);
            } else {
                this.walkMove(dt);
            }
        } else {
            this.velocity[2] -= GRAVITY * dt;
            this.accelerate(wishDir, wishSpeed, AIR_ACCELERATE, dt);
            this.flyMove(dt);
        }
    }
}
