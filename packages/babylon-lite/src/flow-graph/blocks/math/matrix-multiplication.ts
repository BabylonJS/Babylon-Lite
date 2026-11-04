// MatrixMultiplication (BJS FlowGraphMatrixMultiplicationBlock, glTF op `math/matMul`).
// Data block (PULL): emits `value` = a × b (standard matrix product).
// Supports FgMatrix2D×FgMatrix2D, FgMatrix3D×FgMatrix3D, Mat4×Mat4.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgMatrixMultiplication } from "../../fg-math.js";

export const matrixMultiplicationDef: FgBlockDef = {
    type: FgBlockType.MatrixMultiplication,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any)],
        dataOut: [sockOut("value", FgType.Any)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgMatrixMultiplication(a, b));
    },
};
