// Clean-room DOOM mobj thinker: per-tic state advancement, movement and gravity.
// Implemented from public Doom behavior docs; no GPL source is copied.

import type { DoomWorld } from "./world.js";
import type { Mobj } from "./mobj.js";
import { Dir, DIR_ANGLE } from "./mobj.js";
import { MF } from "./info.js";
import { STATES } from "./states.js";
import { runAction } from "./actions.js";
import { tryMove } from "../physics/collision.js";
import { tryMissileMove } from "../combat/attack.js";
import { sectorIndexAt } from "../wad/bsp-query.js";

const GRAVITY = 1;

/** Sets a mobj to a state, running its action; follows zero-tic chains. */
export function setMobjState(world: DoomWorld, m: Mobj, stateId: number): boolean {
    let id = stateId;
    let safety = 0;
    do {
        if (id < 0) {
            m.removed = true;
            return false;
        }
        const st = STATES[id]!;
        m.stateId = id;
        m.tics = st.tics;
        m.sprite = st.sprite;
        m.frame = st.frame;
        m.fullbright = st.fullbright;
        if (st.action) runAction(world, m, st.action);
        if (m.removed) return false;
        id = st.next;
    } while (m.tics === 0 && ++safety < 1000);
    return true;
}

/** Advances a single mobj by one tic. */
export function tickMobj(world: DoomWorld, m: Mobj): void {
    // Movement.
    if (m.flags & MF.MISSILE) {
        tryMissileMove(world, m);
        if (m.removed) return;
    } else if (m.momx !== 0 || m.momy !== 0) {
        applyMomentum(world, m);
    }
    applyGravity(world, m);

    // State countdown.
    if (m.tics > 0) {
        m.tics--;
        if (m.tics === 0) setMobjState(world, m, STATES[m.stateId]!.next);
    }
}

function applyMomentum(world: DoomWorld, m: Mobj): void {
    const floor = world.floorAt(m.x, m.y);
    const next = tryMove(world.collLines, m.x, m.y, m.momx, m.momy, floor, world.sectors, {
        radius: m.radius,
        height: m.height,
        maxStep: 24,
        isMonster: (m.flags & MF.COUNTKILL) !== 0,
    });
    m.x = next.x;
    m.y = next.y;
    // Friction.
    m.momx *= 0.9;
    m.momy *= 0.9;
    if (Math.abs(m.momx) < 0.1) m.momx = 0;
    if (Math.abs(m.momy) < 0.1) m.momy = 0;
    m.sectorIndex = sectorIndexAt(world.map, m.x, m.y);
}

function applyGravity(world: DoomWorld, m: Mobj): void {
    if (m.flags & MF.NOGRAVITY) return;
    const floor = world.floorAt(m.x, m.y);
    if (m.z > floor) {
        m.momz -= GRAVITY;
        m.z += m.momz;
        if (m.z < floor) {
            m.z = floor;
            m.momz = 0;
        }
    } else {
        m.z = floor;
        m.momz = 0;
    }
}

/** Attempts to step a monster `speed` units in direction `dir`. Returns success. */
export function tryWalk(world: DoomWorld, m: Mobj, dir: Dir): boolean {
    if (dir === Dir.NONE) return false;
    const speed = m.info.speed;
    const dx = Math.cos(DIR_ANGLE[dir]!) * speed;
    const dy = Math.sin(DIR_ANGLE[dir]!) * speed;
    const floor = world.floorAt(m.x + dx, m.y + dy);
    // Reject big step-ups / openings via collision resolution: if blocked the
    // resolved position barely advances.
    const next = tryMove(world.collLines, m.x, m.y, dx, dy, world.floorAt(m.x, m.y), world.sectors, {
        radius: m.radius,
        height: m.height,
        maxStep: 24,
        isMonster: true,
    });
    const advanced = Math.hypot(next.x - m.x, next.y - m.y);
    if (advanced < speed * 0.5) return false;
    // Mobj-vs-mobj blocking, plus the player (who is not in the mobjs list) so an
    // approaching monster stops at melee range instead of shoving the player.
    const blocksThing = (o: Mobj): boolean => {
        if ((o.flags & MF.SOLID) === 0) return false;
        const ddx = next.x - o.x;
        const ddy = next.y - o.y;
        const rr = m.radius + o.radius;
        return ddx * ddx + ddy * ddy < rr * rr;
    };
    if (m !== world.player && world.player.health > 0 && blocksThing(world.player)) return false;
    for (const o of world.mobjs) {
        if (o === m || o.removed) continue;
        if (blocksThing(o)) return false;
    }
    m.x = next.x;
    m.y = next.y;
    m.z = floor;
    m.sectorIndex = sectorIndexAt(world.map, m.x, m.y);
    return true;
}
