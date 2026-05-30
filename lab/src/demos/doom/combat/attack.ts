// Clean-room DOOM combat: line-of-sight, hitscan attacks, projectile spawning
// and damage application. Implemented from public descriptions of Doom behavior;
// no GPL source is copied.

import type { DoomWorld } from "../mobj/world.js";
import type { Mobj } from "../mobj/mobj.js";
import { MF } from "../mobj/info.js";
import { STATE_SETS } from "../mobj/states.js";
import { setMobjState } from "../mobj/think.js";

const MELEE_RANGE = 64;
export const MISSILE_RANGE = 32 * 64;

/** Distance from ray origin to first blocking wall, or `maxDist`. */
function rayWallDistance(world: DoomWorld, ox: number, oy: number, dx: number, dy: number, maxDist: number): number {
    let best = maxDist;
    for (const line of world.collLines) {
        const ex = line.x2 - line.x1;
        const ey = line.y2 - line.y1;
        const denom = dx * ey - dy * ex;
        if (Math.abs(denom) < 1e-9) continue;
        const tx = line.x1 - ox;
        const ty = line.y1 - oy;
        const t = (tx * ey - ty * ex) / denom; // along ray
        const u = (tx * dy - ty * dx) / denom; // along segment
        if (t < 0 || t > best) continue;
        if (u < 0 || u > 1) continue;
        if (!line.oneSided) {
            // Two-sided line: blocks hitscan/sight only when the vertical opening
            // is fully closed. The ML_BLOCKING flag (line.blocking) stops movement
            // in DOOM but NOT hitscans or line-of-sight, so it is ignored here —
            // otherwise shots fired over an impassable ledge into a pit are wrongly
            // absorbed by the ledge line and deal no damage.
            const front = world.sectors[line.frontSec];
            const back = world.sectors[line.backSec];
            if (front && back) {
                const open = Math.min(front.ceilHeight, back.ceilHeight) - Math.max(front.floorHeight, back.floorHeight);
                if (open > 0) continue;
            }
        }
        best = t;
    }
    return best;
}

/** True if `to` is visible from `from` (no solid wall between centers). */
export function checkSight(world: DoomWorld, from: Mobj, to: Mobj): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return true;
    const wall = rayWallDistance(world, from.x, from.y, dx / dist, dy / dist, dist);
    return wall >= dist - 1;
}

/** Nearest shootable mobj the ray strikes within `wallDist`, or null. */
function rayMobjHit(world: DoomWorld, shooter: Mobj, ox: number, oy: number, dx: number, dy: number, wallDist: number): { mobj: Mobj; dist: number } | null {
    let best: { mobj: Mobj; dist: number } | null = null;
    const candidates: Mobj[] = [...world.mobjs, world.player];
    for (const m of candidates) {
        if (m === shooter || m.removed) continue;
        if ((m.flags & MF.SHOOTABLE) === 0) continue;
        const rx = m.x - ox;
        const ry = m.y - oy;
        const proj = rx * dx + ry * dy; // distance along ray to closest approach
        if (proj <= 0 || proj > wallDist) continue;
        const perp = Math.abs(rx * dy - ry * dx);
        if (perp > m.radius) continue;
        const hit = proj - Math.sqrt(Math.max(0, m.radius * m.radius - perp * perp));
        if (!best || hit < best.dist) best = { mobj: m, dist: Math.max(0, hit) };
    }
    return best;
}

/** Hitscan attack from `shooter` along `angle`. Spawns puff/blood, applies damage. */
export function lineAttack(world: DoomWorld, shooter: Mobj, angle: number, range: number, damage: number): void {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const wallDist = rayWallDistance(world, shooter.x, shooter.y, dx, dy, range);
    const hit = rayMobjHit(world, shooter, shooter.x, shooter.y, dx, dy, wallDist);
    if (hit) {
        const hx = shooter.x + dx * hit.dist;
        const hy = shooter.y + dy * hit.dist;
        const hz = shooter.z + shooter.height * 0.5;
        const bleeds = (hit.mobj.flags & MF.COUNTKILL) !== 0 || hit.mobj === world.player;
        world.spawnById(bleeds ? "BLOOD" : "PUFF", hx, hy, hz, 0);
        damageMobj(world, hit.mobj, shooter, damage);
    } else {
        const px = shooter.x + dx * wallDist;
        const py = shooter.y + dy * wallDist;
        const pz = shooter.z + shooter.height * 0.5;
        world.spawnById("PUFF", px, py, pz, 0);
    }
}

