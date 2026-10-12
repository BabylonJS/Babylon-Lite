import type { EngineContext } from "../engine/engine.js";

/** @internal Register an independent GPU resource family for engine teardown. */
export function registerManagedResourceDisposer(engine: EngineContext, dispose: () => void): void {
    const disposers = (engine._managedResourceDisposers ??= []);
    disposers.push(dispose);
    if (disposers.length !== 1) {
        return;
    }
    engine._disposeManagedResources = () => {
        for (let i = disposers.length; i-- > 0;) {
            disposers[i]!();
        }
    };
}
