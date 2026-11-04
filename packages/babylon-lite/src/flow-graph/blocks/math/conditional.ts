// Conditional / select (BJS FlowGraphConditionalBlock, glTF op `math/select`).
// Data block (PULL): emits `onTrue` when `condition` is truthy, else `onFalse`.
// glTF inputs a/b map to onTrue/onFalse (see declaration-mapper).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";

export const conditionalDef: FgBlockDef = {
    type: FgBlockType.Conditional,
    build: () => ({
        dataIn: [sockIn("condition", FgType.Boolean, false), sockIn("onTrue", FgType.Any), sockIn("onFalse", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const condition = getDataValue(ctx, env, block, "condition");
        const chosen = condition ? getDataValue(ctx, env, block, "onTrue") : getDataValue(ctx, env, block, "onFalse");
        setDataValue(ctx, block, "value", chosen);
    },
};
