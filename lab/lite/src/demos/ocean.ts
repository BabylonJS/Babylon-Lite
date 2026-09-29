/**
 * Ocean — Babylon Lite compute demo.
 *
 * Port of Playground YX6IB8#758. The implementation is split under `ocean/`;
 * this entry owns only page lifecycle and progress/error reporting.
 */
import { runOceanDemo } from "./ocean/demo.js";
import { configureDemoDecoderBases } from "./demo-asset-url.js";
import { installFetchProgress } from "./loading-progress.js";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const progress = installFetchProgress(canvas, { estimatedBytes: 6_400_000 });
    try {
        configureDemoDecoderBases(import.meta.url);
        await runOceanDemo(canvas);
    } finally {
        progress.done();
    }
}

void main().catch((error: unknown) => {
    console.error(error);
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
});
