// AngleBetween (BJS FlowGraphAngleBetweenBlock, glTF op `math/quatAngleBetween`).
// Data block (PULL): emits scalar `value` = 2·acos(clamp(dot(a,b),-1,1)).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgAngleBetween } from "../../fg-math.js";

export const angleBetweenDef: FgBlockDef = {
    type: FgBlockType.AngleBetween,
    build: () => ({
        dataIn: [sockIn("a", FgType.Quaternion), sockIn("b", FgType.Quaternion)],
        dataOut: [sockOut("value", FgType.Number)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgAngleBetween(a, b));
    },
};
