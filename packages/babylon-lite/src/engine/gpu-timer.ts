// engine/gpu-timer.ts — optional GPU frame-time measurement.
//
// Measures how long the GPU spends on a frame using a WebGPU `timestamp-query`. The opening and closing
// timestamps are written *into the frame's own command encoder* (`gpuFrameTimerBegin` as the first
// command, `gpuFrameTimerEnd` as the last), so the GPU runs them contiguously around exactly that frame's
// passes — measuring the frame's GPU work, not the CPU time spent recording it. After the frame is
// submitted, `gpuFrameTimerResolve` copies the pair into a mapped readback buffer ASYNCHRONOUSLY — off the
// render critical path — so the measurement barely perturbs the number it reports (no pipeline stall, no
// per-draw cost).
//
// Entirely opt-in: the timer is only created on first enable, its per-frame hooks are installed only while
// timing is on (so nothing is written while disabled), and the whole feature degrades to a no-op on
// adapters lacking the `timestamp-query` feature (or the `GPUCommandEncoder.writeTimestamp` method).
// renderFrame ships only three optional-chain short-circuits. Pure state + free functions (no methods, no
// import side effects) per the engine's data-oriented style.

/** Minimal structural type for the `writeTimestamp` method (not in every \@webgpu/types version). */
type TimestampWriter = { writeTimestamp(querySet: GPUQuerySet, queryIndex: number): void };

export interface GpuFrameTimer {
    readonly device: GPUDevice;
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

/** Whether a device can measure GPU time (has `timestamp-query` and the encoder write method). */
export function gpuTimingSupportedFor(device: GPUDevice): boolean {
    return device.features.has("timestamp-query") && typeof (GPUCommandEncoder.prototype as Partial<TimestampWriter>).writeTimestamp === "function";
}

/** Create a GPU frame timer, or null when the device can't support timestamp queries. */
export function createGpuFrameTimer(device: GPUDevice): GpuFrameTimer | null {
    if (!gpuTimingSupportedFor(device)) {
        return null;
    }
    const querySet = device.createQuerySet({ type: "timestamp", count: 2 });
    const resolveBuf = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    return { device, querySet, resolveBuf, pool: [], lastMs: 0, inFlight: 0 };
}

/** Write the frame's opening timestamp into the frame encoder (call right after it is created, before any
 *  passes are recorded), so it is the first command the GPU runs for this frame. */
export function gpuFrameTimerBegin(timer: GpuFrameTimer, encoder: GPUCommandEncoder): void {
    (encoder as unknown as TimestampWriter).writeTimestamp(timer.querySet, 0);
}

/** Write the frame's closing timestamp into the frame encoder (call right before it is finished/submitted),
 *  so it is the last command — bracketing exactly this frame's recorded GPU work. */
export function gpuFrameTimerEnd(timer: GpuFrameTimer, encoder: GPUCommandEncoder): void {
    (encoder as unknown as TimestampWriter).writeTimestamp(timer.querySet, 1);
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
