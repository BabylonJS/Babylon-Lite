// MeshLoD demo — runtime controls panel.
//
// Builds the accessible viewer controls around public runtime setters and the
// network-simulator seam. Setter validation errors appear in the status line.

import {
    getMeshLoDDiagnostics,
    setMeshLoDCacheBudget,
    setMeshLoDDebugView,
    setMeshLoDScreenSpaceError,
    setMeshLoDStreamingPaused,
    type MeshLoDAsset,
    type MeshLoDDebugView,
} from "babylon-lite";
import type { MeshLoDNetworkSimulator } from "./mesh-lod-network-simulator.js";

const MIB = 1024 * 1024;

const DEBUG_VIEWS: { value: MeshLoDDebugView; label: string }[] = [
    { value: "none", label: "Material" },
    { value: "meshlet-id", label: "Meshlet ID" },
    { value: "lod-depth", label: "LOD depth" },
];

export interface MeshLoDControlsOptions {
    container: HTMLElement;
    assets: readonly MeshLoDAsset[];
    networkSim: MeshLoDNetworkSimulator;
    /** Called when the debug-view selector changes (demo updates the legend and
     *  switches to CPU reference selection so all views render correctly). */
    onDebugViewChange?: (view: MeshLoDDebugView) => void;
}

interface SliderSpec {
    id: string;
    label: string;
    min: number;
    max: number;
    step: number;
    value: number;
    format: (value: number) => string;
    onInput: (value: number) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const child of children) {
        node.append(child);
    }
    return node;
}

