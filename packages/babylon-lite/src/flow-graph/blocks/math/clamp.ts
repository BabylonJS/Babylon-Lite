// Clamp (BJS FlowGraphClampBlock, glTF op `math/clamp`).
// Data block (PULL): emits `value` = min(max(a, b), c) — `b` is the lower bound,
// `c` the upper — type-generic across number / FlowGraphInteger / Vector2-4 via
// fg-math's `fgClamp`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgClamp } from "../../fg-math.js";

export const clampDef: FgBlockDef = {
    type: FgBlockType.Clamp,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any), sockIn("c", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        const c = getDataValue(ctx, env, block, "c");
        setDataValue(ctx, block, "value", fgClamp(a, b, c));
    },
};
