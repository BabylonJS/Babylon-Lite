import type { FgBlockDef } from "../block-def.js";
import { FgBlockType } from "../block-type.js";
import { defaultForType } from "../rich-type.js";
import { setDataValue } from "../runtime.js";
import { sigIn, sockIn, sockOut } from "../sockets.js";
import type { FgType } from "../types.js";

interface NoOpSocket {
    name: string;
    type: FgType;
    defaultValue?: import("../types.js").FgValue;
}

export const noOpDef: FgBlockDef = {
    type: FgBlockType.NoOp,
    build(config) {
        const inputs = (config?.inputs as NoOpSocket[] | undefined) ?? [];
        const outputs = (config?.outputs as NoOpSocket[] | undefined) ?? [];
        const signalInputs = (config?.signalInputs as string[] | undefined) ?? ["in"];
        return {
            dataIn: inputs.map(({ name, type }) => sockIn(name, type)),
            dataOut: outputs.map(({ name, type }) => sockOut(name, type)),
            signalIn: signalInputs.map(sigIn),
        };
    },
    updateOutputs(block, ctx) {
        for (const output of block.dataOut) {
            const configured = (block.config?.outputs as NoOpSocket[] | undefined)?.find((socket) => socket.name === output.name);
            setDataValue(ctx, block, output.name, configured?.defaultValue ?? defaultForType(output.type));
        }
    },
};
