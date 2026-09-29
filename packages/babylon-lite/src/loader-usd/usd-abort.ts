/** @internal Observe cancellation without waiting indefinitely for browser decoding or a Blob read.
 * Late successes are explicitly released by the operation's owner. */
export async function usdAbortable<T>(promise: Promise<T>, signal?: AbortSignal, releaseLate?: (value: T) => void): Promise<T> {
    if (!signal) {
        return promise;
    }
    let aborted = signal.aborted;
    let onAbort: (() => void) | undefined;
    const observed = promise.then((value) => {
        if (aborted) {
            releaseLate?.(value);
            signal.throwIfAborted();
        }
        return value;
    });
    const cancellation = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
            aborted = true;
            reject(signal.reason instanceof Error ? signal.reason : new Error("USD loading aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
            onAbort();
        }
    });
    try {
        return await Promise.race([observed, cancellation]);
    } finally {
        if (onAbort) {
            signal.removeEventListener("abort", onAbort);
        }
    }
}
