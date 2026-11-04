// Rotate2D (BJS FlowGraphRotate2DBlock, glTF op `math/rotate2D`).
// Data block (PULL): rotates Vector2 `a` by `b` radians (CCW) via fg-math.
// glTF input `angle` maps to socket `b` (see declaration-mapper).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgRotate2D } from "../../fg-math.js";

export const rotate2DDef: FgBlockDef = {
    type: FgBlockType.Rotate2D,
    build: () => ({
        dataIn: [sockIn("a", FgType.Vector2), sockIn("b", FgType.Number)],
        dataOut: [sockOut("value", FgType.Vector2)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgRotate2D(a, b));
    },
};
