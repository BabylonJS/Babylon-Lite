import type { ParsedParticleBlock, ParticleBlockEvaluator, ParticleValue, NpeGetter } from "../npe-types.js";
import { getContextualValue, getSystemValue } from "../npe-build-state.js";

const TYPE_INT = 0x0001;
const TYPE_FLOAT = 0x0002;
const TYPE_VECTOR2 = 0x0004;
const TYPE_VECTOR3 = 0x0008;
const TYPE_COLOR4 = 0x0080;

/** Parse a constant input value from its serialized type + value. */
function parseConstant(block: ParsedParticleBlock): ParticleValue {
    const type = typeof block.serialized.type === "number" ? block.serialized.type : TYPE_FLOAT;
    const value = block.serialized.value;
    const array = Array.isArray(value) ? (value as number[]) : null;

    switch (type) {
        case TYPE_INT:
        case TYPE_FLOAT:
            return typeof value === "number" ? value : 0;
        case TYPE_VECTOR2:
            return { x: array?.[0] ?? 0, y: array?.[1] ?? 0 };
        case TYPE_VECTOR3:
            return { x: array?.[0] ?? 0, y: array?.[1] ?? 0, z: array?.[2] ?? 0 };
        case TYPE_COLOR4:
            return { r: array?.[0] ?? 0, g: array?.[1] ?? 0, b: array?.[2] ?? 0, a: array?.[3] ?? 1 };
        default:
            return typeof value === "number" ? value : 0;
    }
}

/**
 * `ParticleInputBlock` — exposes a constant, a contextual source (per-particle state such as the current
 * colour or scaled direction), or a system source (e.g. the emitter position). Mirrors BJS
 * `ParticleInputBlock._build`.
 */
export const particleInputBlock: ParticleBlockEvaluator = {
    build(block, ctx) {
        const contextual = typeof block.serialized.contextualValue === "number" ? block.serialized.contextualValue : 0;
        const systemSource = typeof block.serialized.systemSource === "number" ? block.serialized.systemSource : 0;

        let getter: NpeGetter;
        if (contextual !== 0) {
            getter = (state) => getContextualValue(state, contextual);
        } else if (systemSource !== 0) {
            getter = (state) => getSystemValue(state, systemSource);
        } else {
            const constant = parseConstant(block);
            getter = () => constant;
        }

        ctx.setOutput(block.id, "output", getter);
    },
};
