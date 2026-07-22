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
import type { Vec3, Color4 } from "../../math/types.js";
import * as C from "./columns.js";

// Contextual source ids (Babylon.js `NodeParticleContextualSources`).
const CTX_POSITION = 0x0001;
const CTX_AGE = 0x0003;
const CTX_LIFETIME = 0x0004;
const CTX_COLOR = 0x0005;
const CTX_SCALED_DIRECTION = 0x0006;
const CTX_SCALED_COLOR_STEP = 0x0017;

/** Build a scratch-backed Color4 getter for four feature columns. Shared with lazy contextual sources. */
export function color4Getter(buffer: ParticleBuffer, rName: string, gName: string, bName: string, aName: string): SoaGetter {
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

/** Build a common contextual getter, or null when the source belongs to the lazy contextual extension. */
export function makeContextualGetter(buffer: ParticleBuffer, system: SoaSystem, source: number): SoaGetter | null {
    switch (source) {
        case CTX_AGE: {
            const age = buffer.age;
            return (i) => age[i]!;
        }
        case CTX_LIFETIME: {
            const lifeTime = buffer.lifeTime;
            return (i) => lifeTime[i]!;
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
        case CTX_COLOR:
            return color4Getter(buffer, C.COL_COLOR_R, C.COL_COLOR_G, C.COL_COLOR_B, C.COL_COLOR_A);
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
        default:
            return null;
    }
}
