// ExtractVector2 (BJS FlowGraphExtractVector2Block, glTF op `math/extract2`).
// Data block (PULL): one Vec2 input `a` → two scalar outputs. glTF names the
// outputs by index ("0"/"1"); the declaration mapper maps those to Lite sockets
// `x`/`y`. Values come from fg-math's `fgExtract2`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgExtract2 } from "../../fg-math.js";

export const extract2Def: FgBlockDef = {
    type: FgBlockType.ExtractVector2,
    build: () => ({
        dataIn: [sockIn("a", FgType.Vector2)],
        dataOut: [sockOut("x", FgType.Number), sockOut("y", FgType.Number)],
    }),
    updateOutputs(block, ctx, env) {
        const [x, y] = fgExtract2(getDataValue(ctx, env, block, "a"));
        setDataValue(ctx, block, "x", x);
        setDataValue(ctx, block, "y", y);
    },
};
