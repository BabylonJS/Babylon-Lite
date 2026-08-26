// Classic `blob:` worker wrapper — the single worker-creation mechanism for every consumer.
//
// Why a blob worker: some restrictive host CSPs allow `worker-src blob:` only —
// a direct `new Worker("/path/worker.js")` is blocked. A blob: worker satisfies `worker-src blob:`,
// and its `importScripts` of a SAME-ORIGIN worker file is permitted by `script-src 'self'`. Both the
// bundler path (webpack aliases this as `Worker`) and the non-bundler `./standalone` path funnel
// through here, so there is exactly one worker mechanism to build and test.
//
// Why classic (`importScripts`) rather than a module blob worker: the package's prebuilt workers are
// self-contained classic scripts, so the blob only needs to import the resolved worker URL.

/** Wraps a worker script URL in a CSP-friendly `blob:` classic worker that `importScripts` it. */
export class BlobWorkerWrapper {
    private readonly _worker: Worker;

    /**
     * @param url - URL of the real (classic) worker script. Resolved against the document base, so a
     *   root-relative or relative URL becomes a same-origin absolute URL.
     */
    public constructor(url: string | URL) {
        const absolute = new URL(url, self.location.href).href;
        const bootstrap = `importScripts(${JSON.stringify(absolute)})`;
        const blobUrl = URL.createObjectURL(new Blob([bootstrap], { type: "text/javascript" }));
        this._worker = new Worker(blobUrl);
        // The worker keeps running after the object URL is revoked; free it immediately.
        URL.revokeObjectURL(blobUrl);
    }

    /** The underlying `Worker` to post messages to / receive messages from. */
    public getWorker(): Worker {
        return this._worker;
    }
}
