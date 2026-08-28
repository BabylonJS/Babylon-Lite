import type { Color4, Vec2, Vec3 } from "../../../math/types.js";
import type { NpeBlockEvaluator } from "../npe-build.js";
import type { NpeGetter } from "../npe-value.js";

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(value, max));
}

/** `ParticleClampBlock` — component-wise scalar-bound clamping into reused scratch values. */
export const particleClampBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        if (!ctx.isConnected(block, "value")) {
            throw new Error(`NodeParticle: ParticleClampBlock ${block.id} input "value" is not connected`);
        }
        const value = ctx.input(block, "value");
        const min = ctx.input(block, "min", () => 0);
        const max = ctx.input(block, "max", () => 1);
        const vector2: Vec2 = { x: 0, y: 0 };
        const vector3: Vec3 = { x: 0, y: 0, z: 0 };
        const color4: Color4 = { r: 0, g: 0, b: 0, a: 0 };
        const getter: NpeGetter = (i) => {
            const source = value(i);
            if (typeof source === "number") {
                const minValue = min(i);
                const maxValue = max(i);
                if (typeof minValue !== "number" || typeof maxValue !== "number") {
                    throw new Error(`NodeParticle: ParticleClampBlock ${block.id} received an unsupported value`);
                }
                return clamp(source, minValue, maxValue);
            }
            if (!source || typeof source !== "object") {
                throw new Error(`NodeParticle: ParticleClampBlock ${block.id} received an unsupported value`);
            }
            if ("r" in source && typeof source.r === "number" && typeof source.g === "number" && typeof source.b === "number" && typeof source.a === "number") {
                const r = source.r;
                const g = source.g;
                const b = source.b;
                const a = source.a;
                const minValue = min(i);
                const maxValue = max(i);
                if (typeof minValue !== "number" || typeof maxValue !== "number") {
                    throw new Error(`NodeParticle: ParticleClampBlock ${block.id} received an unsupported value`);
                }
                color4.r = clamp(r, minValue, maxValue);
                color4.g = clamp(g, minValue, maxValue);
                color4.b = clamp(b, minValue, maxValue);
                color4.a = clamp(a, minValue, maxValue);
                return color4;
            }
            if ("z" in source && typeof source.x === "number" && typeof source.y === "number" && typeof source.z === "number") {
                const x = source.x;
                const y = source.y;
                const z = source.z;
                const minValue = min(i);
                const maxValue = max(i);
                if (typeof minValue !== "number" || typeof maxValue !== "number") {
                    throw new Error(`NodeParticle: ParticleClampBlock ${block.id} received an unsupported value`);
                }
                vector3.x = clamp(x, minValue, maxValue);
                vector3.y = clamp(y, minValue, maxValue);
                vector3.z = clamp(z, minValue, maxValue);
                return vector3;
            }
            if ("x" in source && typeof source.x === "number" && typeof source.y === "number") {
                const x = source.x;
                const y = source.y;
                const minValue = min(i);
                const maxValue = max(i);
                if (typeof minValue !== "number" || typeof maxValue !== "number") {
                    throw new Error(`NodeParticle: ParticleClampBlock ${block.id} received an unsupported value`);
                }
                vector2.x = clamp(x, minValue, maxValue);
                vector2.y = clamp(y, minValue, maxValue);
                return vector2;
            }
            throw new Error(`NodeParticle: ParticleClampBlock ${block.id} received an unsupported value`);
        };
        ctx.setOutput(block.id, "output", getter);
    },
};
