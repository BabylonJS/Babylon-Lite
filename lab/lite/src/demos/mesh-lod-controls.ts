// MeshLoD demo — runtime controls panel.
//
// Builds the accessible control HUD and wires every control to a PUBLIC runtime
// setter, the network-simulator seam, or the camera-path controller — never to
// internal state (architecture §15.3, REQ-DEMO-3/4). Each control shows its
// effective value; setter validation errors are surfaced in a status line.

import { setMeshLoDCacheBudget, setMeshLoDDebugView, setMeshLoDScreenSpaceError, setMeshLoDStreamingPaused, type MeshLoDAsset, type MeshLoDDebugView } from "babylon-lite";
import type { MeshLoDNetworkSimulator } from "./mesh-lod-network-simulator.js";
import type { MeshLoDCameraPathController } from "./mesh-lod-camera-path.js";

const MIB = 1024 * 1024;

const DEBUG_VIEWS: { value: MeshLoDDebugView; label: string }[] = [
    { value: "none", label: "None (material)" },
    { value: "meshlet-id", label: "Meshlet ID" },
    { value: "lod-depth", label: "LOD depth" },
    { value: "selected-group", label: "Selected group" },
    { value: "page-residency", label: "Page residency" },
    { value: "requested-pages", label: "Requested pages" },
    { value: "meshlet-cone", label: "Meshlet cone" },
];

export interface MeshLoDControlsOptions {
    container: HTMLElement;
    assets: readonly MeshLoDAsset[];
    networkSim: MeshLoDNetworkSimulator;
    cameraPath: MeshLoDCameraPathController;
    models: readonly { id: string; label: string }[];
    selectedModelId: string;
    onModelChange: (modelId: string) => void;
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
    const { container, assets, networkSim, cameraPath, models, selectedModelId, onModelChange, onDebugViewChange } = options;
    container.replaceChildren();

    const status = el("div", { className: "hud-status", role: "status" });
    status.style.minHeight = "1.1em";
    status.style.color = "#e08a4b";

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
            value.textContent = spec.format(v);
            runValidated(() => spec.onInput(v));
        });
        const label = el("label", { htmlFor: spec.id }, [spec.label, " ", value]);
        return el("div", { className: "hud-row" }, [label, input]);
    };

    const modelSelect = el("select", { id: "meshLodModel" });
    for (const model of models) {
        modelSelect.append(el("option", { value: model.id, textContent: model.label, selected: model.id === selectedModelId }));
    }
    modelSelect.disabled = models.length < 2;
    modelSelect.addEventListener("change", () => onModelChange(modelSelect.value));
    const modelRow = el("div", { className: "hud-row" }, [el("label", { htmlFor: "meshLodModel" }, ["Model"]), modelSelect]);

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

    // Effective GPU cache budget: 32–256 MiB, default 128.
    const budgetRow = makeSlider({
        id: "mlod-budget",
        label: "Cache budget",
        min: 32,
        max: 256,
        step: 1,
        value: 128,
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

    // Camera path: toggle + reset.
    const pathToggle = el("button", { type: "button", id: "mlod-path-toggle", textContent: "▶ Camera path" });
    pathToggle.setAttribute("aria-pressed", "false");
    const pathReset = el("button", { type: "button", id: "mlod-path-reset", textContent: "⟲ Reset" });
    const syncPathToggle = (): void => {
        pathToggle.textContent = cameraPath.enabled ? "⏸ Camera path" : "▶ Camera path";
        pathToggle.setAttribute("aria-pressed", String(cameraPath.enabled));
    };
    pathToggle.addEventListener("click", () => {
        cameraPath.setEnabled(!cameraPath.enabled);
        syncPathToggle();
    });
    pathReset.addEventListener("click", () => cameraPath.reset());
    syncPathToggle();
    const pathRow = el("div", { className: "hud-row hud-buttons" }, [pathToggle, pathReset]);

    // Fallback scenarios: reproducible delayed / paused / unavailable / terminal
    // conditions that keep the pinned coarse geometry rendering (REQ-DEMO-7). They
    // drive the existing latency/pause controls (so the UI stays consistent) and the
    // network simulator's fault injection.
    const applyLatency = (ms: number): void => {
        const s = document.getElementById("mlod-latency") as HTMLInputElement | null;
        if (s) {
            s.value = String(ms);
            s.dispatchEvent(new Event("input", { bubbles: true }));
        }
    };
    const applyPause = (on: boolean): void => {
        if (pause.checked !== on) {
            pause.checked = on;
            pause.dispatchEvent(new Event("change", { bubbles: true }));
        }
    };
    const scenarioButton = (id: string, label: string, apply: () => void): HTMLButtonElement => {
        const button = el("button", { type: "button", id, textContent: label });
        button.addEventListener("click", () => runValidated(apply));
        return button;
    };
    const scenarioRow = el("div", { className: "hud-row hud-buttons hud-scenarios" }, [
        scenarioButton("mlod-scn-delayed", "Delayed", () => {
            networkSim.setFailureMode("none");
            applyPause(false);
            applyLatency(2000);
        }),
        scenarioButton("mlod-scn-paused", "Paused", () => {
            networkSim.setFailureMode("none");
            applyPause(true);
        }),
        scenarioButton("mlod-scn-offline", "Offline", () => {
            applyPause(false);
            networkSim.setFailureMode("unavailable");
        }),
        scenarioButton("mlod-scn-corrupt", "Corrupt", () => {
            applyPause(false);
            networkSim.setFailureMode("corrupt");
        }),
        scenarioButton("mlod-scn-reset", "Reset", () => {
            networkSim.setFailureMode("none");
            applyPause(false);
            applyLatency(100);
        }),
    ]);

    container.append(
        el("div", { className: "hud-title", textContent: "MeshLoD controls" }),
        modelRow,
        sseRow,
        budgetRow,
        bandwidthRow,
        latencyRow,
        pauseRow,
        debugRow,
        pathRow,
        el("div", { className: "hud-sublabel", textContent: "Fallback scenarios" }),
        scenarioRow,
        status
    );
}
