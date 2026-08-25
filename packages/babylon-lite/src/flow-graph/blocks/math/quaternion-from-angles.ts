import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { fgQuaternionFromAngles } from "../../fg-math.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { FgType } from "../../types.js";

export const quaternionFromAnglesDef: FgBlockDef = {
    type: FgBlockType.QuaternionFromAngles,
    build: () => ({
        dataIn: [sockIn("a", FgType.Number), sockIn("b", FgType.Number), sockIn("c", FgType.Number)],
        dataOut: [sockOut("value", FgType.Quaternion)],
    }),
    updateOutputs(block, ctx, env) {
        setDataValue(
            ctx,
            block,
            "value",
            fgQuaternionFromAngles(getDataValue(ctx, env, block, "a"), getDataValue(ctx, env, block, "b"), getDataValue(ctx, env, block, "c"), block.config?.order)
        );
    },
};
