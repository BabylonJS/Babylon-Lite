import { describe, expect, it } from "vitest";
import {
    classifySplatLodOutcome,
    countSplatLodTargetDisplayGaps,
    createSplatLodRuntimeFailureGate,
    observeSplatLodGpuDevice,
    waitForSplatLodDeadline,
} from "../../../lab/lite/src/tools/splat-lod-comparison-outcome";
import type { SplatLodLeafRecord, SplatLodSampleRecord } from "../../../lab/lite/src/tools/splat-lod-comparison-types";

function leaf(overrides: Partial<SplatLodLeafRecord> = {}): SplatLodLeafRecord {
    return {
        id: "tree",
        index: 0,
        visible: true,
        nativeVisible: true,
        distance: 1,
        targetLod: 0,
        requestedLod: 0,
        displayedLod: 0,
        resolvedLods: [0],
        targetCount: 1,
        displayedCount: 1,
        targetSourceState: "resident",
        residentLods: [0],
        gap: 0,
        ...overrides,
    };
}

describe("splat LOD comparison outcomes", () => {
    it("never reports convergence when an error exists despite zero gaps", () => {
        expect(
            classifySplatLodOutcome({
                timedOut: false,
                quiet: true,
                ready: true,
                pressure: false,
                error: "device lost",
                queuedFiles: 0,
                pendingRequests: 0,
                gapLeaves: 0,
            })
        ).toBe("failed");
    });

    it("counts a positive target with no displayed representation as a gap", () => {
        expect(countSplatLodTargetDisplayGaps([leaf({ displayedLod: null, resolvedLods: [], displayedCount: null, gap: null })])).toBe(1);
    });

    it("requires conclusive readiness and zero pending work", () => {
        expect(
            classifySplatLodOutcome({
                timedOut: false,
                quiet: true,
                ready: true,
                pressure: false,
                error: null,
                queuedFiles: 0,
                pendingRequests: 1,
                gapLeaves: 0,
            })
        ).toBe("sampling");
    });

    it("propagates initialization failures and bounds initialization waits", async () => {
        await expect(waitForSplatLodDeadline(Promise.reject(new Error("init failed")), performance.now() + 100, "initialization")).rejects.toThrow("init failed");
        await expect(waitForSplatLodDeadline(new Promise(() => {}), performance.now() + 5, "initialization")).rejects.toThrow("initialization timed out");
    });

    it("disposes an initialization result that arrives after its deadline", async () => {
        let resolve!: (value: object) => void;
        const pending = new Promise<object>((complete) => (resolve = complete));
        const disposed: object[] = [];
        await expect(waitForSplatLodDeadline(pending, performance.now() + 5, "initialization", (value) => disposed.push(value))).rejects.toThrow("timed out");
        const late = {};
        resolve(late);
        await Promise.resolve();
        expect(disposed).toEqual([late]);
    });

    it("observes already-expired work and disposes a late result exactly once", async () => {
        let resolve!: (value: object) => void;
        const pending = new Promise<object>((complete) => (resolve = complete));
        const disposed: object[] = [];
        await expect(waitForSplatLodDeadline(pending, performance.now() - 1, "expired", (value) => disposed.push(value))).rejects.toThrow("expired timed out");
        const late = {};
        resolve(late);
        await Promise.resolve();
        expect(disposed).toEqual([late]);
        await expect(waitForSplatLodDeadline(Promise.reject(new Error("late rejection")), performance.now() - 1, "expired")).rejects.toThrow("expired timed out");
        await Promise.resolve();
    });

    it("aborts a stalled body at the shared deadline", async () => {
        let aborted = 0;
        await expect(waitForSplatLodDeadline(new Promise(() => {}), performance.now() + 5, "body", undefined, () => aborted++)).rejects.toThrow("body timed out");
        expect(aborted).toBe(1);
    });

    it("reports device loss without an uncaptured error and ignores teardown loss", async () => {
        let resolveLost!: (info: GPUDeviceLostInfo) => void;
        const listeners = new Set<EventListenerOrEventListenerObject>();
        const device = {
            lost: new Promise<GPUDeviceLostInfo>((resolve) => (resolveLost = resolve)),
            addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => listeners.add(listener),
            removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => listeners.delete(listener),
        } as Pick<GPUDevice, "lost" | "addEventListener" | "removeEventListener">;
        const failures: string[] = [];
        const teardown = observeSplatLodGpuDevice(device, (message) => failures.push(message));
        resolveLost({ reason: "unknown", message: "injected" } as GPUDeviceLostInfo);
        await Promise.resolve();
        expect(failures).toEqual(["WebGPU device lost (unknown): injected"]);
        teardown();
        expect(listeners.size).toBe(0);
        let resolveTeardownLost!: (info: GPUDeviceLostInfo) => void;
        const teardownDevice = {
            lost: new Promise<GPUDeviceLostInfo>((resolve) => (resolveTeardownLost = resolve)),
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        } as unknown as Pick<GPUDevice, "lost" | "addEventListener" | "removeEventListener">;
        const teardownObservation = observeSplatLodGpuDevice(teardownDevice, (message) => failures.push(message));
        teardownObservation();
        resolveTeardownLost({ reason: "destroyed", message: "owned teardown" } as GPUDeviceLostInfo);
        await Promise.resolve();
        expect(failures).toHaveLength(1);
    });

    it("turns a runtime error after readiness into the only accepted terminal record", async () => {
        const records: SplatLodSampleRecord[] = [];
        const gate = createSplatLodRuntimeFailureGate("lite", (record) => records.push(record));
        const sample = {
            type: "sample",
            disposition: "sampling",
            error: null,
        } as SplatLodSampleRecord;
        gate.accept(sample);
        gate.fail("pageerror: injected");
        gate.accept({ ...sample, disposition: "converged" });
        await expect(gate.failure).rejects.toThrow("pageerror: injected");
        expect(records.map((record) => record.disposition)).toEqual(["sampling", "failed"]);
    });
});
