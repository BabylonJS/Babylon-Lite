// TransformVector (BJS FlowGraphTransformVectorBlock, glTF op `math/transform`).
// Data block (PULL): `value` = M · v. Input `a` is the vector, `b` is the matrix.
// Dispatches on runtime shape: Vec2×Matrix2D, Vec3×Matrix3D, Vec4×Mat4.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgTransformVector } from "../../fg-math.js";

export const transformVectorDef: FgBlockDef = {
    type: FgBlockType.TransformVector,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgTransformVector(a, b));
    },
};
