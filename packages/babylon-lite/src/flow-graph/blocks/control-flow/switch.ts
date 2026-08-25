// Flow Switch (BJS FlowGraphSwitchBlock, glTF op `flow/switch`).
// Routes the incoming signal to `out_<case>` if the numeric case value is in
// `config.cases`, or to `default` otherwise. Cases are integers.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { activateSignal, getDataValue } from "../../runtime.js";
import { sigIn, sigOut, sockIn } from "../../sockets.js";
import { isFgInt } from "../../custom-types/fg-integer.js";

export const switchDef: FgBlockDef = {
    type: FgBlockType.Switch,
    build: (config) => {
        const cases = (config?.cases as number[] | undefined) ?? [];
        const signalOut = [sigOut("default")];
        for (const c of cases) {
            signalOut.push(sigOut(`out_${c | 0}`));
        }
        return {
            dataIn: [sockIn("case", FgType.Any)],
            signalIn: [sigIn("in")],
            signalOut,
        };
    },
    execute(block, ctx, env) {
        const cases = (block.config?.cases as number[] | undefined) ?? [];
        const raw = getDataValue(ctx, env, block, "case");
        const key = isFgInt(raw) ? raw.value : typeof raw === "number" && Number.isInteger(raw) ? raw : undefined;
        const matched = key !== undefined && cases.some((c) => (c | 0) === key);
        activateSignal(ctx, env, block, matched ? `out_${key}` : "default");
    },
};
