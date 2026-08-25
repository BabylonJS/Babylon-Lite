// MatrixCompose (BJS FlowGraphMatrixComposeBlock, glTF op `math/matCompose`).
// Data block (PULL): composes a Mat4 from position (Vec3), rotationQuaternion
// (Quaternion), and scaling (Vec3). Uses core mat4Compose (column-major).

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { fgMatrixCompose } from "../../fg-math.js";

export const matrixComposeDef: FgBlockDef = {
    type: FgBlockType.MatrixCompose,
    build: () => ({
        dataIn: [sockIn("position", FgType.Vector3), sockIn("rotationQuaternion", FgType.Quaternion), sockIn("scaling", FgType.Vector3)],
        dataOut: [sockOut("value", FgType.Matrix)],
    }),
    updateOutputs(block, ctx, env) {
        const pos = getDataValue(ctx, env, block, "position");
        const quat = getDataValue(ctx, env, block, "rotationQuaternion");
        const scale = getDataValue(ctx, env, block, "scaling");
        setDataValue(ctx, block, "value", fgMatrixCompose(pos, quat, scale));
    },
};
