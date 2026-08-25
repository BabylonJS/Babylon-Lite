// MultiGate (BJS FlowGraphMultiGateBlock, glTF op `flow/multiGate`).
// Routes each activation to the NEXT unused output signal (`out_0`, `out_1`, …).
// config.isRandom (default false): pick a random unused output each time.
// config.isLoop (default false): wrap back to start when all outputs are used.
// config.outputSignalCount: number of output signals (required).
// `reset` signal clears state (all outputs unused, lastIndex = -1).
// `lastIndex` data output tracks the last activated output index.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { activateSignal, getExecVar, setDataValue, setExecVar } from "../../runtime.js";
import { sigIn, sigOut, sockOut } from "../../sockets.js";
import { fgInt } from "../../custom-types/fg-integer.js";

function nextIndex(used: boolean[], isRandom: boolean, isLoop: boolean): number {
    const allUsed = !used.includes(false);
    if (allUsed) {
        if (!isLoop) {
            return -1;
        }
        used.fill(false);
    }
    if (!isRandom) {
        return used.indexOf(false);
    }
    const unused = used.map((u, i) => (u ? -1 : i)).filter((i) => i >= 0);
    if (!unused.length) {
        return -1;
    }
    return unused[Math.floor(Math.random() * unused.length)]!;
}

export const multiGateDef: FgBlockDef = {
    type: FgBlockType.MultiGate,
    build: (config) => {
        const count = Math.max(1, (config?.outputSignalCount as number) ?? 1);
        const signalOut: ReturnType<typeof sigOut>[] = [];
        for (let i = 0; i < count; i++) {
            signalOut.push(sigOut(`out_${i}`));
        }
        return {
            dataOut: [sockOut("lastIndex", FgType.Integer)],
            signalIn: [sigIn("in"), sigIn("reset")],
            signalOut,
        };
    },
    updateOutputs(block, ctx) {
        setDataValue(ctx, block, "lastIndex", fgInt(getExecVar<number>(ctx, block, "lastIndex", -1)));
    },
    execute(block, ctx, env, incomingSignal) {
        const count = block.signalOut.length;
        const isRandom = !!(block.config?.isRandom as boolean | undefined);
        const isLoop = !!(block.config?.isLoop as boolean | undefined);

        if (incomingSignal === "reset") {
            setExecVar(ctx, block, "used", new Array(count).fill(false) as boolean[]);
            setExecVar(ctx, block, "lastIndex", -1);
            setDataValue(ctx, block, "lastIndex", fgInt(-1));
            return;
        }

        let used = getExecVar<boolean[] | undefined>(ctx, block, "used", undefined);
        if (!used) {
            used = new Array(count).fill(false) as boolean[];
        }

        const idx = nextIndex(used, isRandom, isLoop);
        if (idx >= 0) {
            used[idx] = true;
            setExecVar(ctx, block, "used", used);
            setExecVar(ctx, block, "lastIndex", idx);
            setDataValue(ctx, block, "lastIndex", fgInt(idx));
            activateSignal(ctx, env, block, `out_${idx}`);
        }
    },
};
