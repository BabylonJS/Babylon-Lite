import type { Color4, Vec2, Vec3 } from "../../../math/types.js";
import type { NpeBlockEvaluator } from "../npe-build.js";
import type { NpeGetter } from "../npe-value.js";

function step(value: number, edge: number): number {
    return value < edge ? 0 : 1;
}

/** `ParticleStepBlock` — component-wise thresholding into reused scratch values. */
export const particleStepBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        if (!ctx.isConnected(block, "value")) {
            throw new Error(`NodeParticle: ParticleStepBlock ${block.id} input "value" is not connected`);
        }
        const value = ctx.input(block, "value");
        const edge = ctx.input(block, "edge", () => 0);
        const vector2: Vec2 = { x: 0, y: 0 };
        const vector3: Vec3 = { x: 0, y: 0, z: 0 };
        const color4: Color4 = { r: 0, g: 0, b: 0, a: 0 };
        const getter: NpeGetter = (i) => {
            const source = value(i);
            if (typeof source === "number") {
                const edgeValue = edge(i);
                if (typeof edgeValue !== "number") {
                    throw new Error(`NodeParticle: ParticleStepBlock ${block.id} received an unsupported value`);
                }
                return step(source, edgeValue);
            }
            if (!source || typeof source !== "object") {
                throw new Error(`NodeParticle: ParticleStepBlock ${block.id} received an unsupported value`);
            }
            if ("r" in source && typeof source.r === "number" && typeof source.g === "number" && typeof source.b === "number" && typeof source.a === "number") {
                const r = source.r;
                const g = source.g;
                const b = source.b;
                const a = source.a;
                const edgeValue = edge(i);
                if (typeof edgeValue !== "number") {
                    throw new Error(`NodeParticle: ParticleStepBlock ${block.id} received an unsupported value`);
                }
                color4.r = step(r, edgeValue);
                color4.g = step(g, edgeValue);
                color4.b = step(b, edgeValue);
                color4.a = step(a, edgeValue);
                return color4;
            }
            if ("z" in source && typeof source.x === "number" && typeof source.y === "number" && typeof source.z === "number") {
                const x = source.x;
                const y = source.y;
                const z = source.z;
                const edgeValue = edge(i);
                if (typeof edgeValue !== "number") {
                    throw new Error(`NodeParticle: ParticleStepBlock ${block.id} received an unsupported value`);
                }
                vector3.x = step(x, edgeValue);
                vector3.y = step(y, edgeValue);
                vector3.z = step(z, edgeValue);
                return vector3;
            }
            if ("x" in source && typeof source.x === "number" && typeof source.y === "number") {
                const x = source.x;
                const y = source.y;
                const edgeValue = edge(i);
                if (typeof edgeValue !== "number") {
                    throw new Error(`NodeParticle: ParticleStepBlock ${block.id} received an unsupported value`);
                }
                vector2.x = step(x, edgeValue);
                vector2.y = step(y, edgeValue);
                return vector2;
            }
            throw new Error(`NodeParticle: ParticleStepBlock ${block.id} received an unsupported value`);
        };
        ctx.setOutput(block.id, "output", getter);
    },
};
