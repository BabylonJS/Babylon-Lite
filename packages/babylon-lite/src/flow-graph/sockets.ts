// Tiny socket constructors used by block `build()` shapes. Pure functions, no
// state. The parser/builder later fills `source` (data inputs) and `targets`
// (signal outputs) from the graph edges; these helpers just produce the
// skeleton a def declares. Keeps block files terse and consistent with the
// porting skill (.github/copilot/skills/port-flow-graph-block.md).

import type { FgDataSocket, FgSignalSocket, FgType, FgValue } from "./types.js";

/** Declare a data INPUT socket (optional literal fallback). */
export function sockIn(name: string, type: FgType, defaultValue?: FgValue): FgDataSocket {
    return defaultValue === undefined ? { name, type } : { name, type, defaultValue };
}

/** Declare a data OUTPUT socket. */
export function sockOut(name: string, type: FgType): FgDataSocket {
    return { name, type };
}

/** Declare a signal INPUT socket. */
export function sigIn(name: string): FgSignalSocket {
    return { name, targets: [] };
}

/** Declare a signal OUTPUT socket. */
export function sigOut(name: string): FgSignalSocket {
    return { name, targets: [] };
}
