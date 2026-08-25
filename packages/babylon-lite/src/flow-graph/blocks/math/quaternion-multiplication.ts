// QuaternionMultiplication (BJS FlowGraphMultiply with `config.type =
// Quaternion`, glTF op `math/quatMul`). Data block (PULL): emits the Hamilton
// product `a ⊗ b` via fg-math's `fgQuatMul`.
//
// LITE DIVERGENCE: BJS reuses the generic Multiply block and switches it to the
// Quaternion path via config. Lite's generic Multiply is component-wise (Vec4
// and Quat are shape-identical `{x,y,z,w}` at runtime), so quaternion
// multiplication needs its own dedicated block to avoid mangling Vec4 math.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgQuatMul } from "../../fg-math.js";

export const quaternionMultiplicationDef: FgBlockDef = {
    type: FgBlockType.QuaternionMultiplication,
    build: () => ({
        dataIn: [sockIn("a", FgType.Any), sockIn("b", FgType.Any)],
        dataOut: [sockOut("value", FgType.Quaternion)],
    }),
    updateOutputs(block, ctx, env) {
        const a = getDataValue(ctx, env, block, "a");
        const b = getDataValue(ctx, env, block, "b");
        setDataValue(ctx, block, "value", fgQuatMul(a, b));
    },
};