export function installMeshLoDControls(options: MeshLoDControlsOptions): void {
    const { container, assets, networkSim, onDebugViewChange } = options;
    container.replaceChildren();

    const status = el("div", { className: "hud-status", role: "status" });

    const runValidated = (action: () => void): void => {
        try {
            action();
            status.textContent = "";
        } catch (err) {
            status.textContent = err instanceof Error ? err.message : String(err);
        }
    };

    const forEachAsset = (fn: (asset: MeshLoDAsset) => void): void => {
        for (const asset of assets) {
            fn(asset);
        }
    };

    const makeSlider = (spec: SliderSpec): HTMLElement => {
        let acceptedValue = spec.value;
        const value = el("span", { className: "hud-value", id: `${spec.id}-value`, textContent: spec.format(spec.value) });
        const input = el("input", {
            type: "range",
            id: spec.id,
            min: String(spec.min),
            max: String(spec.max),
            step: String(spec.step),
            value: String(spec.value),
        });
        input.setAttribute("aria-describedby", `${spec.id}-value`);
        input.style.width = "100%";
        input.addEventListener("input", () => {
            const v = Number(input.value);
            runValidated(() => {
                spec.onInput(v);
                acceptedValue = v;
                value.textContent = spec.format(v);
            });
            input.value = String(acceptedValue);
        });
        const label = el("label", { htmlFor: spec.id }, [spec.label, value]);
        return el("div", { className: "hud-row" }, [label, input]);
    };

    // Screen-space error: 0.5–16 px, default 2.
    const sseRow = makeSlider({
        id: "mlod-sse",
        label: "Screen-space error",
        min: 0.5,
        max: 16,
        step: 0.1,
        value: 2,
        format: (v) => v.toFixed(1) + " px",
        onInput: (v) => forEachAsset((a) => setMeshLoDScreenSpaceError(a, v)),
    });

    // The shared control must fit every asset's immutable arena capacity.
    const budgetRow = makeSlider({
        id: "mlod-budget",
        label: "Cache budget",
        min: 32,
        max: Math.min(...assets.map((a) => getMeshLoDDiagnostics(a).gpuCacheCapacityBytes / MIB)),
        step: 1,
        value: Math.min(...assets.map((a) => getMeshLoDDiagnostics(a).gpuCacheBudgetBytes / MIB)),
        format: (v) => v.toFixed(0) + " MiB",
        onInput: (v) => forEachAsset((a) => setMeshLoDCacheBudget(a, v * MIB)),
    });

    // Latency: 0–2000 ms, default 100.
    const latencyRow = makeSlider({
        id: "mlod-latency",
        label: "Sim. latency",
        min: 0,
        max: 2000,
        step: 10,
        value: 100,
        format: (v) => v.toFixed(0) + " ms",
        onInput: (v) => networkSim.setLatencyMs(v),
    });

    // Bandwidth: unlimited or 0.5–64 MiB/s, default 8.
    const bandwidthValue = el("span", { className: "hud-value", id: "mlod-bandwidth-value", textContent: "8.0 MiB/s" });
    const bandwidthInput = el("input", { type: "range", id: "mlod-bandwidth", min: "0.5", max: "64", step: "0.5", value: "8" });
    bandwidthInput.setAttribute("aria-describedby", "mlod-bandwidth-value");
    bandwidthInput.style.width = "100%";
    const unlimited = el("input", { type: "checkbox", id: "mlod-bandwidth-unlimited" });
    const applyBandwidth = (): void => {
        if (unlimited.checked) {
            bandwidthInput.disabled = true;
            bandwidthValue.textContent = "Unlimited";
            networkSim.setBandwidthBytesPerSecond(Infinity);
        } else {
            bandwidthInput.disabled = false;
            const v = Number(bandwidthInput.value);
            bandwidthValue.textContent = v.toFixed(1) + " MiB/s";
            networkSim.setBandwidthBytesPerSecond(v * MIB);
        }
    };
    bandwidthInput.addEventListener("input", applyBandwidth);
    unlimited.addEventListener("change", applyBandwidth);
    const bandwidthRow = el("div", { className: "hud-row" }, [
        el("label", { htmlFor: "mlod-bandwidth" }, ["Sim. bandwidth ", bandwidthValue]),
        bandwidthInput,
        el("label", { className: "hud-inline", htmlFor: "mlod-bandwidth-unlimited" }, [unlimited, " Unlimited"]),
    ]);

    // Streaming pause.
    const pause = el("input", { type: "checkbox", id: "mlod-pause" });
    pause.addEventListener("change", () => runValidated(() => forEachAsset((a) => setMeshLoDStreamingPaused(a, pause.checked))));
    const pauseRow = el("div", { className: "hud-row" }, [el("label", { className: "hud-inline", htmlFor: "mlod-pause" }, [pause, " Pause fine streaming"])]);

    // Debug view selector.
    const debugSelect = el("select", { id: "mlod-debug" });
    for (const view of DEBUG_VIEWS) {
        debugSelect.append(el("option", { value: view.value, textContent: view.label }));
    }
    debugSelect.addEventListener("change", () =>
        runValidated(() => {
            const view = debugSelect.value as MeshLoDDebugView;
            forEachAsset((a) => setMeshLoDDebugView(a, view));
            onDebugViewChange?.(view);
        })
    );
    const debugRow = el("div", { className: "hud-row" }, [el("label", { htmlFor: "mlod-debug" }, ["Debug view"]), debugSelect]);

    const section = (title: string, rows: HTMLElement[]): HTMLElement =>
        el("section", { className: "hud-section" }, [el("h2", { className: "hud-section-title", textContent: title }), ...rows]);

    container.append(
        el("header", { className: "hud-header" }, [
            el("div", { className: "hud-eyebrow", textContent: "Babylon Lite / MeshLoD" }),
            el("h1", { className: "hud-heading", textContent: "Harvard-Yenching Institute statue" }),
            el("p", { className: "hud-intro", textContent: "Drag to orbit · Scroll to zoom" }),
        ]),
        section("Geometry", [sseRow, budgetRow]),
        section("Streaming", [bandwidthRow, latencyRow, pauseRow]),
        section("Display", [debugRow]),
        status
    );
}
