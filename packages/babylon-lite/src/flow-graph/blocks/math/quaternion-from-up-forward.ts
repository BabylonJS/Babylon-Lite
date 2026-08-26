import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { fgQuaternionFromUpForward } from "../../fg-math.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { FgType } from "../../types.js";

export const quaternionFromUpForwardDef: FgBlockDef = {
    type: FgBlockType.QuaternionFromUpForward,
    build: () => ({
        dataIn: [sockIn("a", FgType.Vector3), sockIn("b", FgType.Vector3)],
        dataOut: [sockOut("value", FgType.Quaternion)],
    }),
    updateOutputs(block, ctx, env) {
        setDataValue(ctx, block, "value", fgQuaternionFromUpForward(getDataValue(ctx, env, block, "a"), getDataValue(ctx, env, block, "b")));
    },
};
