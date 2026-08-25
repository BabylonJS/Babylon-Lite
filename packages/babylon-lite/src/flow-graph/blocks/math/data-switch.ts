// DataSwitch (BJS FlowGraphDataSwitchBlock, glTF op `math/switch`).
// Data block (PULL): selects one of several value inputs by a numeric selector.
// `config.cases` is an array of numeric case keys; each creates an `in_<key>`
// data input. Reads `case`, looks up `in_<case>`, falls back to `default`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { getDataValue, setDataValue } from "../../runtime.js";
import { sockIn, sockOut } from "../../sockets.js";
import { isFgInt } from "../../custom-types/fg-integer.js";

export const dataSwitchDef: FgBlockDef = {
    type: FgBlockType.DataSwitch,
    build: (config) => {
        const cases = (config?.cases as number[] | undefined) ?? [];
        const dataIn = [sockIn("case", FgType.Any), sockIn("default", FgType.Any)];
        for (const c of cases) {
            dataIn.push(sockIn(`in_${c | 0}`, FgType.Any));
        }
        return { dataIn, dataOut: [sockOut("value", FgType.Any)] };
    },
    updateOutputs(block, ctx, env) {
        const cases = (block.config?.cases as number[] | undefined) ?? [];
        const selector = getDataValue(ctx, env, block, "case");
        const key = isFgInt(selector) ? selector.value : (selector as number);
        const matched = typeof key === "number" && cases.some((c) => (c | 0) === (key | 0));
        const socket = matched ? `in_${key | 0}` : "default";
        setDataValue(ctx, block, "value", getDataValue(ctx, env, block, socket));
    },
};
