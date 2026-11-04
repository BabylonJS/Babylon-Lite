// AxisAngleFromQuaternion (BJS FlowGraphAxisAngleFromQuaternionBlock,
// glTF op `math/quatToAxisAngle`).
// Data block (PULL): `a` = Quaternion → `axis` (Vec3), `angle` (number),
// `isValid` (boolean). When sin(angle/2) is near zero, axis defaults to (1,0,0).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgAxisAngleFromQuaternion } from "../../fg-math.js";

export const axisAngleFromQuaternionDef: FgBlockDef = {
    type: FgBlockType.AxisAngleFromQuaternion,
    build: () => ({
        dataIn: [sockIn("a", FgType.Quaternion)],
        dataOut: [sockOut("axis", FgType.Vector3), sockOut("angle", FgType.Number), sockOut("isValid", FgType.Boolean)],
    }),
    updateOutputs(block, ctx, env) {
        const { axis, angle, isValid } = fgAxisAngleFromQuaternion(getDataValue(ctx, env, block, "a"));
        setDataValue(ctx, block, "axis", axis);
        setDataValue(ctx, block, "angle", angle);
        setDataValue(ctx, block, "isValid", isValid);
    },
};
