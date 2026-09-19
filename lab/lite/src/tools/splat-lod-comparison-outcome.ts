import { formatSplatLodRuntimeError, type SplatLodLeafRecord, type SplatLodSampleRecord } from "./splat-lod-comparison-types";

export interface SplatLodOutcomeState {
    readonly timedOut: boolean;
    readonly quiet: boolean;
    readonly ready: boolean;
    readonly pressure: boolean;
    readonly error: string | null;
    readonly queuedFiles: number;
    readonly pendingRequests: number;
    readonly gapLeaves: number;
}

export function countSplatLodTargetDisplayGaps(leaves: readonly SplatLodLeafRecord[]): number {
    return leaves.filter((leaf) => leaf.visible && leaf.targetLod !== null && !leaf.resolvedLods.includes(leaf.targetLod)).length;
}

export function classifySplatLodOutcome(state: SplatLodOutcomeState): SplatLodSampleRecord["disposition"] {
    if (state.error) {
        return "failed";
    }
    if (state.timedOut) {
        return "timeout";
    }
    const settled = state.ready && state.queuedFiles === 0 && state.pendingRequests === 0;
    if (state.quiet && settled && state.gapLeaves === 0 && !state.pressure) {
        return "converged";
    }
    if (state.quiet && state.pressure) {
        return "budget-limited";
    }
    if (state.quiet && settled) {
        return "stalled";
    }
    return "sampling";
}

export function createSplatLodRuntimeFailureGate(
    engine: string,
    write: (record: SplatLodSampleRecord) => void,
    initializationRecord: SplatLodSampleRecord | null = null
): {
    readonly failure: Promise<never>;
    accept: (record: SplatLodSampleRecord) => void;
    fail: (message: string) => void;
} {
    let lastRecord = initializationRecord;
    let terminalFailure: Error | null = null;
    let rejectFailure!: (reason: Error) => void;
    const failure = new Promise<never>((_, reject) => {
        rejectFailure = reject;
    });
    void failure.catch(() => undefined);
    return {
        failure,
        accept(record) {
            if (terminalFailure) {
                return;
            }
            lastRecord = record;
            write(record);
        },
        fail(message) {
            if (terminalFailure) {
                return;
            }
            terminalFailure = new Error(formatSplatLodRuntimeError(engine, message));
            if (lastRecord) {
                write({ ...lastRecord, disposition: "failed", error: terminalFailure.message });
            }
            rejectFailure(terminalFailure);
        },
    };
}

export async function settleSplatLodRuntimeLifecycle<T>(operation: Promise<T>, close: () => Promise<void>, failure: Promise<never>): Promise<T> {
    let closePromise: Promise<void> | null = null;
    const closeOnce = (): Promise<void> => (closePromise ??= close());
    try {
        const result = await Promise.race([operation, failure]);
        await Promise.race([closeOnce(), failure]);
        return result;
    } catch (reason) {
        await closeOnce().catch(() => undefined);
        throw reason;
    }
}

export function observeSplatLodGpuDevice(device: Pick<GPUDevice, "lost" | "addEventListener" | "removeEventListener">, fail: (message: string) => void): () => void {
    let tearingDown = false;
    const onUncapturedError = (event: GPUUncapturedErrorEvent): void => {
        event.preventDefault();
        fail(event.error.message);
    };
    device.addEventListener("uncapturederror", onUncapturedError);
    void device.lost.then((info) => {
        if (!tearingDown) {
            fail(`WebGPU device lost (${info.reason}): ${info.message}`);
        }
    });
    return () => {
        tearingDown = true;
        device.removeEventListener("uncapturederror", onUncapturedError);
    };
}

export function readSplatLodJsonResponse(response: Response, deadline: number, label: string, controller: AbortController): Promise<unknown> {
    return waitForSplatLodDeadline(response.json(), deadline, label, undefined, () => controller.abort());
}

export async function waitForSplatLodDeadline<T>(promise: Promise<T>, deadline: number, label: string, disposeLate?: (value: T) => void, abort?: () => void): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const observed = new Promise<T>((resolve, reject) => {
        void promise.then(
            (value) => {
                if (expired) {
                    disposeLate?.(value);
                    return;
                }
                resolve(value);
            },
            (reason: unknown) => {
                if (!expired) {
                    reject(reason);
                }
            }
        );
    });
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
        expired = true;
        abort?.();
        throw new Error(`${label} timed out`);
    }
    try {
        return await Promise.race([
            observed,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    expired = true;
                    abort?.();
                    reject(new Error(`${label} timed out`));
                }, remaining);
            }),
        ]);
    } finally {
        if (timeout !== undefined) {
            clearTimeout(timeout);
        }
    }
}
