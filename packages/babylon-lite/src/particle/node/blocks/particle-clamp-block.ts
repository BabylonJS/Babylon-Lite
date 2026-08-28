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
            const minValue = min(i);
            const maxValue = max(i);
            if (typeof minValue !== "number" || typeof maxValue !== "number") {
                throw new Error(`NodeParticle: ParticleClampBlock ${block.id} received an unsupported value`);
            }
            if (typeof source === "number") {
                return clamp(source, minValue, maxValue);
            }
            if (!source || typeof source !== "object") {
                throw new Error(`NodeParticle: ParticleClampBlock ${block.id} received an unsupported value`);
            }
            if ("r" in source && typeof source.r === "number" && typeof source.g === "number" && typeof source.b === "number" && typeof source.a === "number") {
                color4.r = clamp(source.r, minValue, maxValue);
                color4.g = clamp(source.g, minValue, maxValue);
                color4.b = clamp(source.b, minValue, maxValue);
                color4.a = clamp(source.a, minValue, maxValue);
                return color4;
            }
            if ("z" in source && typeof source.x === "number" && typeof source.y === "number" && typeof source.z === "number") {
                vector3.x = clamp(source.x, minValue, maxValue);
                vector3.y = clamp(source.y, minValue, maxValue);
                vector3.z = clamp(source.z, minValue, maxValue);
                return vector3;
            }
            if ("x" in source && typeof source.x === "number" && typeof source.y === "number") {
                vector2.x = clamp(source.x, minValue, maxValue);
                vector2.y = clamp(source.y, minValue, maxValue);
                return vector2;
            }
            throw new Error(`NodeParticle: ParticleClampBlock ${block.id} received an unsupported value`);
        };
        ctx.setOutput(block.id, "output", getter);
    },
};
