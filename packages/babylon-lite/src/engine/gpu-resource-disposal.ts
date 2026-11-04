type GpuResourceDisposer = (() => void) | { destroy(): void };

/** @internal Attempt every feature-owned release, preserving destroy receivers and reporting failures. */
export function runGpuResourceDisposers(disposers: readonly GpuResourceDisposer[]): void {
    for (const dispose of disposers) {
        try {
            if (typeof dispose === "function") {
                dispose();
            } else {
                dispose.destroy();
            }
        } catch (error) {
            console.error("GPU resource retirement failed.", error);
        }
    }
}
