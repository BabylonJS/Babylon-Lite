import { getRenderTaskGpuTimings, isRenderTaskGpuTimingSupported, setRenderTaskGpuTimingEnabled, type EngineContext, type RenderTaskGpuTimings } from "babylon-lite";

export interface OceanTimingPanel {
    enable(): Promise<void>;
    update(deltaMs: number): void;
}

function taskDuration(snapshot: RenderTaskGpuTimings, name: string): number {
    let duration = 0;
    for (const task of snapshot.tasks) {
        if (task.name === name) {
            duration += task.durationMs;
        }
    }
    return duration;
}

function formatMs(value: number): string {
    return `${value.toFixed(2)} ms`;
}

export function createOceanTimingPanel(engine: EngineContext): OceanTimingPanel {
    const root = document.getElementById("ocean-gpu-timing");
    if (!root) {
        throw new Error("Ocean GPU timing panel is missing.");
    }
    const fpsValue = root.querySelector<HTMLElement>("[data-timing=fps]")!;
    const computeValue = root.querySelector<HTMLElement>("[data-timing=compute]")!;
    const spectrumValue = root.querySelector<HTMLElement>("[data-timing=spectrum]")!;
    const fftValue = root.querySelector<HTMLElement>("[data-timing=fft]")!;
    const mergeValue = root.querySelector<HTMLElement>("[data-timing=merge]")!;
    const mipmapsValue = root.querySelector<HTMLElement>("[data-timing=mipmaps]")!;
    const totalValue = root.querySelector<HTMLElement>("[data-timing=total]")!;
    const statusValue = root.querySelector<HTMLElement>("[data-timing=status]")!;
    let smoothedFps = 0;
    let lastDomUpdate = 0;

    return {
        async enable(): Promise<void> {
            if (!isRenderTaskGpuTimingSupported(engine)) {
                statusValue.textContent = "Timestamp queries unsupported";
                root.dataset.supported = "false";
                return;
            }
            statusValue.textContent = "Waiting for GPU timestamps…";
            await setRenderTaskGpuTimingEnabled(engine, true);
        },
        update(deltaMs: number): void {
            if (deltaMs > 0) {
                const instantFps = 1000 / deltaMs;
                smoothedFps = smoothedFps === 0 ? instantFps : smoothedFps * 0.9 + instantFps * 0.1;
            }
            const now = performance.now();
            if (now - lastDomUpdate < 250) {
                return;
            }
            lastDomUpdate = now;
            fpsValue.textContent = smoothedFps > 0 ? smoothedFps.toFixed(1) : "—";
            const snapshot = getRenderTaskGpuTimings(engine);
            if (snapshot.status !== "available") {
                statusValue.textContent =
                    snapshot.status === "unsupported"
                        ? "Timestamp queries unsupported"
                        : snapshot.status === "error"
                          ? (snapshot.error ?? "GPU timing error")
                          : "Waiting for GPU timestamps…";
                return;
            }
            const spectrum = taskDuration(snapshot, "ocean-spectrum");
            const fft = taskDuration(snapshot, "ocean-fft");
            const merge = taskDuration(snapshot, "ocean-merge");
            const mipmaps =
                taskDuration(snapshot, "ocean-derivative-mipmaps") + taskDuration(snapshot, "ocean-turbulence-a-mipmaps") + taskDuration(snapshot, "ocean-turbulence-b-mipmaps");
            let total = 0;
            for (const task of snapshot.tasks) {
                total += task.durationMs;
            }
            spectrumValue.textContent = formatMs(spectrum);
            fftValue.textContent = formatMs(fft);
            mergeValue.textContent = formatMs(merge);
            mipmapsValue.textContent = formatMs(mipmaps);
            computeValue.textContent = formatMs(spectrum + fft + merge);
            totalValue.textContent = formatMs(total);
            statusValue.textContent = snapshot.droppedTaskCount > 0 ? `${snapshot.droppedTaskCount} task(s) not timed` : `GPU frame ${snapshot.frameIndex}`;
        },
    };
}
