// ExtractVector3 (BJS FlowGraphExtractVector3Block, glTF op `math/extract3`).
// Data block (PULL): one Vec3 input `a` -> three scalar outputs x/y/z (glTF
// indices 0/1/2 remapped in declaration-mapper).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgExtract3 } from "../../fg-math.js";

export const extract3Def: FgBlockDef = {
    type: FgBlockType.ExtractVector3,
    build: () => ({
        dataIn: [sockIn("a", FgType.Vector3)],
        dataOut: [sockOut("x", FgType.Number), sockOut("y", FgType.Number), sockOut("z", FgType.Number)],
    }),
    updateOutputs(block, ctx, env) {
        const [x, y, z] = fgExtract3(getDataValue(ctx, env, block, "a"));
        setDataValue(ctx, block, "x", x);
        setDataValue(ctx, block, "y", y);
        setDataValue(ctx, block, "z", z);
    },
};
