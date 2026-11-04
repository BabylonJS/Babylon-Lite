// QuatConjugate (BJS FlowGraphConjugateBlock, glTF op `math/quatConjugate`).
// Data block (PULL): emits `value` = (-x, -y, -z, w) via fg-math's fgConjugate.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgConjugate } from "../../fg-math.js";

export const quatConjugateDef: FgBlockDef = {
    type: FgBlockType.Conjugate,
    build: () => ({
        dataIn: [sockIn("a", FgType.Quaternion)],
        dataOut: [sockOut("value", FgType.Quaternion)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        setDataValue(ctx, block, "value", fgConjugate(a));
    },
};
