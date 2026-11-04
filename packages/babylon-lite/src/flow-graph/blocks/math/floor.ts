// Floor (BJS FlowGraphFloorBlock, glTF op `math/floor`).
// Data block (PULL): emits `value` = floor(a), type-generic across number /
// FlowGraphInteger / Vector2-4 via fg-math's `fgFloor`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgFloor } from "../../fg-math.js";

export const floorDef: FgBlockDef = {
    type: FgBlockType.Floor,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        setDataValue(ctx, block, "value", fgFloor(getDataValue(ctx, env, block, "a")));
    },
};