/** Spawns a projectile from `source` aimed at `target`. */
export function spawnMissile(world: DoomWorld, source: Mobj, target: Mobj, id: string): void {
    const angle = Math.atan2(target.y - source.y, target.x - source.x);
    const z = source.z + 32;
    const m = world.spawnById(id, source.x, source.y, z, angle);
    if (!m) return;
    m.target = source; // owner (so it won't damage the shooter)
    m.momx = Math.cos(angle) * m.info.speed;
    m.momy = Math.sin(angle) * m.info.speed;
    world.events.sound?.(source.info.attackSound ?? "FIRSHT");
}

/** Applies damage; triggers pain/death state transitions. */
export function damageMobj(world: DoomWorld, target: Mobj, source: Mobj | null, damage: number): void {
    if ((target.flags & MF.SHOOTABLE) === 0 || target.health <= 0) return;

    if (target === world.player) {
        world.events.damagePlayer?.(damage);
        return;
    }

    target.health -= damage;
    const sets = STATE_SETS.get(target.info.id);
    if (target.health <= 0) {
        if (target.info.deathSound) world.events.sound?.(target.info.deathSound);
        const useX = sets?.xdeath !== undefined && target.health < -target.info.health;
        const dest = useX ? sets!.xdeath! : sets?.death;
        target.flags &= ~(MF.SOLID | MF.SHOOTABLE);
        if (dest !== undefined) setMobjState(world, target, dest);
        else target.removed = true;
        return;
    }

    // Wake up / retaliate.
    if (source && source !== target) {
        target.target = source;
        if (target.threshold === 0 && sets?.see !== undefined && target.stateId === sets.spawn) {
            setMobjState(world, target, sets.see);
        }
        target.threshold = 100;
    }

    // Pain.
    if (sets?.pain !== undefined && Math.random() * 256 < target.info.painChance) {
        if (target.info.painSound) world.events.sound?.(target.info.painSound);
        setMobjState(world, target, sets.pain);
    }
}

export { MELEE_RANGE };

/** Radius (splash) damage around `spot`, e.g. barrel/rocket explosions. */
export function radiusAttack(world: DoomWorld, spot: Mobj, source: Mobj | null, damage: number): void {
    const r = damage + 32;
    const candidates: Mobj[] = [...world.mobjs, world.player];
    for (const m of candidates) {
        if (m === spot || m.removed || (m.flags & MF.SHOOTABLE) === 0) continue;
        const dx = Math.abs(m.x - spot.x);
        const dy = Math.abs(m.y - spot.y);
        const dist = Math.max(dx, dy) - m.radius;
        if (dist >= r) continue;
        if (!checkSight(world, spot, m)) continue;
        damageMobj(world, m, source, Math.max(0, damage - Math.max(0, dist)));
    }
}

/** Advances a projectile by its momentum; explodes on wall or mobj contact. */
export function tryMissileMove(world: DoomWorld, m: Mobj): void {
    const dist = Math.hypot(m.momx, m.momy);
    if (dist < 1e-6) return;
    const dx = m.momx / dist;
    const dy = m.momy / dist;
    const wallDist = rayWallDistance(world, m.x, m.y, dx, dy, dist);
    const limit = Math.min(wallDist, dist);

    let target: { mobj: Mobj; dist: number } | null = null;
    const candidates: Mobj[] = [...world.mobjs, world.player];
    for (const o of candidates) {
        if (o === m || o === m.target || o.removed) continue;
        if ((o.flags & MF.SHOOTABLE) === 0) continue;
        const rx = o.x - m.x;
        const ry = o.y - m.y;
        const proj = rx * dx + ry * dy;
        if (proj <= 0 || proj > limit) continue;
        const perp = Math.abs(rx * dy - ry * dx);
        if (perp > o.radius + m.radius) continue;
        const hit = proj - Math.sqrt(Math.max(0, (o.radius + m.radius) ** 2 - perp * perp));
        if (!target || hit < target.dist) target = { mobj: o, dist: Math.max(0, hit) };
    }

    if (target) {
        const dmg = 3 * (1 + Math.floor(Math.random() * 8));
        damageMobj(world, target.mobj, m.target, dmg);
        explodeMissile(world, m, m.x + dx * target.dist, m.y + dy * target.dist);
        return;
    }
    if (wallDist < dist) {
        explodeMissile(world, m, m.x + dx * wallDist, m.y + dy * wallDist);
        return;
    }
    m.x += m.momx;
    m.y += m.momy;
}

function explodeMissile(world: DoomWorld, m: Mobj, x: number, y: number): void {
    m.x = x;
    m.y = y;
    m.momx = 0;
    m.momy = 0;
    m.momz = 0;
    m.flags &= ~MF.MISSILE;
    const set = STATE_SETS.get(m.info.id);
    if (m.info.deathSound) world.events.sound?.(m.info.deathSound);
    if (set) setMobjState(world, m, set.death);
    else m.removed = true;
}
