// CubeRoot (BJS FlowGraphCubeRootBlock, glTF op `math/cbrt`).
// Data block (PULL): emits `value` via fg-math's `fgCbrt`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgCbrt } from "../../fg-math.js";

export const cubeRootDef: FgBlockDef = {
    type: FgBlockType.CubeRoot,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgCbrt(a));
    },
};
