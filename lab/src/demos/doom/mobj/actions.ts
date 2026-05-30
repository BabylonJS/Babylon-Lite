// Clean-room DOOM actor actions (AI + attacks). Dispatched by name from the
// state machine. Implemented from public Doom behavior docs; no GPL source copied.

import type { DoomWorld } from "./world.js";
import type { Mobj } from "./mobj.js";
import { Dir, DIR_ANGLE } from "./mobj.js";
import { MF } from "./info.js";
import type { ActionName } from "./states.js";
import { STATE_SETS } from "./states.js";
import { setMobjState, tryWalk } from "./think.js";
import { checkSight, lineAttack, spawnMissile, damageMobj, radiusAttack, MELEE_RANGE, MISSILE_RANGE } from "../combat/attack.js";

const OPPOSITE: Dir[] = [Dir.WEST, Dir.SOUTHWEST, Dir.SOUTH, Dir.SOUTHEAST, Dir.EAST, Dir.NORTHEAST, Dir.NORTH, Dir.NORTHWEST, Dir.NONE];

export function runAction(world: DoomWorld, m: Mobj, action: ActionName): void {
    switch (action) {
        case "Look": aLook(world, m); break;
        case "Chase": aChase(world, m); break;
        case "FaceTarget": aFaceTarget(m); break;
        case "PosAttack": aPosAttack(world, m); break;
        case "SPosAttack": aSPosAttack(world, m); break;
        case "TroopAttack": aTroopAttack(world, m); break;
        case "SargAttack": aSargAttack(world, m); break;
        case "Pain": break;
        case "Scream": if (m.info.deathSound) world.events.sound?.(m.info.deathSound); break;
        case "XScream": world.events.sound?.("SLOP"); break;
        case "Fall": m.flags &= ~MF.SOLID; break;
        case "Explode": aExplode(world, m); break;
        case "RemoveSelf": m.removed = true; break;
    }
}

function distTo(m: Mobj, t: Mobj): number {
    return Math.hypot(t.x - m.x, t.y - m.y);
}

function wake(world: DoomWorld, m: Mobj): void {
    const sets = STATE_SETS.get(m.info.id);
    if (sets?.see !== undefined) setMobjState(world, m, sets.see);
    if (m.info.seeSound) world.events.sound?.(m.info.seeSound);
}

function aLook(world: DoomWorld, m: Mobj): void {
    const p = world.player;
    if (p.health <= 0) return;
    if (!checkSight(world, m, p)) return;
    m.target = p;
    m.reactionTime = 8;
    wake(world, m);
}

function aFaceTarget(m: Mobj): void {
    if (!m.target) return;
    m.angle = Math.atan2(m.target.y - m.y, m.target.x - m.x);
}

function aChase(world: DoomWorld, m: Mobj): void {
    if (m.reactionTime > 0) m.reactionTime--;
    if (m.threshold > 0) m.threshold--;

    const t = m.target;
    const sets = STATE_SETS.get(m.info.id);
    if (!t || t.removed || t.health <= 0) {
        // Lost target — return to looking.
        m.target = null;
        if (sets?.spawn !== undefined) setMobjState(world, m, sets.spawn);
        return;
    }

    // Melee attack.
    if (sets?.melee !== undefined && distTo(m, t) < MELEE_RANGE + t.radius) {
        if (checkSight(world, m, t)) {
            aFaceTarget(m);
            setMobjState(world, m, sets.melee);
            return;
        }
    }

    // Missile attack. The gate only opens when moveCount has counted down to 0
    // (see the pre-decrement movement step below, mirroring Doom's A_Chase), so
    // moveCount must NOT be reset here before this check or it would never fire.
    if (sets?.missile !== undefined && m.moveCount === 0 && checkMissileRange(world, m, t, sets.melee !== undefined)) {
        aFaceTarget(m);
        setMobjState(world, m, sets.missile);
        // Brief cooldown so it can't attack twice in a row (Doom's JUSTATTACKED).
        m.moveCount = 8 + Math.floor(Math.random() * 8);
        return;
    }

    // Movement: keep walking in moveDir; pick a new one when needed. The
    // pre-decrement compare (< 0, matching Doom) lets moveCount rest at 0 for one
    // full tic so the missile gate above can see it before newChaseDir resets it.
    if (--m.moveCount < 0 || m.moveDir === Dir.NONE || !tryWalk(world, m, m.moveDir)) {
        newChaseDir(world, m, t);
    }
    if (m.moveDir !== Dir.NONE) m.angle = DIR_ANGLE[m.moveDir]!;
}

