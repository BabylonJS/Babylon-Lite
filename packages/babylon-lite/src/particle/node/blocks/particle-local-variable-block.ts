import type { Color4, Vec2, Vec3 } from "../../../math/types.js";
import { column } from "../../particle-buffer.js";
import type { NpeBlockEvaluator } from "../npe-build.js";
import type { NpeGetter, NpeValue } from "../npe-value.js";

type LocalCommit = (index: number, shape: number, value0: number, value1: number, value2: number, value3: number) => void;
type LocalScratch = Vec2 & Partial<Vec3> & Partial<Color4>;

function captureValue(value: unknown, blockId: number, currentShape: number, index: number, commit: LocalCommit): number {
    let shape: number;
    let value0: number;
    let value1 = 0;
    let value2 = 0;
    let value3 = 0;
    if (typeof value === "number") {
        shape = 1;
        value0 = value;
    } else if (value !== null && typeof value === "object") {
        if ("r" in value) {
            const color = value as Partial<Color4>;
            if (typeof color.r !== "number" || typeof color.g !== "number" || typeof color.b !== "number" || typeof color.a !== "number") {
                throw new Error(`NodeParticle: ParticleLocalVariableBlock ${blockId} received an unsupported value`);
            }
            shape = 4;
            value0 = color.r;
            value1 = color.g;
            value2 = color.b;
            value3 = color.a;
        } else if ("z" in value) {
            const vector = value as Partial<Vec3>;
            if (typeof vector.x !== "number" || typeof vector.y !== "number" || typeof vector.z !== "number") {
                throw new Error(`NodeParticle: ParticleLocalVariableBlock ${blockId} received an unsupported value`);
            }
            shape = 3;
            value0 = vector.x;
            value1 = vector.y;
            value2 = vector.z;
        } else {
            const vector = value as Partial<Vec2>;
            if (typeof vector.x !== "number" || typeof vector.y !== "number") {
                throw new Error(`NodeParticle: ParticleLocalVariableBlock ${blockId} received an unsupported value`);
            }
            shape = 2;
            value0 = vector.x;
            value1 = vector.y;
        }
    } else {
        throw new Error(`NodeParticle: ParticleLocalVariableBlock ${blockId} received an unsupported value`);
    }
    if (currentShape !== 0 && currentShape !== shape) {
        throw new Error(`NodeParticle: ParticleLocalVariableBlock ${blockId} changed value type`);
    }
    commit(index, shape, value0, value1, value2, value3);
    return shape;
}

function readSnapshot(shape: number, value0: number, value1: number, value2: number, value3: number, scratch: LocalScratch): NpeValue {
    if (shape === 1) {
        return value0;
    }
    if (shape === 4) {
        scratch.r = value0;
        scratch.g = value1;
        scratch.b = value2;
        scratch.a = value3;
        return scratch as Color4;
    }
    scratch.x = value0;
    scratch.y = value1;
    if (shape === 3) {
        scratch.z = value2;
        return scratch as Vec3;
    }
    return scratch;
}

/** `ParticleLocalVariableBlock` snapshots one value per particle id or started animation-call epoch. */
export const particleLocalVariableBlock: NpeBlockEvaluator = {
    build(block, ctx) {
        const input = ctx.input(block, "input");
        const scratch: LocalScratch = { x: 0, y: 0 };
        let shape = 0;
        let getter: NpeGetter;
        if (block.serialized.scope === 0) {
            const buffer = ctx.state.buffer!;
            const prefix = `local.${block.id}.`;
            const cachedId = column(buffer, `${prefix}id`, Uint32Array);
            const cachedValid = column(buffer, `${prefix}valid`, Uint8Array);
            const values = [
                column(buffer, `${prefix}value0`, Float64Array),
                column(buffer, `${prefix}value1`, Float64Array),
                column(buffer, `${prefix}value2`, Float64Array),
                column(buffer, `${prefix}value3`, Float64Array),
            ];
            const commit: LocalCommit = (index, _shape, value0, value1, value2, value3) => {
                values[0]![index] = value0;
                values[1]![index] = value1;
                values[2]![index] = value2;
                values[3]![index] = value3;
                cachedId[index] = buffer.id[index]!;
                cachedValid[index] = 1;
            };
            getter = (index) => {
                const id = buffer.id[index]!;
                if (cachedValid[index] === 0 || cachedId[index] !== id) {
                    shape = captureValue(input(index), block.id, shape, index, commit);
                }
                return readSnapshot(shape, values[0]![index]!, values[1]![index]!, values[2]![index]!, values[3]![index]!, scratch);
            };
        } else {
            const system = ctx.state.system!;
            let epoch = ctx.state._localVariableLoopEpoch;
            if (!epoch) {
                epoch = { value: 0 };
                ctx.state._localVariableLoopEpoch = epoch;
                const previous = system._prepareFrame;
                system._prepareFrame = previous
                    ? () => {
                          previous();
                          epoch!.value++;
                      }
                    : () => {
                          epoch!.value++;
                      };
            }
            let lastEpoch = -1;
            let valid = false;
            let value0 = 0;
            let value1 = 0;
            let value2 = 0;
            let value3 = 0;
            const commit: LocalCommit = (_index, _shape, next0, next1, next2, next3) => {
                value0 = next0;
                value1 = next1;
                value2 = next2;
                value3 = next3;
                lastEpoch = epoch!.value;
                valid = true;
            };
            getter = (index) => {
                if (!valid || lastEpoch !== epoch!.value) {
                    shape = captureValue(input(index), block.id, shape, index, commit);
                }
                return readSnapshot(shape, value0, value1, value2, value3, scratch);
            };
        }
        ctx.setOutput(block.id, "output", getter);
    },
};
