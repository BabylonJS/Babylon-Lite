import { describe, expect, it, vi } from "vitest";

import { acquireTrogirStartupResource, finishTrogirStartup, observeTrogirStartupReadiness } from "../../../lab/lite/src/demos/trogir-streaming-lifecycle";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe("Trogir streaming startup lifecycle", () => {
    it("disposes engine and stream resources that complete after pagehide", async () => {
        let disposed = false;
        const readiness = deferred<void>();
        const releaseStream = vi.fn(() => readiness.reject(new Error("disposed before first frame")));
        const stream = deferred<{ firstFrameReady: Promise<void> }>();
        const ownedStream = acquireTrogirStartupResource(
            stream.promise.then((candidate) => {
                observeTrogirStartupReadiness(candidate.firstFrameReady);
                return candidate;
            }),
            () => disposed,
            releaseStream
        );
        disposed = true;
        const lateStream = { firstFrameReady: readiness.promise };
        stream.resolve(lateStream);
        await expect(ownedStream).resolves.toBeNull();
        expect(releaseStream).toHaveBeenCalledWith(lateStream);
    });

    it.each(["register", "start", "firstFrame"] as const)("disposes before reporting a %s failure", async (failedPhase) => {
        let disposed = false;
        const fail = vi.fn();
        const failure = new Error(`${failedPhase} failed`);
        const readiness = deferred<void>();
        observeTrogirStartupReadiness(readiness.promise);
        const dispose = vi.fn(() => {
            disposed = true;
            readiness.reject(new Error("disposed before first frame"));
        });
        const rejectAt = (phase: Exclude<typeof failedPhase, "firstFrame">): Promise<void> => (failedPhase === phase ? Promise.reject(failure) : Promise.resolve());
        if (failedPhase === "firstFrame") {
            readiness.reject(failure);
        }
        await finishTrogirStartup({
            register: () => rejectAt("register"),
            start: () => rejectAt("start"),
            firstFrame: readiness.promise,
            isDisposed: () => disposed,
            dispose,
            ready: vi.fn(),
            fail,
        });
        expect(dispose).toHaveBeenCalledOnce();
        expect(fail).toHaveBeenCalledWith(failure);
        expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(fail.mock.invocationCallOrder[0]!);
    });

    it("does not report success or failure when pagehide disposes during an awaited phase", async () => {
        let disposed = false;
        const registration = deferred<void>();
        const readiness = deferred<void>();
        observeTrogirStartupReadiness(readiness.promise);
        const ready = vi.fn();
        const fail = vi.fn();
        const startup = finishTrogirStartup({
            register: () => registration.promise,
            start: () => Promise.resolve(),
            firstFrame: readiness.promise,
            isDisposed: () => disposed,
            dispose: () => {
                disposed = true;
            },
            ready,
            fail,
        });
        disposed = true;
        readiness.reject(new Error("disposed before first frame"));
        registration.resolve();
        await startup;
        expect(ready).not.toHaveBeenCalled();
        expect(fail).not.toHaveBeenCalled();
    });
});