/** Chooses a movement direction toward the target, with a simple slide fallback. */
function newChaseDir(world: DoomWorld, m: Mobj, t: Mobj): void {
    const dx = t.x - m.x;
    const dy = t.y - m.y;
    const dirH = dx > 16 ? Dir.EAST : dx < -16 ? Dir.WEST : Dir.NONE;
    const dirV = dy > 16 ? Dir.NORTH : dy < -16 ? Dir.SOUTH : Dir.NONE;

    const tryOrder: Dir[] = [];
    // Diagonal toward target first.
    if (dirH !== Dir.NONE && dirV !== Dir.NONE) {
        tryOrder.push(diagonal(dirH, dirV));
    }
    // Prefer the larger axis.
    if (Math.abs(dx) > Math.abs(dy)) {
        if (dirH !== Dir.NONE) tryOrder.push(dirH);
        if (dirV !== Dir.NONE) tryOrder.push(dirV);
    } else {
        if (dirV !== Dir.NONE) tryOrder.push(dirV);
        if (dirH !== Dir.NONE) tryOrder.push(dirH);
    }
    // Then the rest of the compass (so monsters route around obstacles).
    for (let d = 0; d < 8; d++) tryOrder.push(d as Dir);
    tryOrder.push(OPPOSITE[m.moveDir] ?? Dir.NONE);

    for (const d of tryOrder) {
        if (d === Dir.NONE) continue;
        if (tryWalk(world, m, d)) {
            m.moveDir = d;
            m.moveCount = Math.floor(Math.random() * 16);
            return;
        }
    }
    m.moveDir = Dir.NONE;
}

function diagonal(h: Dir, v: Dir): Dir {
    if (v === Dir.NORTH) return h === Dir.EAST ? Dir.NORTHEAST : Dir.NORTHWEST;
    return h === Dir.EAST ? Dir.SOUTHEAST : Dir.SOUTHWEST;
}

// ── Attacks ─────────────────────────────────────────────────────────────

/**
 * Doom's P_CheckMissileRange: a sight-gated, distance-weighted chance to fire.
 * The closer the target, the higher the chance — at point-blank it fires almost
 * every opportunity; far away it rarely does. Monsters with no melee attack
 * (e.g. the zombieman) bias further toward shooting.
 */
function checkMissileRange(world: DoomWorld, m: Mobj, t: Mobj, hasMelee: boolean): boolean {
    if (!checkSight(world, m, t)) return false;
    if (m.reactionTime > 0) return false;
    let dist = distTo(m, t) - 64;
    if (!hasMelee) dist -= 128;
    if (dist > 200) dist = 200;
    return Math.random() * 256 >= dist;
}

function aPosAttack(world: DoomWorld, m: Mobj): void {
    if (!m.target) return;
    aFaceTarget(m);
    if (m.info.attackSound) world.events.sound?.(m.info.attackSound);
    const spread = (Math.random() - Math.random()) * 0.15;
    const dmg = (1 + Math.floor(Math.random() * 3)) * 3;
    lineAttack(world, m, m.angle + spread, MISSILE_RANGE, dmg);
}

function aSPosAttack(world: DoomWorld, m: Mobj): void {
    if (!m.target) return;
    aFaceTarget(m);
    if (m.info.attackSound) world.events.sound?.(m.info.attackSound);
    for (let i = 0; i < 3; i++) {
        const spread = (Math.random() - Math.random()) * 0.3;
        const dmg = (1 + Math.floor(Math.random() * 3)) * 3;
        lineAttack(world, m, m.angle + spread, MISSILE_RANGE, dmg);
    }
}

function aTroopAttack(world: DoomWorld, m: Mobj): void {
    const t = m.target;
    if (!t) return;
    aFaceTarget(m);
    if (distTo(m, t) < MELEE_RANGE + t.radius) {
        if (m.info.attackSound) world.events.sound?.(m.info.attackSound);
        damageMobj(world, t, m, (1 + Math.floor(Math.random() * 8)) * 3);
        return;
    }
    spawnMissile(world, m, t, "IMPBALL");
}

function aSargAttack(world: DoomWorld, m: Mobj): void {
    const t = m.target;
    if (!t) return;
    aFaceTarget(m);
    if (distTo(m, t) < MELEE_RANGE + t.radius) {
        if (m.info.attackSound) world.events.sound?.(m.info.attackSound);
        damageMobj(world, t, m, (1 + Math.floor(Math.random() * 10)) * 4);
    }
}

function aExplode(world: DoomWorld, m: Mobj): void {
    world.events.sound?.("BAREXP");
    radiusAttack(world, m, m, 128);
}
