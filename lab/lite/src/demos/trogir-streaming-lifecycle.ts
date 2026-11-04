export async function acquireTrogirStartupResource<T>(resource: Promise<T>, isDisposed: () => boolean, disposeLate: (value: T) => void): Promise<T | null> {
    const value = await resource;
    if (isDisposed()) {
        disposeLate(value);
        return null;
    }
    return value;
}

export function observeTrogirStartupReadiness(readiness: Promise<unknown>): Promise<unknown> {
    // Observe disposal-triggered rejection immediately without changing the original promise awaited later.
    void readiness.then(undefined, () => {});
    return readiness;
}

export interface TrogirStartupPhases {
    readonly register: () => Promise<unknown>;
    readonly start: () => Promise<unknown>;
    readonly firstFrame: Promise<unknown>;
    readonly isDisposed: () => boolean;
    readonly dispose: () => void;
    readonly ready: () => void;
    readonly fail: (reason: unknown) => void;
}

export async function finishTrogirStartup(phases: TrogirStartupPhases): Promise<void> {
    try {
        await phases.register();
        if (phases.isDisposed()) {
            return;
        }
        await phases.start();
        if (phases.isDisposed()) {
            return;
        }
        await phases.firstFrame;
        if (!phases.isDisposed()) {
            phases.ready();
        }
    } catch (reason) {
        if (!phases.isDisposed()) {
            phases.dispose();
            phases.fail(reason);
        }
    }
}
