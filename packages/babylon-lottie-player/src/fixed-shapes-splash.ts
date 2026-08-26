// Auto-starting classic-script client for a fixed-layout, shapes-only splash animation.
//
// Contract:
// - This file is built as an IIFE and loaded through an external classic <script>.
// - A canvas with id="l" already exists, has fixed nonzero CSS dimensions, and names a
//   same-directory animation URL through data-a.
// - worker.min.js is beside the client and contains the matching shapes worker.
// - The host has already gated execution on OffscreenCanvas support, keeps an independent fallback,
//   and later terminates the Worker stored on canvas._w.

type LoadMessage = import("./worker/protocol.js").LoadMessage;
type StartMessage = import("./worker/protocol.js").StartMessage;
type WorkerOutbound = import("./worker/protocol.js").WorkerOutbound;

const resourceBase = (document.currentScript as HTMLScriptElement).src.replace(/[^/]+$/, "");
const canvas = document.getElementById("l") as HTMLCanvasElement;
const workerUrl = `${resourceBase}worker.min.js`;
const workerBootstrapUrl = URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(workerUrl)})`]));
const worker = new Worker(workerBootstrapUrl);

URL.revokeObjectURL(workerBootstrapUrl);

worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
    if (event.data.type === "size") {
        const offscreen = canvas.transferControlToOffscreen();
        const start: StartMessage = {
            type: "start",
            canvas: offscreen,
            displayWidth: canvas.clientWidth,
            displayHeight: canvas.clientHeight,
            devicePixelRatio,
            loop: true,
        };
        worker.postMessage(start, [offscreen]);
    }
};

const load: LoadMessage = { type: "load", url: `${resourceBase}${canvas.dataset.a}` };
worker.postMessage(load);

(canvas as HTMLCanvasElement & { _w: Worker })._w = worker;
