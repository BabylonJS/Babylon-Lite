// QuaternionFromDirections (BJS FlowGraphQuaternionFromDirectionsBlock,
// glTF op `math/quatFromDirections`).
// Data block (PULL): `a`, `b` = Vec3 (assumed unit) → `value` = Quaternion.
// Does NOT pre-normalize inputs. Computes cross(a,b) as axis, acos(dot(a,b)) as angle.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgQuaternionFromDirections } from "../../fg-math.js";

export const quaternionFromDirectionsDef: FgBlockDef = {
    type: FgBlockType.QuaternionFromDirections,
    build: () => ({
        dataIn: [sockIn("a", FgType.Vector3), sockIn("b", FgType.Vector3)],
        dataOut: [sockOut("value", FgType.Quaternion)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgQuaternionFromDirections(a, b));
    },
};
