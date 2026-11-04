// CombineVector4 (BJS FlowGraphCombineVector4Block, glTF op `math/combine4`).
// Data block (PULL): emits Vec4{a,b,c,d} from four scalars via fg-math.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgCombine4 } from "../../fg-math.js";

export const combine4Def: FgBlockDef = {
    type: FgBlockType.CombineVector4,
    build: () => ({
        dataIn: [sockIn("a", FgType.Number), sockIn("b", FgType.Number), sockIn("c", FgType.Number), sockIn("d", FgType.Number)],
        dataOut: [sockOut("value", FgType.Vector4)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        const c = getDataValue(ctx, env, block, "c");
        const d = getDataValue(ctx, env, block, "d");
        setDataValue(ctx, block, "value", fgCombine4(a, b, c, d));
    },
};
