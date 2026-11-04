// Modulo (BJS FlowGraphModuloBlock, glTF op `math/rem`).
// Data block (PULL): emits `value` = a mod b, type-generic across number /
// FlowGraphInteger / Vector2-4 via fg-math's `fgRem`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgRem } from "../../fg-math.js";

export const moduloDef: FgBlockDef = {
    type: FgBlockType.Modulo,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgRem(a, b));
    },
};
