// CombineVector2 (BJS FlowGraphCombineVector2Block, glTF op `math/combine2`).
// Data block (PULL): emits `value` = Vec2{x:a, y:b} from two scalars via
// fg-math's `fgCombine2`. glTF input sockets are `a`/`b`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgCombine2 } from "../../fg-math.js";

export const combine2Def: FgBlockDef = {
    type: FgBlockType.CombineVector2,
    build: () => ({
        dataIn: [sockIn("a", FgType.Number), sockIn("b", FgType.Number)],
        dataOut: [sockOut("value", FgType.Vector2)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgCombine2(a, b));
    },
};
