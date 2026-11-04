// Normalize (BJS FlowGraphNormalizeBlock, glTF op `math/normalize`).
// Data block (PULL): emits `value` via fg-math's `fgNormalize`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgNormalize } from "../../fg-math.js";

export const normalizeDef: FgBlockDef = {
    type: FgBlockType.Normalize,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgNormalize(a));
    },
};
