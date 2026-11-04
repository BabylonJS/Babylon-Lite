// DegToRad (BJS FlowGraphDegToRadBlock, glTF op `math/rad`).
// Data block (PULL): emits `value` via fg-math's `fgDegToRad`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgDegToRad } from "../../fg-math.js";

export const degToRadDef: FgBlockDef = {
    type: FgBlockType.DegToRad,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgDegToRad(a));
    },
};
