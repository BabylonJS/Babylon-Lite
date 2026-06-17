/**
 * Lab-only loading-progress instrumentation for the standalone demo pages.
 *
 * `installFetchProgress(canvas, { estimatedBytes })` temporarily wraps
 * `globalThis.fetch` so that every asset download performed during a demo's load
 * phase (WAD / BSP / glTF / environment / textures …) is measured and reported
 * to the page's loading overlay through `canvas` data attributes:
 *
 *   - `canvas.dataset.progress`      — "0".."100" while byte totals are known,
 *                                      removed entirely while indeterminate.
 *   - `canvas.dataset.loadingDetail` — the current phase, e.g. "Downloading
 *                                      assets…" or "Preparing scene…".
 *   - `canvas.dataset.loadingSize`   — a static, code-set size line that
 *                                      reiterates the measured engine/code size
 *                                      (the same KB shown on the demos gallery
 *                                      card) next to the demo's asset estimate,
 *                                      e.g. "Engine 126.6 KB · Assets 28 MB". Set
 *                                      once from `engineKB` and `estimatedBytes`
 *                                      and never updated.
 *
 * The per-page overlay script (in each `demo-*.html`) renders a determinate bar
 * from `data-progress` (hidden when absent, leaving the spinner as the
 * indeterminate indicator), mirrors `data-loading-detail` into the sub-label and
 * `data-loading-size` into a dedicated size line.
 *
 * This lives entirely in the lab/demo layer — the published `babylon-lite`
 * package is untouched, so there is zero impact on its API or bundle size. Call
 * the returned handle's `done()` once loading is finished (before setting
 * `canvas.dataset.ready`) to restore the original `fetch`.
 */

interface Task {
    total: number;
    loaded: number;
    done: boolean;
}

export interface LoadProgressHandle {
    /** Restore the original `fetch` and stop updating the overlay. */
    done(): void;
}

export interface InstallFetchProgressOptions {
    /**
     * Approximate total number of bytes this demo downloads during loading. When
     * provided it is shown immediately and used as the (stable) progress
     * denominator, so an estimate of the download size is always visible — even
     * before the first response arrives or for assets that lack a
     * `Content-Length` header.
     */
    estimatedBytes?: number;
    /**
     * The measured engine + demo-code size in KB — the same number shown on the
     * demos gallery card. When provided, or injected at build time as the global
     * `window.__DEMO_ENGINE_KB`, the loading overlay reiterates it next to the
     * asset estimate so the page states its full footprint.
     */
    engineKB?: number;
}

