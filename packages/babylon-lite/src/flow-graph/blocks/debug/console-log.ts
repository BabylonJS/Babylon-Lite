// ConsoleLog (BJS FlowGraphConsoleLogBlock, glTF ops `flow/log` in the BABYLON
// extension and `debug/log` in core). Execution block: logs a value to the
// console, then fires `out`.
//
// Two modes (mirrors BJS):
//  - `flow/log`: logs the `message` data input directly (raw value).
//  - `debug/log`: `config.messageTemplate` is a string with `{name}`
//    placeholders. Each placeholder becomes its own data input; at execution the
//    template is rendered by substituting each `{name}` with the serialized value
//    of the matching input (or, when `message` is an object, its same-named key).

import type { FgBlockDef, FgBlockShape } from "../../block-def.js";
import { FgBlockType } from "../../block-type.js";
import { FgType } from "../../types.js";
import type { FgValue } from "../../types.js";
import { activateSignal, getDataValue } from "../../runtime.js";
import { sigIn, sigOut, sockIn } from "../../sockets.js";

const PLACEHOLDER = /\{([^}]+)\}/g;

function templateMatches(template: string): string[] {
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    PLACEHOLDER.lastIndex = 0;
    while ((m = PLACEHOLDER.exec(template)) !== null) {
        matches.push(m[1]!);
    }
    return matches;
}

function serializeValue(value: FgValue): string {
    if (value === null || value === undefined) {
        return String(value);
    }
    if (typeof value === "object") {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

export const consoleLogDef: FgBlockDef = {
    type: FgBlockType.ConsoleLog,
    build: (config) => {
        const template = config?.messageTemplate as string | undefined;
        const shape: FgBlockShape = {
            dataIn: [sockIn("message", FgType.Any)],
            signalIn: [sigIn("in")],
            signalOut: [sigOut("out")],
        };
        if (template) {
            for (const name of templateMatches(template)) {
                if (name !== "message" && !shape.dataIn!.some((s) => s.name === name)) {
                    shape.dataIn!.push(sockIn(name, FgType.Any));
                }
            }
        }
        return shape;
    },
    execute(block, ctx, env) {
        const template = block.config?.messageTemplate as string | undefined;
        let message: FgValue;
        if (template) {
            const messageVal = getDataValue(ctx, env, block, "message");
            const messageObj = messageVal !== null && typeof messageVal === "object" ? (messageVal as unknown as Record<string, FgValue>) : null;
            let rendered = template;
            for (const name of templateMatches(template)) {
                const value = messageObj && name in messageObj ? messageObj[name] : getDataValue(ctx, env, block, name);
                if (value !== undefined) {
                    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                    rendered = rendered.replace(new RegExp(`\\{${escaped}\\}`, "g"), serializeValue(value));
                }
            }
            message = rendered;
        } else {
            message = getDataValue(ctx, env, block, "message");
        }
        // eslint-disable-next-line no-console
        console.log(message);
        activateSignal(ctx, env, block, "out");
    },
};
