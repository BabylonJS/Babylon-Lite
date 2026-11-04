// Sinh (BJS FlowGraphSinhBlock, glTF op `math/sinh`).
// Data block (PULL): emits `value` via fg-math's `fgSinh`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgSinh } from "../../fg-math.js";

export const sinhDef: FgBlockDef = {
    type: FgBlockType.Sinh,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgSinh(a));
    },
};
