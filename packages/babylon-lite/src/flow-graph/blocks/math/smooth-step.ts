import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { fgSmoothStep } from "../../fg-math.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { FgType } from "../../types.js";

export const smoothStepDef: FgBlockDef = {
    type: FgBlockType.SmoothStep,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any), sockIn("c", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        setDataValue(ctx, block, "value", fgSmoothStep(getDataValue(ctx, env, block, "a"), getDataValue(ctx, env, block, "b"), getDataValue(ctx, env, block, "c")));
    },
};
