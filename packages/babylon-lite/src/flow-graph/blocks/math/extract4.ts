// ExtractVector4 (BJS FlowGraphExtractVector4Block, glTF op `math/extract4`).
// Data block (PULL): one Vec4 input `a` -> four scalar outputs x/y/z/w (glTF
// indices 0/1/2/3 remapped in declaration-mapper).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgExtract4 } from "../../fg-math.js";

export const extract4Def: FgBlockDef = {
    type: FgBlockType.ExtractVector4,
    build: () => ({
        dataIn: [sockIn("a", FgType.Vector4)],
        dataOut: [sockOut("x", FgType.Number), sockOut("y", FgType.Number), sockOut("z", FgType.Number), sockOut("w", FgType.Number)],
    }),
    updateOutputs(block, ctx, env) {
        const [x, y, z, w] = fgExtract4(getDataValue(ctx, env, block, "a"));
        setDataValue(ctx, block, "x", x);
        setDataValue(ctx, block, "y", y);
        setDataValue(ctx, block, "z", z);
        setDataValue(ctx, block, "w", w);
    },
};
