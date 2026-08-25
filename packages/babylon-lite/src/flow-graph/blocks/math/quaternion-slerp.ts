import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { fgQuatSlerp } from "../../fg-math.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { FgType } from "../../types.js";

export const mathSlerpDef: FgBlockDef = {
    type: FgBlockType.MathSlerp,
    build: () => ({
        dataIn: [sockIn("a", FgType.Quaternion), sockIn("b", FgType.Quaternion), sockIn("c", FgType.Number)],
        dataOut: [sockOut("value", FgType.Quaternion)],
    }),
    updateOutputs(block, ctx, env) {
        setDataValue(ctx, block, "value", fgQuatSlerp(getDataValue(ctx, env, block, "a"), getDataValue(ctx, env, block, "b"), getDataValue(ctx, env, block, "c")));
    },
};
