// SetVariable (BJS FlowGraphSetVariableBlock, glTF op `variable/set`).
// Execution block: writes `value` into the editor variable named by
// `config.variable`, or writes the indexed KHR `config.variables` inputs, then
// fires `out`.

import type { FgBlockDef } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import { activateSignal, getDataValue } from "../../runtime.js";
import { sigIn, sigOut, sockIn } from "../../sockets.js";

export const setVariableDef: FgBlockDef = {
    type: FgBlockType.SetVariable,
    build: (config) => ({
        dataIn: Array.isArray(config?.variables)
            ? (config.variables as number[]).map((name) => sockIn(String(name), (config?.variableTypes as Record<string, FgType> | undefined)?.[String(name)] ?? FgType.Any))
            : [sockIn("value", FgType.Any)],
        signalIn: [sigIn("in")],
        signalOut: [sigOut("out")],
    }),
    execute(block, ctx, env) {
        const variables = block.config?.variables as number[] | undefined;
        if (variables) {
            for (const variable of variables) {
                const name = String(variable);
                cancelVariableInterpolation(ctx, name);
                ctx.userVariables[name] = getDataValue(ctx, env, block, name);
            }
        } else {
            const name = block.config?.variable as string;
            if (name !== undefined) {
                cancelVariableInterpolation(ctx, name);
                ctx.userVariables[name] = getDataValue(ctx, env, block, "value");
            }
        }
        activateSignal(ctx, env, block, "out");
    },
};

function cancelVariableInterpolation(ctx: Parameters<NonNullable<FgBlockDef["execute"]>>[1], name: string): void {
    for (const task of ctx.pending) {
        if (task.state.targetKey === `variable:${name}`) {
            task.canceled = true;
        }
    }
}
