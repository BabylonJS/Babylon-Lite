// QuaternionFromAxisAngle (BJS FlowGraphQuaternionFromAxisAngleBlock,
// glTF op `math/quatFromAxisAngle`).
// Data block (PULL): `a` = Vec3 axis, `b` = number angle → `value` = Quaternion.
// Does NOT pre-normalize axis (replicates BJS Quaternion.RotationAxis).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgQuaternionFromAxisAngle } from "../../fg-math.js";

export const quaternionFromAxisAngleDef: FgBlockDef = {
    type: FgBlockType.QuaternionFromAxisAngle,
    build: () => ({
        dataIn: [sockIn("a", FgType.Vector3), sockIn("b", FgType.Number)],
        dataOut: [sockOut("value", FgType.Quaternion)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgQuaternionFromAxisAngle(a, b));
    },
};
