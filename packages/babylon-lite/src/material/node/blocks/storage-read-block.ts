import type { BlockEmitter, Stage } from "../node-types.js";

function loopKey(stage: Stage, blockId: number): string {
    return `${stage}|${blockId}`;
}

export const emitter: BlockEmitter = {
    className: "StorageReadBlock",
    emit(block, outputName, stage, state, _ctx) {
        if (outputName !== "value") {
            throw new Error(`StorageReadBlock "${block.name}": unsupported output "${outputName}"`);
        }
        const loopSource = block.inputs.get("loopID")?.source;
        if (!loopSource) {
            throw new Error(`StorageReadBlock "${block.name}": loopID input is not connected`);
        }
        const active = state.loopVariables.get(loopKey(stage, loopSource.blockId));
        if (!active) {
            throw new Error(`StorageReadBlock "${block.name}": loop ${loopSource.blockId} is not active`);
        }
        return { expr: active.valueVar, type: active.valueType };
    },
};
