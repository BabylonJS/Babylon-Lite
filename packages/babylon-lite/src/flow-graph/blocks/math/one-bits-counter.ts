// OneBitsCounter (BJS FlowGraphOneBitsCounterBlock, glTF op `math/popcnt`).
// Data block (PULL): emits `value` via fg-math's `fgPopcnt`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgPopcnt } from "../../fg-math.js";

export const oneBitsCounterDef: FgBlockDef = {
    type: FgBlockType.OneBitsCounter,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgPopcnt(a));
    },
};
