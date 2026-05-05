import type { BlockEmitter } from "../node-types.js";

export const emitter: BlockEmitter = {
    className: "NodeMaterialTeleportOutBlock",
    emit(block, _outputName, stage, state, ctx) {
        const entryPoint = block.serialized["entryPoint"];
        const entryPointId = typeof entryPoint === "number" ? entryPoint : typeof entryPoint === "string" && entryPoint.length > 0 ? Number(entryPoint) : NaN;
        if (!Number.isFinite(entryPointId)) {
            throw new Error(`NodeMaterial: TeleportOutBlock (id=${block.id}) has no entryPoint`);
        }
        const entryBlock = ctx.graph.blocks.get(entryPointId);
        if (!entryBlock || entryBlock.className !== "NodeMaterialTeleportInBlock") {
            throw new Error(`NodeMaterial: TeleportOutBlock (id=${block.id}) points to missing TeleportInBlock ${entryPointId}`);
        }
        return ctx.resolve(entryBlock, "input", stage, state);
    },
};
