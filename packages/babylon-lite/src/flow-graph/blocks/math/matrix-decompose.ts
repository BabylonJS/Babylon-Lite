// MatrixDecompose (BJS FlowGraphMatrixDecomposeBlock, glTF op `math/matDecompose`).
// Data block (PULL): decomposes a Mat4 into position (Vec3), rotationQuaternion
// (Quaternion), scaling (Vec3), and isValid (boolean).
// `isValid` is false if the matrix is not a valid TRS matrix (bottom row ≠ [0,0,0,1]).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgMatrixDecompose } from "../../fg-math.js";

export const matrixDecomposeDef: FgBlockDef = {
    type: FgBlockType.MatrixDecompose,
    build: () => ({
        dataIn: [sockIn("input", FgType.Matrix)],
        dataOut: [sockOut("position", FgType.Vector3), sockOut("rotationQuaternion", FgType.Quaternion), sockOut("scaling", FgType.Vector3), sockOut("isValid", FgType.Boolean)],
    }),
    updateOutputs(block, ctx, env) {
        const { position, rotationQuaternion, scaling, isValid } = fgMatrixDecompose(getDataValue(ctx, env, block, "input"));
        setDataValue(ctx, block, "position", position);
        setDataValue(ctx, block, "rotationQuaternion", rotationQuaternion);
        setDataValue(ctx, block, "scaling", scaling);
        setDataValue(ctx, block, "isValid", isValid);
    },
};
