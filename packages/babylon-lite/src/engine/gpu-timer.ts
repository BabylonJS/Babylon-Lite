// engine/gpu-timer.ts — optional GPU frame-time measurement.
//
// Two compute marker passes bracket the commands recorded for a frame. Each marker
// dispatches one workgroup with an empty shader body and carries a timestamp write.
// Empty passes produced zero or repeated timestamps in the measured render fixtures;
// recording a dispatch avoids relying on an otherwise empty pass. The markers add
// GPU work, so the interval includes their overhead. Query resolution and readback
// remain asynchronous. The timer owns one pipeline, created only when enabled.
// Use standard timestampWrites pass attachments; do not depend on the legacy
// GPUCommandEncoder.writeTimestamp or Chromium's --enable-unsafe-webgpu flag.
// Pure state + free functions; no work executes at module import.

export interface GpuFrameTimer {
    readonly device: GPUDevice;
    /** Pipeline used by the opening and closing marker dispatches. */
    readonly markerPipeline: GPUComputePipeline;
    /** Two slots: [frame begin, frame end]. */
    readonly querySet: GPUQuerySet;
    /** Destination for `resolveQuerySet` (2 × u64 = 16 bytes). */
    readonly resolveBuf: GPUBuffer;
    /** Idle MAP_READ buffers, recycled across frames so we never allocate in steady state. */
    readonly pool: GPUBuffer[];
    /** Last GPU frame time read back, in ms (0 until the first readback lands). Lightly smoothed. */
    lastMs: number;
    /** In-flight async readbacks, capped so a GPU stall can't spin up unbounded buffers. */
    inFlight: number;
}

/** Whether a device can measure GPU time — it offered the `timestamp-query` feature (which also enables the
 *  standard `timestampWrites` pass attachments this timer uses; no `--enable-unsafe-webgpu` flag required). */
export function gpuTimingSupportedFor(device: GPUDevice): boolean {
    return device.features.has("timestamp-query");
}

/** Create a GPU frame timer, or null when the device can't support timestamp queries. */
export function createGpuFrameTimer(device: GPUDevice): GpuFrameTimer | null {
    if (!gpuTimingSupportedFor(device)) {
        return null;
    }
    const markerPipeline = device.createComputePipeline({
        layout: "auto",
        compute: {
            module: device.createShaderModule({ code: "@compute @workgroup_size(1) fn main() {}" }),
            entryPoint: "main",
        },
    });
    const querySet = device.createQuerySet({ type: "timestamp", count: 2 });
    const resolveBuf = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    return { device, markerPipeline, querySet, resolveBuf, pool: [], lastMs: 0, inFlight: 0 };
}

/** Record the opening marker before the frame's passes. */
export function gpuFrameTimerBegin(timer: GpuFrameTimer, encoder: GPUCommandEncoder): void {
    const pass = encoder.beginComputePass({ timestampWrites: { querySet: timer.querySet, beginningOfPassWriteIndex: 0 } });
    pass.setPipeline(timer.markerPipeline);
    pass.dispatchWorkgroups(1);
    pass.end();
}

/** Record the closing marker after the frame's passes, before finish/submit. */
export function gpuFrameTimerEnd(timer: GpuFrameTimer, encoder: GPUCommandEncoder): void {
    const pass = encoder.beginComputePass({ timestampWrites: { querySet: timer.querySet, endOfPassWriteIndex: 1 } });
    pass.setPipeline(timer.markerPipeline);
    pass.dispatchWorkgroups(1);
    pass.end();
}

/** Resolve the just-submitted timestamp pair and update `lastMs` when the readback maps. Submitted as its
 *  own tiny command buffer AFTER the frame's submit, so the bracketing timestamps are already written; the
 *  recycled MAP_READ buffer is mapped asynchronously, so reading never stalls the frame. */
export function gpuFrameTimerResolve(timer: GpuFrameTimer): void {
    if (timer.inFlight > 3) {
        return; // GPU/readback is lagging — skip this sample rather than allocate more buffers
    }
    const dev = timer.device;
    const rb = timer.pool.pop() ?? dev.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = dev.createCommandEncoder();
    enc.resolveQuerySet(timer.querySet, 0, 2, timer.resolveBuf, 0);
    enc.copyBufferToBuffer(timer.resolveBuf, 0, rb, 0, 16);
    dev.queue.submit([enc.finish()]);
    timer.inFlight++;
    rb.mapAsync(GPUMapMode.READ).then(
        () => {
            const a = new BigInt64Array(rb.getMappedRange());
            const ms = Number(a[1]! - a[0]!) / 1e6;
            // Guard against counter wrap / garbage (a real frame is never multiple seconds; a wrapped
            // u64 delta is wildly larger or negative), then smooth lightly so the readout is steady.
            if (ms >= 0 && ms < 5000) {
                timer.lastMs = timer.lastMs > 0 ? timer.lastMs * 0.8 + ms * 0.2 : ms;
            }
            rb.unmap();
            timer.pool.push(rb);
            timer.inFlight--;
        },
        () => {
            // Device lost / buffer destroyed — drop this readback (don't recycle a bad buffer).
            timer.inFlight--;
        }
    );
}

/** Release the timer's GPU resources. */
export function destroyGpuFrameTimer(timer: GpuFrameTimer): void {
    timer.querySet.destroy();
    timer.resolveBuf.destroy();
    for (const b of timer.pool) {
        b.destroy();
    }
    timer.pool.length = 0;
}
