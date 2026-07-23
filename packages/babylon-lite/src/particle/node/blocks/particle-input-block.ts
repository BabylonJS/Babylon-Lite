import type { Vec2, Vec3, Color4 } from "../../../math/types.js";
import type { NpeBlockEvaluator } from "../npe-build.js";
import type { NpeGetter, NpeValue } from "../npe-value.js";
import { makeContextualGetter } from "../npe-contextual.js";

const TYPE_INT = 0x0001;
const TYPE_FLOAT = 0x0002;
const TYPE_VECTOR2 = 0x0004;
const TYPE_VECTOR3 = 0x0008;
const TYPE_COLOR4 = 0x0080;

const SYS_TIME = 1;
const SYS_DELTA = 2;
const SYS_EMITTER = 3;

function parseConstant(type: number, value: unknown): NpeValue {
    const array = Array.isArray(value) ? (value as number[]) : null;
    switch (type) {
        case TYPE_INT:
        case TYPE_FLOAT:
            return typeof value === "number" ? value : 0;
        case TYPE_VECTOR2:
            return { x: array?.[0] ?? 0, y: array?.[1] ?? 0 } as Vec2;
        case TYPE_VECTOR3:
            return { x: array?.[0] ?? 0, y: array?.[1] ?? 0, z: array?.[2] ?? 0 } as Vec3;
        case TYPE_COLOR4:
            return { r: array?.[0] ?? 0, g: array?.[1] ?? 0, b: array?.[2] ?? 0, a: array?.[3] ?? 1 } as Color4;
        default:
            return typeof value === "number" ? value : 0;
    }
}

/** `ParticleInputBlock` — a constant, a contextual source, or a system source. */
export const particleInputBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const contextual = typeof block.serialized.contextualValue === "number" ? block.serialized.contextualValue : 0;
        const systemSource = typeof block.serialized.systemSource === "number" ? block.serialized.systemSource : 0;

        let getter: NpeGetter;
        if (contextual !== 0) {
            getter = makeContextualGetter(ctx.state.buffer!, ctx.state.system!, contextual)!;
        } else if (systemSource !== 0) {
            const system = ctx.state.system!;
            const emitter = ctx.state.emitter;
            switch (systemSource) {
                case SYS_TIME:
                    getter = () => system._actualFrame;
                    break;
                case SYS_DELTA:
                    getter = () => system._scaledUpdateSpeed;
                    break;
                case SYS_EMITTER:
                    getter = () => emitter;
                    break;
                default:
                    throw new Error(`NodeParticle: unsupported system source ${systemSource}`);
            }
        } else {
            const type = typeof block.serialized.type === "number" ? block.serialized.type : TYPE_FLOAT;
            const constant = parseConstant(type, block.serialized.value);
            getter = () => constant;
        }

        ctx.setOutput(block.id, "output", getter);
    },
};
