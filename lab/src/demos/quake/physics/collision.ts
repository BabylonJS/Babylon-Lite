// Clean-room Quake player physics: collision against the BSP's pre-expanded
// clip hull (hull 1) plus walk/gravity/jump/step movement. Reimplemented from
// the publicly documented SV_RecursiveHullCheck / SV_FlyMove / SV_WalkMove
// algorithms; no GPL source copied.
//
// All math is in Quake space (X fwd, Y left, Z up). The demo maps the resulting
// origin into engine space for the camera.

import type { BspData, BspClipNodes, BspPlane } from "../bsp/parse-bsp.js";

const CONTENTS_SOLID = -2;
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

export class QuakePhysics {
    private readonly clip: BspClipNodes;
    private readonly planes: BspPlane[];
    private readonly headNode: number;

    readonly origin: V3;
    readonly velocity: V3 = [0, 0, 0];
    onGround = false;

    /** Moving brush models (doors/plats) to also collide against. */
    brushHulls: { headNode: number; offset: V3 }[] = [];
    /** The brush hull index the player is currently standing on, or -1. */
    groundBrush = -1;
    private _root = 0;

    constructor(bsp: BspData, spawn: V3) {
        this.clip = bsp.clipNodes;
        this.planes = bsp.planes;
        // hull 1 (player box) root of the world model.
        this.headNode = bsp.models[0]?.headNode[1] ?? 0;
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

    // ─── Hull queries ──────────────────────────────────────────────────────
    /** pointContents starting from an arbitrary clip node. */
    private hullContentsAt(num: number, p: V3): number {
        while (num >= 0) {
            const plane = this.planes[this.clip.planeNum[num]];
            const d = dot(plane.normal, p) - plane.dist;
            num = d < 0 ? this.clip.child1[num] : this.clip.child0[num];
        }
        return num;
    }

    private trace(start: V3, end: V3): Trace {
        // World hull.
        let best = this.traceHull(this.headNode, start, end);
        let bestBrush = -1;
        // Moving brush hulls (offset into their local space, then map back).
        for (let i = 0; i < this.brushHulls.length; i++) {
            const bh = this.brushHulls[i];
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
        const plane = this.planes[this.clip.planeNum[num]];
        const t1 = dot(plane.normal, p1) - plane.dist;
        const t2 = dot(plane.normal, p2) - plane.dist;
        const child0 = this.clip.child0[num];
        const child1 = this.clip.child1[num];
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
                this.clipVelocity(this.velocity, planes[i], 1.0);
                let ok = true;
                for (let j = 0; j < planes.length; j++) {
                    if (j !== i && dot(this.velocity, planes[j]) < 0) {
                        ok = false;
                        break;
                    }
                }
                if (ok) break;
            }
            if (i === planes.length) {
                // Wedged into a crease: slide along the crease direction.
                if (planes.length >= 2) {
                    const dir = this.cross(planes[0], planes[1]);
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

    /** Advance the simulation by dt seconds given the desired move and view yaw. */
    update(dt: number, input: MoveInput, yaw: number): void {
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