function formatBytes(bytes: number): string {
    if (bytes <= 0) {
        return "0 MB";
    }
    if (bytes >= 1048576) {
        return (bytes / 1048576).toFixed(bytes >= 10485760 ? 0 : 1) + " MB";
    }
    return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

export function installFetchProgress(canvas: HTMLElement, options: InstallFetchProgressOptions = {}): LoadProgressHandle {
    const estimate = Math.max(0, Math.round(options.estimatedBytes ?? 0));
    const engineKB = Math.max(0, options.engineKB ?? (globalThis as { __DEMO_ENGINE_KB?: number }).__DEMO_ENGINE_KB ?? 0);
    const original = globalThis.fetch.bind(globalThis);
    const tasks: Task[] = [];
    let started = 0;
    let active = 0;
    let finished = false;
    let raf = 0;
    let idleTimer: ReturnType<typeof setTimeout> | 0 = 0;
    let preparing = false;
    // Highest percentage shown so far. The bar is strictly monotonic — it only
    // ever moves forward — so multi-wave loads (download → CPU prep → download)
    // never visibly restart.
    let shownPct = 0;

    const render = (): void => {
        raf = 0;
        if (finished) {
            return;
        }
        let knownTotal = 0;
        let totalLoaded = 0;
        for (const t of tasks) {
            totalLoaded += t.loaded;
            if (t.total > 0) {
                knownTotal += t.total;
            }
        }

        // Keep the displayed total at least as large as the estimate (and never
        // below what we've already streamed) so the progress bar stays stable.
        const displayTotal = Math.max(estimate, knownTotal, totalLoaded);
        const haveSize = displayTotal > 0 && (estimate > 0 || knownTotal > 0);

        if (haveSize) {
            const raw = Math.min(99, Math.round((totalLoaded / displayTotal) * 100));
            // Monotonic clamp: a later download wave grows the known total (which
            // would otherwise drop the ratio) and CPU-bound "preparing" gaps
            // interleave with streaming. Without this the bar slides backwards and
            // visibly restarts between phases. The label may toggle between
            // "Downloading" and "Preparing", but the bar itself only advances and
            // never jumps to 100% until loading is actually finished (see done()).
            if (raw > shownPct) {
                shownPct = raw;
            }
            canvas.dataset.progress = String(shownPct);
            if (preparing) {
                canvas.dataset.loadingDetail = "Preparing scene…";
            } else if (started > 0) {
                canvas.dataset.loadingDetail = "Downloading assets…";
            }
        } else if (preparing) {
            // Quiet CPU-bound phase before any sized download (e.g. world gen):
            // keep the spinner indeterminate but describe the phase.
            canvas.dataset.loadingDetail = "Preparing scene…";
        } else if (started > 0) {
            // No size headers and no estimate: at least state how many assets are loading.
            delete canvas.dataset.progress;
            canvas.dataset.loadingDetail = "Loading " + started + " asset" + (started === 1 ? "" : "s") + "…";
        }
    };

    const schedule = (): void => {
        if (!raf) {
            raf = requestAnimationFrame(render);
        }
    };

    // Show "Preparing scene…" once downloads have been quiet for a moment (e.g.
    // during CPU-bound world generation), without flickering between back-to-back
    // sequential fetches.
    const refreshIdle = (): void => {
        if (active === 0 && started > 0) {
            if (!idleTimer) {
                idleTimer = setTimeout(() => {
                    idleTimer = 0;
                    preparing = true;
                    schedule();
                }, 350);
            }
        } else {
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = 0;
            }
            preparing = false;
        }
    };

    const wrapped: typeof fetch = async (input, init) => {
        const response = await original(input, init);

        const method = (init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")).toUpperCase();
        const contentType = response.headers.get("content-type") ?? "";
        // Only measure streamable GET bodies; never re-wrap WebAssembly responses
        // (some engines require a real network Response for instantiateStreaming).
        if (method !== "GET" || !response.ok || !response.body || contentType.includes("wasm")) {
            return response;
        }

        const total = Number(response.headers.get("content-length")) || 0;
        const task: Task = { total, loaded: 0, done: false };
        tasks.push(task);
        started++;
        active++;
        refreshIdle();
        schedule();

        const reader = response.body.getReader();
        const finishTask = (): void => {
            if (task.done) {
                return;
            }
            task.done = true;
            active = Math.max(0, active - 1);
            refreshIdle();
            schedule();
        };

        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    const { done, value } = await reader.read();
                    if (done) {
                        finishTask();
                        controller.close();
                        return;
                    }
                    task.loaded += value.byteLength;
                    schedule();
                    controller.enqueue(value);
                } catch (err) {
                    finishTask();
                    controller.error(err);
                }
            },
            cancel(reason) {
                finishTask();
                void reader.cancel(reason);
            },
        });

        // Preserve headers (content-type → .json()/.blob() keep working), status.
        return new Response(stream, { headers: response.headers, status: response.status, statusText: response.statusText });
    };

    globalThis.fetch = wrapped;

    // Static, code-set size line shown for the whole load and never updated by the
    // progress stream: the measured engine/code size (matching the gallery card)
    // reiterated next to the demo's asset estimate, e.g. "Engine 126.6 KB · Assets
    // 28 MB". `engineKB` comes from `window.__DEMO_ENGINE_KB`, injected next to the
    // demo HTML by both the build (deployed flat site) and the lab dev server, so it
    // resolves synchronously in every environment. Built with string concatenation
    // (not template literals) because the demo bundler's WGSL minify pass trims
    // leading whitespace from template-literal tails.
    if (estimate > 0 || engineKB > 0) {
        const assets = estimate > 0 ? formatBytes(estimate) : "";
        const engine = engineKB > 0 ? "Engine " + engineKB + " KB" : "";
        canvas.dataset.loadingSize = engine ? (assets ? engine + " · Assets " + assets : engine) : "Estimated demo assets: " + assets;
        schedule();
    }

    return {
        done(): void {
            if (finished) {
                return;
            }
            finished = true;
            if (globalThis.fetch === wrapped) {
                globalThis.fetch = original;
            }
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = 0;
            }
            if (raf) {
                cancelAnimationFrame(raf);
                raf = 0;
            }
            if (started > 0 || estimate > 0) {
                canvas.dataset.progress = "100";
                canvas.dataset.loadingDetail = "Preparing scene…";
            }
        },
    };
}
