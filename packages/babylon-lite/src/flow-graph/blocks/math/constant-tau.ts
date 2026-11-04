import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { setDataValue } from "../../runtime.js";
import { sockOut } from "../../sockets.js";
import { FgType } from "../../types.js";

export const tauDef: FgBlockDef = {
    type: FgBlockType.Tau,
    build: () => ({ dataOut: [sockOut("value", FgType.Number)] }),
    updateOutputs(block, ctx) {
        setDataValue(ctx, block, "value", 2 * Math.PI);
    },
};
