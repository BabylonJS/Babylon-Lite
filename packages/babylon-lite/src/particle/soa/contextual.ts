/**
 * Data-oriented contextual sources — SPIKE.
 *
 * The object runtime's `getContextualValue` returns per-particle state (position, colour, scaled direction,
 * …) as object references or per-step scratch. Here each source is instead a build-time factory that
 * captures the column(s) it reads and returns a getter which fills a REUSED scratch by particle index — so
 * the value graph stays allocation-free. Semantics (including which sources use the clamped per-particle
 * step vs the unclamped system step) mirror `getContextualValue` for 1e-6 parity.
 */
import { column, type ParticleBuffer } from "./particle-buffer.js";
import type { SoaSystem } from "./animate.js";
import type { SoaGetter } from "./value.js";
import type { Vec2, Vec3, Color4 } from "../../math/types.js";
import * as C from "./columns.js";

// Contextual source ids (Babylon.js `NodeParticleContextualSources`).
const CTX_POSITION = 0x0001;
const CTX_DIRECTION = 0x0002;
const CTX_AGE = 0x0003;
const CTX_LIFETIME = 0x0004;
const CTX_COLOR = 0x0005;
const CTX_SCALED_DIRECTION = 0x0006;
const CTX_SCALE = 0x0007;
const CTX_AGE_GRADIENT = 0x0008;
const CTX_ANGLE = 0x0009;
const CTX_INITIAL_COLOR = 0x0013;
const CTX_COLOR_DEAD = 0x0014;
const CTX_INITIAL_DIRECTION = 0x0015;
const CTX_COLOR_STEP = 0x0016;
const CTX_SCALED_COLOR_STEP = 0x0017;
const CTX_SIZE = 0x0019;
const CTX_DIRECTION_SCALE = 0x0020;

function color4Getter(buffer: ParticleBuffer, rName: string, gName: string, bName: string, aName: string): SoaGetter {
    const r = column(buffer, rName, Float32Array);
    const g = column(buffer, gName, Float32Array);
    const b = column(buffer, bName, Float32Array);
    const a = column(buffer, aName, Float32Array);
    const scratch: Color4 = { r: 0, g: 0, b: 0, a: 0 };
    return (i) => {
        scratch.r = r[i]!;
        scratch.g = g[i]!;
        scratch.b = b[i]!;
        scratch.a = a[i]!;
        return scratch;
    };
}

/** Build a getter for a contextual source, capturing the columns it reads. Mirrors `getContextualValue`. */
export function makeContextualGetter(buffer: ParticleBuffer, system: SoaSystem, source: number): SoaGetter {
    switch (source) {
        case CTX_AGE: {
            const age = buffer.age;
            return (i) => age[i]!;
        }
        case CTX_LIFETIME: {
            const lifeTime = buffer.lifeTime;
            return (i) => lifeTime[i]!;
        }
        case CTX_AGE_GRADIENT: {
            const age = buffer.age;
            const lifeTime = buffer.lifeTime;
            return (i) => age[i]! / lifeTime[i]!;
        }
        case CTX_POSITION: {
            const x = buffer.posX;
            const y = buffer.posY;
            const z = buffer.posZ;
            const s: Vec3 = { x: 0, y: 0, z: 0 };
            return (i) => {
                s.x = x[i]!;
                s.y = y[i]!;
                s.z = z[i]!;
                return s;
            };
        }
        case CTX_DIRECTION: {
            const x = buffer.dirX;
            const y = buffer.dirY;
            const z = buffer.dirZ;
            const s: Vec3 = { x: 0, y: 0, z: 0 };
            return (i) => {
                s.x = x[i]!;
                s.y = y[i]!;
                s.z = z[i]!;
                return s;
            };
        }
        case CTX_SCALED_DIRECTION: {
            const x = buffer.dirX;
            const y = buffer.dirY;
            const z = buffer.dirZ;
            const s: Vec3 = { x: 0, y: 0, z: 0 };
            // Uses the per-particle clamped step (like the object runtime's `_directionScale`).
            return (i) => {
                const k = system._scaledStep;
                s.x = x[i]! * k;
                s.y = y[i]! * k;
                s.z = z[i]! * k;
                return s;
            };
        }
        case CTX_DIRECTION_SCALE:
            return () => system._scaledStep;
        case CTX_SIZE: {
            const size = column(buffer, C.COL_SIZE, Float32Array);
            return (i) => size[i]!;
        }
        case CTX_ANGLE: {
            const angle = column(buffer, C.COL_ANGLE, Float32Array);
            return (i) => angle[i]!;
        }
        case CTX_SCALE: {
            const sx = column(buffer, C.COL_SCALE_X, Float32Array);
            const sy = column(buffer, C.COL_SCALE_Y, Float32Array);
            const s: Vec2 = { x: 0, y: 0 };
            return (i) => {
                s.x = sx[i]!;
                s.y = sy[i]!;
                return s;
            };
        }
        case CTX_COLOR:
            return color4Getter(buffer, C.COL_COLOR_R, C.COL_COLOR_G, C.COL_COLOR_B, C.COL_COLOR_A);
        case CTX_INITIAL_COLOR:
            return color4Getter(buffer, C.COL_INITIAL_COLOR_R, C.COL_INITIAL_COLOR_G, C.COL_INITIAL_COLOR_B, C.COL_INITIAL_COLOR_A);
        case CTX_COLOR_DEAD:
            return color4Getter(buffer, C.COL_COLOR_DEAD_R, C.COL_COLOR_DEAD_G, C.COL_COLOR_DEAD_B, C.COL_COLOR_DEAD_A);
        case CTX_COLOR_STEP:
            return color4Getter(buffer, C.COL_COLOR_STEP_R, C.COL_COLOR_STEP_G, C.COL_COLOR_STEP_B, C.COL_COLOR_STEP_A);
        case CTX_SCALED_COLOR_STEP: {
            const r = column(buffer, C.COL_COLOR_STEP_R, Float32Array);
            const g = column(buffer, C.COL_COLOR_STEP_G, Float32Array);
            const b = column(buffer, C.COL_COLOR_STEP_B, Float32Array);
            const a = column(buffer, C.COL_COLOR_STEP_A, Float32Array);
            const s: Color4 = { r: 0, g: 0, b: 0, a: 0 };
            // Uses the UNCLAMPED system step (matches the object runtime's `_scaledUpdateSpeed`).
            return (i) => {
                const k = system._scaledUpdateSpeed;
                s.r = r[i]! * k;
                s.g = g[i]! * k;
                s.b = b[i]! * k;
                s.a = a[i]! * k;
                return s;
            };
        }
        case CTX_INITIAL_DIRECTION: {
            const x = column(buffer, C.COL_INITIAL_DIR_X, Float32Array);
            const y = column(buffer, C.COL_INITIAL_DIR_Y, Float32Array);
            const z = column(buffer, C.COL_INITIAL_DIR_Z, Float32Array);
            const s: Vec3 = { x: 0, y: 0, z: 0 };
            return (i) => {
                s.x = x[i]!;
                s.y = y[i]!;
                s.z = z[i]!;
                return s;
            };
        }
        default:
            throw new Error(`SoA NodeParticle: unsupported contextual source 0x${source.toString(16)}`);
    }
}
