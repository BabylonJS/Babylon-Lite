// The pure behaviour record for one block type. No classes, no `this`.
// Exactly ONE `FgBlockDef` per block kind; this is what a porter writes
// (see .github/copilot/skills/port-flow-graph-block.md).

import type { FgContext, FgEnv, FgPendingTask } from "./context.js";
import type { FgBlock, FgDataSocket, FgEventType, FgSignalSocket } from "./types.js";

/** The shape a def declares when a block is instantiated. */
export interface FgBlockShape {
    dataIn?: FgDataSocket[];
    dataOut?: FgDataSocket[];
    signalIn?: FgSignalSocket[];
    signalOut?: FgSignalSocket[];
    event?: FgEventType;
}

/**
 * Pure behaviour record for one block type. No classes, no `this`.
 * A def is stateless — all per-run state lives in `FgContext`, keyed by block id.
 */
export interface FgBlockDef {
    readonly type: string;

    /** Declare sockets/signals from config (called once at instantiation). */
    readonly build: (config: Readonly<Record<string, unknown>> | undefined) => FgBlockShape;

    /** DATA blocks: compute outputs from inputs (PULL). Writes via `setDataValue`. */
    readonly updateOutputs?: (block: FgBlock, ctx: FgContext, env: FgEnv) => void;

    /** EXECUTION blocks: run when an input signal fires (PUSH). For async blocks
     *  this is also where a task is started, via `addPending(ctx, block)`. */
    readonly execute?: (block: FgBlock, ctx: FgContext, env: FgEnv, incomingSignal: string) => void;

    /** ASYNC blocks: advance one outstanding task each frame (e.g. delay
     *  countdown, animation progress). The tick loop passes the specific task. */
    readonly onTick?: (block: FgBlock, ctx: FgContext, env: FgEnv, deltaMs: number, task: FgPendingTask) => void;

    /** ASYNC blocks: teardown hook called on dispose/cancel; mark tasks canceled. */
    readonly cancelPending?: (block: FgBlock, ctx: FgContext, env: FgEnv) => void;
}
