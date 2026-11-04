import type { FgBlock } from "./types.js";
import type { FgContext, FgEnv, FgAccessor } from "./context.js";
import { getDataValue } from "./runtime.js";
import { FgType } from "./types.js";
import { fgInt } from "./custom-types/fg-integer.js";
import { parseJsonPointerTemplate, substituteJsonPointerTemplate } from "./gltf/json-pointer-template.js";

export interface ResolvedBlockPointer {
    readonly pointer: string;
    readonly accessor: FgAccessor;
}

export function pointerTypesCompatible(declared: FgType | undefined, actual: FgType): boolean {
    return declared === undefined || declared === FgType.Any || declared === actual || (declared === FgType.Vector4 && actual === FgType.Quaternion);
}

function resolveDelayReference(pointer: string, ctx: FgContext): FgAccessor | null | undefined {
    const delay = /^\/extensions\/KHR_interactivity\/delays\/(\d+)$/.exec(pointer);
    if (!delay) {
        return undefined;
    }
    const index = Number(delay[1]);
    const active = ctx.pending.some((task) => !task.canceled && !task.done && task.state.delayIndex === index);
    return active ? { type: FgType.Reference, get: () => fgInt(index) } : null;
}

/** Resolve a block's static or data-driven JSON pointer and retain its effective
 * path so target-based operations can coordinate interpolation ownership. */
export function resolveBlockPointer(block: FgBlock, ctx: FgContext, env: FgEnv): ResolvedBlockPointer | null {
    const staticPointer = block.config?.accessor as string | undefined;
    if (staticPointer) {
        const accessor = resolveDelayReference(staticPointer, ctx) ?? env.accessors[staticPointer] ?? env.resolveAccessor?.(staticPointer) ?? null;
        return accessor ? { pointer: staticPointer, accessor } : null;
    }

    const template = block.config?.pointerTemplate as string | undefined;
    if (!template) {
        return null;
    }
    let parsed;
    try {
        parsed = parseJsonPointerTemplate(template);
    } catch {
        return null;
    }
    const effective = substituteJsonPointerTemplate(parsed, (parameter) => getDataValue(ctx, env, block, parameter.id));
    if (!effective) {
        return null;
    }

    const delayAccessor = resolveDelayReference(effective, ctx);
    if (delayAccessor !== undefined) {
        return delayAccessor ? { pointer: effective, accessor: delayAccessor } : null;
    }

    const cached = env.accessors[effective];
    if (cached) {
        return { pointer: effective, accessor: cached };
    }
    const resolved = env.resolveAccessor?.(effective) ?? null;
    if (resolved) {
        env.accessors[effective] = resolved;
    }
    return resolved ? { pointer: effective, accessor: resolved } : null;
}

/** Resolve only the accessor for ordinary pointer get/set blocks. */
export function resolveBlockAccessor(block: FgBlock, ctx: FgContext, env: FgEnv): FgAccessor | null {
    return resolveBlockPointer(block, ctx, env)?.accessor ?? null;
}
