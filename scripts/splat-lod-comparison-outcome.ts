import type { SplatLodLeafRecord, SplatLodSampleRecord } from "./splat-lod-comparison-types";

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

export async function waitForSplatLodDeadline<T>(promise: Promise<T>, deadline: number, label: string, disposeLate?: (value: T) => void): Promise<T> {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
        throw new Error(`${label} timed out`);
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    try {
        return await Promise.race([
            promise.then((value) => {
                if (expired) {
                    disposeLate?.(value);
                }
                return value;
            }),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    expired = true;
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
