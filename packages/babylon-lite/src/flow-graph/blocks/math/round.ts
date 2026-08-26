// Round (BJS FlowGraphRoundBlock, glTF op `math/round`).
// Data block (PULL): emits `value` via fg-math's `fgRound`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgRound } from "../../fg-math.js";

export const roundDef: FgBlockDef = {
    type: FgBlockType.Round,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgRound(a));
    },
};
