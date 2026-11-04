// Sequence (BJS FlowGraphSequenceBlock, glTF op `flow/sequence`).
// Execution block: fires its N output flows `out_0`, `out_1`, … in order. The
// count comes from `config.outputSignalCount` (BJS) — the glTF mapper derives it
// from the node's declared output flow sockets. Defaults to 1.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { activateSignal } from "../../runtime.js";
import { sigIn, sigOut } from "../../sockets.js";

export const sequenceDef: FgBlockDef = {
    type: FgBlockType.Sequence,
    build: (config) => {
        const count = Math.max(1, (config?.outputSignalCount as number) ?? 1);
        const signalOut = [];
        for (let i = 0; i < count; i++) {
            signalOut.push(sigOut(`out_${i}`));
        }
        return { signalIn: [sigIn("in")], signalOut };
    },
    execute(block, ctx, env) {
        for (const sig of block.signalOut) {
            activateSignal(ctx, env, block, sig.name);
        }
    },
};
