// Clean-room DOOM actor state machine.
//
// Each STATE is { sprite, frame, fullbright, tics, action, next }. Actors advance
// through linked states on the 35 Hz tic; an optional action runs on entry. Tic
// durations are approximations authored from public Doom behavior documentation,
// NOT copied from the GPL states[] array; only the visible animation cadence is
// reproduced.
//
// STATE_SETS maps a mobj id to its labelled entry points (spawn/see/melee/
// missile/pain/death/xdeath/raise). The thinker (actions.ts/think.ts) jumps to a
// label when the corresponding event happens.

export type ActionName =
    | "Look"
    | "Chase"
    | "FaceTarget"
    | "PosAttack"
    | "SPosAttack"
    | "TroopAttack"
    | "SargAttack"
    | "Pain"
    | "Scream"
    | "XScream"
    | "Fall"
    | "Explode"
    | "RemoveSelf";

export interface State {
    sprite: string;
    frame: number;
    fullbright: boolean;
    tics: number;
    action: ActionName | null;
    next: number;
}

export interface StateSet {
    spawn: number;
    see?: number;
    pain?: number;
    melee?: number;
    missile?: number;
    death: number;
    xdeath?: number;
    raise?: number;
}

export const STATES: State[] = [];
export const STATE_SETS = new Map<string, StateSet>();

/** Per-frame spec: [frameLetterIndex, tics, action, fullbright?]. */
type FrameSpec = [number, number, ActionName | null, boolean?];

interface Segment {
    start: number;
    end: number;
}

/** Appends a linked run of states for one segment; nexts chain forward by default. */
function seg(sprite: string, frames: FrameSpec[]): Segment {
    const start = STATES.length;
    for (const [frame, tics, action, fb] of frames) {
        STATES.push({ sprite, frame, fullbright: fb ?? false, tics, action, next: STATES.length + 1 });
    }
    return { start, end: STATES.length - 1 };
}

function link(end: number, next: number): void {
    STATES[end]!.next = next;
}

// A=0,B=1,... helper for readability.
const A = 0, B = 1, C = 2, D = 3, E = 4, F = 5, G = 6, H = 7, I = 8, J = 9, K = 10, L = 11, M = 12, N = 13, O = 14, P = 15, Q = 16, R = 17, S = 18, T = 19, U = 20;

// ── Zombieman (POSS) ────────────────────────────────────────────────────
{
    const stand = seg("POSS", [[A, 10, "Look"], [B, 10, "Look"]]);
    link(stand.end, stand.start);
    const run = seg("POSS", [[A, 4, "Chase"], [A, 4, "Chase"], [B, 4, "Chase"], [B, 4, "Chase"], [C, 4, "Chase"], [C, 4, "Chase"], [D, 4, "Chase"], [D, 4, "Chase"]]);
    link(run.end, run.start);
    const atk = seg("POSS", [[E, 10, "FaceTarget"], [F, 8, "PosAttack"], [E, 8, null]]);
    link(atk.end, run.start);
    const pain = seg("POSS", [[G, 3, null], [G, 3, "Pain"]]);
    link(pain.end, run.start);
    const death = seg("POSS", [[H, 5, null], [I, 5, "Scream"], [J, 5, "Fall"], [K, 5, null], [L, -1, null]]);
    link(death.end, death.end);
    const xdeath = seg("POSS", [[M, 5, null], [N, 5, "XScream"], [O, 5, "Fall"], [P, 5, null], [Q, 5, null], [R, 5, null], [S, 5, null], [T, -1, null]]);
    link(xdeath.end, xdeath.end);
    const raise = seg("POSS", [[K, 5, null], [J, 5, null], [I, 5, null], [H, 5, null]]);
    link(raise.end, run.start);
    STATE_SETS.set("ZOMBIEMAN", { spawn: stand.start, see: run.start, missile: atk.start, pain: pain.start, death: death.start, xdeath: xdeath.start, raise: raise.start });
}

// ── Shotgun guy (SPOS) ──────────────────────────────────────────────────
{
    const stand = seg("SPOS", [[A, 10, "Look"], [B, 10, "Look"]]);
    link(stand.end, stand.start);
    const run = seg("SPOS", [[A, 3, "Chase"], [A, 3, "Chase"], [B, 3, "Chase"], [B, 3, "Chase"], [C, 3, "Chase"], [C, 3, "Chase"], [D, 3, "Chase"], [D, 3, "Chase"]]);
    link(run.end, run.start);
    const atk = seg("SPOS", [[E, 10, "FaceTarget"], [F, 10, "SPosAttack", true], [E, 10, null]]);
    link(atk.end, run.start);
    const pain = seg("SPOS", [[G, 3, null], [G, 3, "Pain"]]);
    link(pain.end, run.start);
    const death = seg("SPOS", [[H, 5, null], [I, 5, "Scream"], [J, 5, "Fall"], [K, 5, null], [L, -1, null]]);
    link(death.end, death.end);
    const xdeath = seg("SPOS", [[M, 5, null], [N, 5, "XScream"], [O, 5, "Fall"], [P, 5, null], [Q, 5, null], [R, 5, null], [S, -1, null]]);
    link(xdeath.end, xdeath.end);
    const raise = seg("SPOS", [[L, 5, null], [K, 5, null], [J, 5, null], [I, 5, null], [H, 5, null]]);
    link(raise.end, run.start);
    STATE_SETS.set("SHOTGUNGUY", { spawn: stand.start, see: run.start, missile: atk.start, pain: pain.start, death: death.start, xdeath: xdeath.start, raise: raise.start });
}

