// Rotate3D (BJS FlowGraphRotate3DBlock, glTF op `math/rotate3D`).
// Data block (PULL): rotates Vector3 `a` by Quaternion `b` via fg-math.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgRotate3D } from "../../fg-math.js";

export const rotate3DDef: FgBlockDef = {
    type: FgBlockType.Rotate3D,
    build: () => ({
        dataIn: [sockIn("a", FgType.Vector3), sockIn("b", FgType.Quaternion)],
        dataOut: [sockOut("value", FgType.Vector3)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgRotate3D(a, b));
    },
};
