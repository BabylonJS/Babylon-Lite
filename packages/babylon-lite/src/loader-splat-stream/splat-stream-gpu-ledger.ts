/** @internal Stream-wide accounting for every live or retirement-pending GPU allocation. */
export interface SplatStreamGpuLedger {
    readonly maxBytes: number;
    residentBytes: number;
    allocatedBytes: number;
    heldBytes: number;
    tryReserve(bytes: number): boolean;
    tryHold(bytes: number): boolean;
    commitHold(bytes: number): void;
    releaseHold(bytes: number): void;
    release(bytes: number): void;
    retire(bytes: number, dispose: () => void): void;
}

/** @internal Creates the single GPU allocation ledger owned by one stream. */
export function createSplatStreamGpuLedger(maxBytes: number, retire: (dispose: () => void) => void): SplatStreamGpuLedger {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new RangeError("[GaussianSplatStream] GPU ledger budget must be a positive safe integer");
    }
    const ledger: SplatStreamGpuLedger = {
        maxBytes,
        residentBytes: 0,
        allocatedBytes: 0,
        heldBytes: 0,
        tryReserve(bytes): boolean {
            if (!Number.isSafeInteger(bytes) || bytes < 0 || ledger.allocatedBytes + ledger.heldBytes + bytes > maxBytes) {
                return false;
            }
            ledger.residentBytes += bytes;
            ledger.allocatedBytes += bytes;
            return true;
        },
        tryHold(bytes): boolean {
            if (!Number.isSafeInteger(bytes) || bytes < 0 || ledger.allocatedBytes + ledger.heldBytes + bytes > maxBytes) {
                return false;
            }
            ledger.heldBytes += bytes;
            return true;
        },
        commitHold(bytes): void {
            ledger.heldBytes -= bytes;
            ledger.residentBytes += bytes;
            ledger.allocatedBytes += bytes;
        },
        releaseHold(bytes): void {
            ledger.heldBytes -= bytes;
        },
        release(bytes): void {
            ledger.residentBytes -= bytes;
            ledger.allocatedBytes -= bytes;
        },
        retire(bytes, dispose): void {
            ledger.residentBytes -= bytes;
            retire(() => {
                try {
                    dispose();
                } finally {
                    ledger.allocatedBytes -= bytes;
                }
            });
        },
    };
    return ledger;
}