// ── Imp (TROO) ──────────────────────────────────────────────────────────
{
    const stand = seg("TROO", [[A, 10, "Look"], [B, 10, "Look"]]);
    link(stand.end, stand.start);
    const run = seg("TROO", [[A, 3, "Chase"], [A, 3, "Chase"], [B, 3, "Chase"], [B, 3, "Chase"], [C, 3, "Chase"], [C, 3, "Chase"], [D, 3, "Chase"], [D, 3, "Chase"]]);
    link(run.end, run.start);
    const atk = seg("TROO", [[E, 8, "FaceTarget"], [F, 8, "FaceTarget"], [G, 6, "TroopAttack"]]);
    link(atk.end, run.start);
    const pain = seg("TROO", [[H, 2, null], [H, 2, "Pain"]]);
    link(pain.end, run.start);
    const death = seg("TROO", [[I, 8, null], [J, 8, "Scream"], [K, 6, null], [L, 6, "Fall"], [M, -1, null]]);
    link(death.end, death.end);
    const xdeath = seg("TROO", [[N, 5, null], [O, 5, "XScream"], [P, 5, null], [Q, 5, "Fall"], [R, 5, null], [S, 5, null], [T, 5, null], [U, -1, null]]);
    link(xdeath.end, xdeath.end);
    const raise = seg("TROO", [[M, 8, null], [L, 8, null], [K, 6, null], [J, 6, null], [I, 6, null]]);
    link(raise.end, run.start);
    STATE_SETS.set("IMP", { spawn: stand.start, see: run.start, melee: atk.start, missile: atk.start, pain: pain.start, death: death.start, xdeath: xdeath.start, raise: raise.start });
}

// ── Demon (SARG) / Spectre share frames ─────────────────────────────────
function demonSet(id: string): void {
    const stand = seg("SARG", [[A, 10, "Look"], [B, 10, "Look"]]);
    link(stand.end, stand.start);
    const run = seg("SARG", [[A, 2, "Chase"], [A, 2, "Chase"], [B, 2, "Chase"], [B, 2, "Chase"], [C, 2, "Chase"], [C, 2, "Chase"], [D, 2, "Chase"], [D, 2, "Chase"]]);
    link(run.end, run.start);
    const atk = seg("SARG", [[E, 8, "FaceTarget"], [F, 8, "FaceTarget"], [G, 8, "SargAttack"]]);
    link(atk.end, run.start);
    const pain = seg("SARG", [[H, 2, null], [H, 2, "Pain"]]);
    link(pain.end, run.start);
    const death = seg("SARG", [[I, 8, null], [J, 8, "Scream"], [K, 4, null], [L, 4, "Fall"], [M, 4, null], [N, -1, null]]);
    link(death.end, death.end);
    const raise = seg("SARG", [[N, 5, null], [M, 5, null], [L, 5, null], [K, 5, null], [J, 5, null], [I, 5, null]]);
    link(raise.end, run.start);
    STATE_SETS.set(id, { spawn: stand.start, see: run.start, melee: atk.start, pain: pain.start, death: death.start, raise: raise.start });
}
demonSet("DEMON");
demonSet("SPECTRE");

// ── Imp fireball projectile (BAL1) ──────────────────────────────────────
{
    const fly = seg("BAL1", [[A, 4, null, true], [B, 4, null, true]]);
    link(fly.end, fly.start);
    const boom = seg("BAL1", [[C, 6, null, true], [D, 6, null, true], [E, 6, "RemoveSelf", true]]);
    STATE_SETS.set("IMPBALL", { spawn: fly.start, death: boom.start });
}

// ── Bullet puff (PUFF) ──────────────────────────────────────────────────
{
    const s = seg("PUFF", [[A, 4, null, true], [B, 4, null, true], [C, 4, null], [D, 4, "RemoveSelf"]]);
    STATE_SETS.set("PUFF", { spawn: s.start, death: s.start });
}

// ── Blood (BLUD) ────────────────────────────────────────────────────────
{
    const s = seg("BLUD", [[C, 8, null], [B, 8, null], [A, 8, "RemoveSelf"]]);
    STATE_SETS.set("BLOOD", { spawn: s.start, death: s.start });
}

// ── Exploding barrel (BAR1 -> BEXP) ─────────────────────────────────────
{
    const idle = seg("BAR1", [[A, 6, null], [B, 6, null]]);
    link(idle.end, idle.start);
    const boom = seg("BEXP", [[A, 5, null, true], [B, 5, "Scream", true], [C, 5, null, true], [D, 10, "Explode", true], [D, 10, "RemoveSelf", true]]);
    STATE_SETS.set("BARREL", { spawn: idle.start, death: boom.start });
}
