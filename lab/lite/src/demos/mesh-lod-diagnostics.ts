// MeshLoD demo — live diagnostics panel + debug-view legend.
//
// Reads the public per-asset `getMeshLoDDiagnostics` snapshot each frame,
// aggregates across the statue's three primitives, and renders the required
// metrics (architecture §15.4, REQ-DEMO-5). GPU timing uses the public
// render-task timing API and is shown as an explicit status — never a fake zero.
// The legend explains the active debug view's palette (REQ-DEMO-6).

import { getMeshLoDDiagnostics, getRenderTaskGpuTimings, type EngineContext, type MeshLoDAsset, type MeshLoDDebugView } from "babylon-lite";

const MIB = 1024 * 1024;

export interface MeshLoDDiagnosticsOptions {
    container: HTMLElement;
    legendContainer: HTMLElement;
    engine: EngineContext;
    assets: readonly MeshLoDAsset[];
}

export interface MeshLoDDiagnosticsHandle {
    setLegend(view: MeshLoDDebugView): void;
}

function groupThousands(value: number): string {
    return Math.round(value)
        .toString()
        .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function mib(bytes: number): string {
    return (bytes / MIB).toFixed(1) + " MiB";
}

/** Row definitions: id → label. Values are filled each tick. */
const ROWS: { id: string; label: string; section?: string }[] = [
    { id: "src", label: "Source triangles", section: "Geometry" },
    { id: "rendered", label: "Drawn triangles" },
    { id: "meshlets", label: "Selected meshlets" },
    { id: "visible", label: "Visible groups" },
    { id: "fallback", label: "Fallback groups" },
    { id: "depth", label: "Hierarchy depth" },
    { id: "sseSel", label: "Selected SSE" },
    { id: "sseUnmet", label: "Unmet SSE" },
    { id: "pagesReq", label: "Requested / queued / in flight", section: "Streaming" },
    { id: "pagesRes", label: "Resident / pinned / failed" },
    { id: "downloaded", label: "Downloaded" },
    { id: "gpuCache", label: "GPU cache / budget" },
    { id: "cpuCache", label: "CPU page cache" },
    { id: "concurrency", label: "Max requests" },
    { id: "streaming", label: "State" },
    { id: "selection", label: "Selection", section: "Frame" },
    { id: "gpuTiming", label: "GPU timing" },
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const child of children) {
        node.append(child);
    }
    return node;
}

function swatch(rgb: string, label: string): HTMLElement {
    const box = el("span", { className: "legend-swatch" });
    box.style.background = rgb;
    return el("div", { className: "legend-item" }, [box, label]);
}

function legendItems(view: MeshLoDDebugView): { title: string; items: HTMLElement[] } {
    switch (view) {
        case "meshlet-id":
            return { title: "Meshlet ID", items: [el("div", { className: "legend-note" }, ["Each meshlet (cluster) a stable random color."])] };
        case "lod-depth":
            return {
                title: "LOD depth",
                items: [
                    swatch("rgb(0,255,0)", "coarse (low depth)"),
                    swatch("rgb(128,255,128)", "mid"),
                    swatch("rgb(255,0,0)", "fine (high depth)"),
                ],
            };
        default:
            return { title: "", items: [] };
    }
}

