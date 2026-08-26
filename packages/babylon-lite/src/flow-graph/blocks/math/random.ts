// Random (BJS FlowGraphRandomBlock, glTF op `math/random`).
// Data block (PULL): emits a fresh random `value` in [min, max) each pull
// (min/max default 0/1). getDataValue re-runs updateOutputs on every read, so a
// downstream consumer that reads twice in one cascade sees two draws.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgRandom } from "../../fg-math.js";

export const randomDef: FgBlockDef = {
    type: FgBlockType.Random,
    build: () => ({
        dataIn: [sockIn("min", FgType.Number, 0), sockIn("max", FgType.Number, 1)],
        dataOut: [sockOut("value", FgType.Number)],
    }),
    updateOutputs(block, ctx, env) {
        const min = getDataValue(ctx, env, block, "min") as number;
        const max = getDataValue(ctx, env, block, "max") as number;
        setDataValue(ctx, block, "value", fgRandom(min, max));
    },
};
