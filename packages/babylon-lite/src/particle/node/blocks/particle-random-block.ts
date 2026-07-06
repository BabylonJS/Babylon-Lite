import type { Vec2, Vec3, Color4 } from "../../../math/types.js";
import type { ParticleRandomValue } from "../../particle.js";
import type { ParticleBlockEvaluator, ParticleValue, NpeGetter } from "../npe-types.js";

const LOCK_NONE = 0;
const LOCK_PER_PARTICLE = 1;
const LOCK_PER_SYSTEM = 2;
const LOCK_ONCE_PER_PARTICLE = 3;

/**
 * Draw a random value between `min` and `max`, matching `ParticleRandomBlock`. Unlike `RandomRange`, this
 * draws **per component and never short-circuits** when min === max — the draw still advances the RNG,
 * which is essential for deterministic parity.
 */
function drawRandom(min: ParticleValue, max: ParticleValue): ParticleRandomValue {
    if (typeof min === "number") {
        const hi = typeof max === "number" ? max : 0;
        return min + Math.random() * (hi - min);
    }
    if (min && typeof min === "object") {
        if ("r" in min) {
            const lo = min as Color4;
            const hi = max && typeof max === "object" && "r" in max ? (max as Color4) : { r: 0, g: 0, b: 0, a: 0 };
            return {
                r: lo.r + Math.random() * (hi.r - lo.r),
                g: lo.g + Math.random() * (hi.g - lo.g),
                b: lo.b + Math.random() * (hi.b - lo.b),
                a: lo.a + Math.random() * (hi.a - lo.a),
            };
        }
        if ("z" in min) {
            const lo = min as Vec3;
            const hi = max && typeof max === "object" && "z" in max ? (max as Vec3) : { x: 0, y: 0, z: 0 };
            return {
                x: lo.x + Math.random() * (hi.x - lo.x),
                y: lo.y + Math.random() * (hi.y - lo.y),
                z: lo.z + Math.random() * (hi.z - lo.z),
            };
        }
        const lo = min as Vec2;
        const hi = max && typeof max === "object" ? (max as Vec2) : { x: 0, y: 0 };
        return {
            x: lo.x + Math.random() * (hi.x - lo.x),
            y: lo.y + Math.random() * (hi.y - lo.y),
        };
    }
    return 0;
}

/**
 * `ParticleRandomBlock` — a random value with a lock that controls how often it is re-drawn. The default
 * `PerParticle` lock draws once per particle (cached by particle id), so reading the same random block
 * multiple times within one particle's creation yields one draw. Mirrors BJS `ParticleRandomBlock`.
 */
export const particleRandomBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const minGetter = ctx.input(block, "min", () => 0);
        const maxGetter = ctx.input(block, "max", () => 1);
        const lockMode = typeof block.serialized.lockMode === "number" ? block.serialized.lockMode : LOCK_PER_PARTICLE;

        let storedValue: ParticleValue = null;
        let currentLockId = -2;

        const getter: NpeGetter = (state) => {
            if (lockMode === LOCK_ONCE_PER_PARTICLE) {
                // A `OncePerParticle` value is drawn once and stays fixed for the particle's whole life.
                // Cache it ON the particle (keyed by this block's id) rather than in a system-wide map, so
                // it is pruned when the particle is recycled instead of leaking one entry per particle id.
                const particle = state.particle;
                if (!particle) {
                    return drawRandom(minGetter(state), maxGetter(state));
                }
                let cache = particle._onceRandomValues;
                if (cache === undefined) {
                    cache = particle._onceRandomValues = new Map<number, ParticleRandomValue>();
                }
                let cached = cache.get(block.id);
                if (cached === undefined) {
                    cached = drawRandom(minGetter(state), maxGetter(state));
                    cache.set(block.id, cached);
                }
                return cached;
            }

            let lockId = -2;
            if (lockMode === LOCK_PER_PARTICLE) {
                lockId = state.particle?.id ?? -1;
            } else if (lockMode === LOCK_PER_SYSTEM) {
                lockId = 0;
            }

            if (lockMode === LOCK_NONE || currentLockId !== lockId) {
                if (lockMode !== LOCK_NONE) {
                    currentLockId = lockId;
                }
                storedValue = drawRandom(minGetter(state), maxGetter(state));
            }
            return storedValue;
        };

        ctx.setOutput(block.id, "output", getter);
    },
};