export function installMeshLoDDiagnostics(options: MeshLoDDiagnosticsOptions): MeshLoDDiagnosticsHandle {
    const { container, legendContainer, engine, assets } = options;
    container.replaceChildren();
    container.append(
        el("header", { className: "hud-header" }, [
            el("div", { className: "hud-eyebrow", textContent: "Live telemetry" }),
            el("h2", { className: "hud-heading", textContent: "Renderer" }),
        ])
    );

    const values = new Map<string, HTMLElement>();
    for (const row of ROWS) {
        if (row.section) {
            container.append(el("h3", { className: "hud-section-title", textContent: row.section }));
        }
        const value = el("span", { className: "hud-value" });
        value.dataset.metric = row.id;
        values.set(row.id, value);
        container.append(el("div", { className: "hud-metric" }, [el("span", { className: "hud-metric-label", textContent: row.label }), value]));
    }

    const set = (id: string, text: string): void => {
        const node = values.get(id);
        if (node) {
            node.textContent = text;
        }
    };

    const gpuTimingText = (): string => {
        const t = getRenderTaskGpuTimings(engine);
        if (!t.supported || t.status === "unsupported") {
            return "unsupported";
        }
        if (t.status === "pending") {
            return "pending…";
        }
        if (t.status === "error") {
            return "error" + (t.error ? " (" + t.error + ")" : "");
        }
        if (t.status === "available" && t.tasks.length > 0) {
            const total = t.tasks.reduce((sum, task) => sum + task.durationMs, 0);
            return total.toFixed(2) + " ms";
        }
        return t.status; // "disabled" or "available" with no tasks yet — never a fake 0 ms
    };

    let lastTick = 0;
    const tick = (now: number): void => {
        requestAnimationFrame(tick);
        if (now - lastTick < 120) {
            return; // throttle DOM writes to ~8 Hz
        }
        lastTick = now;

        let src = 0,
            rendered = 0,
            meshlets = 0,
            visible = 0,
            fallback = 0,
            depth = 0,
            sseSel = 0,
            sseUnmet = 0,
            req = 0,
            queued = 0,
            inFlight = 0,
            resident = 0,
            pinned = 0,
            failed = 0,
            downloaded = 0,
            cacheUsed = 0,
            cacheBudget = 0,
            cpuCache = 0;
        let concurrency = 0;
        let paused = false;
        let mode = "gpu";
        for (const asset of assets) {
            const d = getMeshLoDDiagnostics(asset);
            src += d.sourceTriangleCount;
            rendered += d.renderedTriangleCount;
            meshlets += d.selectedMeshletCount;
            visible += d.visibleGroupCount;
            fallback += d.fallbackGroupCount;
            depth = Math.max(depth, asset.metadata.hierarchyDepth);
            sseSel = Math.max(sseSel, d.maximumSelectedErrorPixels);
            sseUnmet = Math.max(sseUnmet, d.maximumUnmetErrorPixels);
            req += d.requestedPageCount;
            queued += d.queuedPageCount;
            inFlight += d.inFlightPageCount;
            resident += d.residentPageCount;
            pinned += d.pinnedPageCount;
            failed += d.terminalFailedPageCount;
            downloaded += d.downloadedBytes;
            cacheUsed += d.gpuCacheUsedBytes;
            cacheBudget += d.gpuCacheBudgetBytes;
            cpuCache += d.cpuPageCacheUsedBytes;
            concurrency = Math.max(concurrency, d.maxConcurrentRequests);
            paused = paused || d.streamingPaused;
            mode = d.selectionMode;
        }

        set("src", groupThousands(src));
        set("rendered", groupThousands(rendered));
        set("meshlets", groupThousands(meshlets));
        set("visible", groupThousands(visible));
        set("fallback", groupThousands(fallback));
        set("depth", String(depth));
        set("sseSel", sseSel.toFixed(2) + " px");
        set("sseUnmet", sseUnmet.toFixed(2) + " px");
        set("pagesReq", req + " / " + queued + " / " + inFlight);
        set("pagesRes", resident + " / " + pinned + " / " + failed);
        set("downloaded", mib(downloaded));
        set("gpuCache", mib(cacheUsed) + " / " + mib(cacheBudget));
        set("cpuCache", mib(cpuCache));
        set("concurrency", String(concurrency));
        set("streaming", paused ? "paused" : "active");
        set("selection", mode.toUpperCase());
        set("gpuTiming", gpuTimingText());
    };
    requestAnimationFrame(tick);

    const setLegend = (view: MeshLoDDebugView): void => {
        legendContainer.replaceChildren();
        if (view === "none") {
            return;
        }
        const { title, items } = legendItems(view);
        legendContainer.append(el("div", { className: "hud-section-title", textContent: title }));
        for (const item of items) {
            legendContainer.append(item);
        }
    };

    return { setLegend };
}
