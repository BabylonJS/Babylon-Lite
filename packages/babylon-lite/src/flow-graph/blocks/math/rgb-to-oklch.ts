import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { fgRgbToOkLCh } from "../../fg-math.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { FgType } from "../../types.js";

export const rgbToOkLChDef: FgBlockDef = {
    type: FgBlockType.RGBToOkLCh,
    build: () => ({
        dataIn: [sockIn("r", FgType.Number), sockIn("g", FgType.Number), sockIn("b", FgType.Number)],
        dataOut: [sockOut("l", FgType.Number), sockOut("c", FgType.Number), sockOut("h", FgType.Number)],
    }),
    updateOutputs(block, ctx, env) {
        const result = fgRgbToOkLCh(getDataValue(ctx, env, block, "r"), getDataValue(ctx, env, block, "g"), getDataValue(ctx, env, block, "b"));
        setDataValue(ctx, block, "l", result.l);
        setDataValue(ctx, block, "c", result.c);
        setDataValue(ctx, block, "h", result.h);
    },
};
