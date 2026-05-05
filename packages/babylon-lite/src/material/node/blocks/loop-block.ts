import type { BlockEmitter, NodeBlock, Stage } from "../node-types.js";
import { WGSL } from "../node-types.js";

function loopKey(stage: Stage, blockId: number): string {
    return `${stage}|${blockId}`;
}

function storageWritesForLoop(block: NodeBlock, ctx: Parameters<BlockEmitter["emit"]>[4]): NodeBlock[] {
    const writes: NodeBlock[] = [];
    for (const candidate of ctx.graph.blocks.values()) {
        if (candidate.className !== "StorageWriteBlock") {
            continue;
        }
        const loopID = candidate.inputs.get("loopID")?.source;
        if (loopID?.blockId === block.id && loopID.outputName === "loopID") {
            writes.push(candidate);
        }
    }
    return writes;
}

export const emitter: BlockEmitter = {
    className: "LoopBlock",
    emit(block, outputName, stage, state, ctx) {
        const active = state.loopVariables.get(loopKey(stage, block.id));
        if (outputName === "index") {
            if (!active) {
                throw new Error(`LoopBlock "${block.name}": index can only be read while emitting the loop body`);
            }
            return { expr: `f32(${active.indexVar})`, type: "f32" };
        }
        if (outputName === "loopID") {
            throw new Error(`LoopBlock "${block.name}": loopID can only be consumed by StorageReadBlock/StorageWriteBlock`);
        }
        if (outputName !== "output") {
            throw new Error(`LoopBlock "${block.name}": unsupported output "${outputName}"`);
        }

        const initial = ctx.resolve(block, "input", stage, state);
        const valueVar = ctx.temp(state, "loop");
        const indexVar = ctx.temp(state, "loopIndex");
        const body = stage === "vertex" ? state.vertex.body : state.fragment.body;
        body.push(`var ${valueVar}: ${WGSL[initial.type]} = ${initial.expr};`);

        const iterationsInput = block.inputs.get("iterations");
        const iterations = iterationsInput?.source
            ? `i32(${ctx.cast(ctx.resolve(block, "iterations", stage, state), "f32").expr})`
            : String(Math.max(0, Math.floor((block.serialized["iterations"] as number | undefined) ?? 4)));

        body.push(`for (var ${indexVar} = 0; ${indexVar} < ${iterations}; ${indexVar} = ${indexVar} + 1) {`);
        const key = loopKey(stage, block.id);
        const previous = state.loopVariables.get(key);
        const stageState = stage === "vertex" ? state.vertex : state.fragment;
        const previousMemo = new Map(stageState.memo);
        state.loopVariables.set(key, { valueVar, valueType: initial.type, indexVar });
        try {
            for (const write of storageWritesForLoop(block, ctx)) {
                const value = ctx.cast(ctx.resolve(write, "value", stage, state), initial.type);
                body.push(`${valueVar} = ${value.expr};`);
            }
        } finally {
            stageState.memo.clear();
            for (const [memoKey, memoValue] of previousMemo) {
                stageState.memo.set(memoKey, memoValue);
            }
            if (previous) {
                state.loopVariables.set(key, previous);
            } else {
                state.loopVariables.delete(key);
            }
        }
        body.push("}");
        return { expr: valueVar, type: initial.type };
    },
};
