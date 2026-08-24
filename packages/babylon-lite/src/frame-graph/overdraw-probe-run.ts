/**
 * OverdrawProbe — on-demand measurement of what overdraw COSTS a render task,
 * in GPU milliseconds, using timestamp queries around two replay passes.
 *
 * How: the probe re-renders the task's current `DrawBinding` lists — same
 * pipelines, same scene bind group, same draw order, same viewport — into a
 * transient target whose formats/sample count match the task's signature.
 * Twice per repeat:
 *
 *   Pass A (as shipped): fresh cleared depth. Fragments shade exactly as the
 *     real pass shades them, overdraw included.
 *   Pass B (visible only): the SAME draws against pass A's final depth buffer
 *     (depth loadOp "load"). With the target's ordinary depth compare, only
 *     the surviving front-most fragments pass, so B shades each covered
 *     sample once — the floor a perfect depth prepass would reach.
 *   Pass C (front-to-back): fresh cleared depth again, the non-transparent
 *     draws reordered nearest-first (same view-space-z convention as the
 *     task's transparent sort, from `_worldCenter` or the mesh's world
 *     translation; transparents keep their shipped order at the end). This is
 *     what a per-DRAW sort could achieve — instances *within* one draw cannot
 *     be reordered by it, which is exactly the gap between C and B.
 *
 * `overdrawMs = time(A) − time(B)` is therefore the shading time the task
 * currently spends on fragments that later lose the depth test — the exact
 * upper bound on what a depth prepass or front-to-back reordering could save.
 * (A real prepass also PAYS a geometry-only pass; that cost is not modelled
 * here, so treat `overdrawMs` as the budget such a pass must beat.)
 * `sortGainMs = time(A) − time(C)` is the slice of that budget a plain draw
 * sort would collect — free of any extra pass, minus whatever GPU-side cost
 * its extra pipeline switches add (included in C's time; the CPU sort itself
 * is not modelled).
 *
 * Why timestamps and not occlusion queries: WebGPU occlusion queries are only
 * guaranteed zero/non-zero, and D3D12 backends do return binary results, so
 * shaded-sample COUNTS cannot be measured portably. Time can.
 *
 * Contract and limits:
 *   - Requires the device's `timestamp-query` feature (`deviceCanTime`-style
 *     check inside; throws when absent).
 *   - Diagnostic-grade: allocates transient GPU resources per call and waits
 *     for a readback. Never call it per frame in production rendering.
 *   - Measures the LAST-RENDERED state of the task (bindings' `update()` is
 *     not re-run); call it after the scene has rendered at least once.
 *   - Transparent bindings are included (they shade in the real pass too);
 *     invisible meshes are skipped, mirroring the task's own draw loop.
 *   - Each repeat alternates A/B in one submission; the reported numbers are
 *     medians over `repeats` (default 9) to ride out clock noise.
 *
 * Fully tree-shakable: type-only imports, no module state, no side effects.
 */

import type { Camera } from "../camera/camera.js";
import { getViewMatrix } from "../camera/camera.js";
import type { EngineContext } from "../engine/engine.js";
import type { DrawBinding } from "../render/renderable.js";
import type { RenderTask } from "./render-task.js";

/** Result of one overdraw-cost measurement. */
export interface OverdrawCostMeasure {
    /** Probe target size in pixels (the task target's size). */
    width: number;
    height: number;
    /** MSAA sample count the task renders with. */
    sampleCount: number;
    /** Bindings replayed (visible opaque + direct + transparent). */
    bindings: number;
    /** Median GPU ms of the as-shipped replay (fresh depth — overdraw included). */
    msAsIs: number;
    /** Median GPU ms of the visible-only replay (pre-resolved depth — the perfect-prepass floor). */
    msVisibleOnly: number;
    /** msAsIs − msVisibleOnly: GPU ms currently spent shading fragments that lose the depth test. */
    overdrawMs: number;
    /** msAsIs / msVisibleOnly — 1.0 means no overdraw cost at all. */
    ratio: number;
    /** Median GPU ms of the front-to-back-sorted replay (per-draw sort, transparents untouched). */
    msFrontToBack: number;
    /** msAsIs − msFrontToBack: what a plain draw sort would collect of the overdraw budget. */
    sortGainMs: number;
    /** Number of repeats the medians are taken over. */
    repeats: number;
}

/**
 * Measure the GPU cost of `task`'s overdraw. The task must have rendered at
 * least once (bindings and scene bind group built). `repeats` defaults to 9.
 */
export async function _measureRenderTaskOverdrawCost(engine: EngineContext, task: RenderTask, options?: { repeats?: number }): Promise<OverdrawCostMeasure> {
    const device = engine._device;
    if (!device.features.has("timestamp-query")) {
        throw new Error("overdraw probe: this device has no timestamp-query feature");
    }
    const repeats = options?.repeats ?? 9;
    if (!Number.isInteger(repeats) || repeats < 1) {
        throw new RangeError("overdraw probe: repeats must be a positive integer");
    }
    const rt = task._config.rt;
    const depthTarget = task._config.depth ?? rt;
    const loadsExistingDepth = task._config.depth ? task._config.depth._eager === true : task._config.depthClear === false;
    if (loadsExistingDepth) {
        throw new Error("overdraw probe: tasks that load existing depth cannot be measured with a fresh-depth replay");
    }
    const width = rt._width;
    const height = rt._height;
    if (!width || !height) {
        throw new Error("overdraw probe: task render target has no size (has the task rendered yet?)");
    }
    const colorFormat = rt._descriptor.format ?? task._targetSignature._colorFormat;
    const depthFormat = task._targetSignature._depthStencilFormat;
    const sampleCount = rt._descriptor.samples ?? task._targetSignature._sampleCount ?? 1;
    if (!colorFormat || !depthFormat?.startsWith("depth")) {
        throw new Error("overdraw probe: task target has no color+depth signature to replicate");
    }

    const bindings: DrawBinding[] = [];
    const transparentStart = { index: 0 };
    for (const list of [task._opaqueBindings, task._directBindings, task._transparentBindings]) {
        for (const b of list) {
            const mesh = b.renderable.mesh;
            if (mesh && mesh.visible === false) {
                continue;
            }
            bindings.push(b);
        }
        if (list !== task._transparentBindings) {
            transparentStart.index = bindings.length;
        }
    }
    if (bindings.length === 0) {
        throw new Error("overdraw probe: task has no draw bindings (has the task rendered yet?)");
    }

    // Front-to-back variant: non-transparent draws sorted nearest-first with the same view-space-z
    // convention as the task's transparent sort; a binding without a world center falls back to its
    // mesh's world translation, else keeps relative order (stable sort). Transparents stay last, in
    // their shipped order — reordering them would not model a shippable sort.
    const camera = task._config.cam ?? (task.scene as { camera?: Camera | null }).camera ?? null;
    const sortedBindings = ((): DrawBinding[] => {
        const front = bindings.slice(0, transparentStart.index);
        if (!camera || front.length <= 1) {
            return bindings;
        }
        const v = getViewMatrix(camera);
        const depthOf = (b: DrawBinding): number => {
            const wc =
                b.renderable._worldCenter ??
                ((): [number, number, number] | null => {
                    const m = b.renderable.mesh?.worldMatrix;
                    return m ? [m[12]!, m[13]!, m[14]!] : null;
                })();
            return wc ? wc[0]! * v[2]! + wc[1]! * v[6]! + wc[2]! * v[10]! + v[14]! : 0;
        };
        const keyed = front.map((b) => ({ b, z: depthOf(b) }));
        keyed.sort((a, b) => a.z - b.z);
        return [...keyed.map((k) => k.b), ...bindings.slice(transparentStart.index)];
    })();

    const colorTex = device.createTexture({
        label: "overdraw-probe-color",
        size: { width, height },
        format: colorFormat,
        sampleCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const depthTex = device.createTexture({
        label: "overdraw-probe-depth",
        size: { width, height },
        format: depthFormat,
        sampleCount,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const hasStencil = depthFormat === "depth24plus-stencil8" || depthFormat === "depth32float-stencil8";
    const depthClearValue = depthTarget._descriptor._depthClearValue ?? 0;

    // 6 timestamps per repeat: A, B, and C begin/end pairs.
    const querySet = device.createQuerySet({ type: "timestamp", count: repeats * 6 });
    const resolveBuffer = device.createBuffer({
        label: "overdraw-probe-resolve",
        size: repeats * 6 * 8,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    const readBuffer = device.createBuffer({
        label: "overdraw-probe-read",
        size: repeats * 6 * 8,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const drawAll = (pass: GPURenderPassEncoder, list: readonly DrawBinding[]): void => {
        const v = (camera as { viewport?: { x: number; y: number; width: number; height: number } } | null)?.viewport;
        if (v) {
            const x = Math.floor(v.x * width);
            const y = Math.floor((1 - v.y - v.height) * height);
            const w = Math.ceil((v.x + v.width) * width) - x;
            const h = Math.ceil((1 - v.y) * height) - y;
            pass.setViewport(x, y, w, h, 0, 1);
            pass.setScissorRect(x, y, w, h);
        }
        pass.setBindGroup(0, task._sceneBG);
        let lastPipeline: GPURenderPipeline | null = null;
        for (const b of list) {
            if (b.pipeline !== lastPipeline) {
                pass.setPipeline(b.pipeline);
                lastPipeline = b.pipeline;
            }
            b.draw(pass, engine);
        }
    };

    try {
        const colorView = colorTex.createView();
        const depthView = depthTex.createView();
        for (let r = 0; r < repeats; r++) {
            const encoder = device.createCommandEncoder({ label: "overdraw-probe" });
            const clearDepth = {
                view: depthView,
                depthClearValue,
                depthLoadOp: "clear" as const,
                depthStoreOp: "store" as const,
                ...(hasStencil ? { stencilClearValue: 0, stencilLoadOp: "clear" as const, stencilStoreOp: "store" as const } : {}),
            };
            const colorAttachment = { view: colorView, loadOp: "clear" as const, storeOp: "discard" as const, clearValue: { r: 0, g: 0, b: 0, a: 0 } };
            // Pass A — as shipped: cleared depth, stored for pass B to load.
            const passA = encoder.beginRenderPass({
                label: "overdraw-probe-a",
                colorAttachments: [colorAttachment],
                depthStencilAttachment: clearDepth,
                timestampWrites: { querySet, beginningOfPassWriteIndex: r * 6, endOfPassWriteIndex: r * 6 + 1 },
            });
            drawAll(passA, bindings);
            passA.end();
            // Pass B — visible only: A's final depth pre-loaded, so only surviving fragments shade.
            const passB = encoder.beginRenderPass({
                label: "overdraw-probe-b",
                colorAttachments: [colorAttachment],
                depthStencilAttachment: {
                    view: depthView,
                    depthLoadOp: "load",
                    depthStoreOp: "discard",
                    ...(hasStencil ? { stencilLoadOp: "load" as const, stencilStoreOp: "discard" as const } : {}),
                },
                timestampWrites: { querySet, beginningOfPassWriteIndex: r * 6 + 2, endOfPassWriteIndex: r * 6 + 3 },
            });
            drawAll(passB, bindings);
            passB.end();
            // Pass C — per-draw front-to-back order, fresh depth again.
            const passC = encoder.beginRenderPass({
                label: "overdraw-probe-c",
                colorAttachments: [colorAttachment],
                depthStencilAttachment: { ...clearDepth, depthStoreOp: "discard", ...(hasStencil ? { stencilStoreOp: "discard" as const } : {}) },
                timestampWrites: { querySet, beginningOfPassWriteIndex: r * 6 + 4, endOfPassWriteIndex: r * 6 + 5 },
            });
            drawAll(passC, sortedBindings);
            passC.end();
            if (r === repeats - 1) {
                encoder.resolveQuerySet(querySet, 0, repeats * 6, resolveBuffer, 0);
                encoder.copyBufferToBuffer(resolveBuffer, 0, readBuffer, 0, repeats * 6 * 8);
            }
            device.queue.submit([encoder.finish()]);
        }

        await readBuffer.mapAsync(GPUMapMode.READ);
        const ts = new BigUint64Array(readBuffer.getMappedRange());
        const msA: number[] = [];
        const msB: number[] = [];
        const msC: number[] = [];
        for (let r = 0; r < repeats; r++) {
            const a = Number(ts[r * 6 + 1]! - ts[r * 6]!) / 1e6;
            const b = Number(ts[r * 6 + 3]! - ts[r * 6 + 2]!) / 1e6;
            const c = Number(ts[r * 6 + 5]! - ts[r * 6 + 4]!) / 1e6;
            if (a > 0 && a < 1e3) {
                msA.push(a);
            }
            if (b > 0 && b < 1e3) {
                msB.push(b);
            }
            if (c > 0 && c < 1e3) {
                msC.push(c);
            }
        }
        readBuffer.unmap();
        if (!msA.length || !msB.length || !msC.length) {
            throw new Error("overdraw probe: timestamp readback produced no usable samples");
        }
        const median = (arr: number[]): number => {
            const s = arr.slice().sort((x, y) => x - y);
            return s[s.length >> 1]!;
        };
        const msAsIs = +median(msA).toFixed(3);
        const msVisibleOnly = +median(msB).toFixed(3);
        const msFrontToBack = +median(msC).toFixed(3);
        return {
            width,
            height,
            sampleCount,
            bindings: bindings.length,
            msAsIs,
            msVisibleOnly,
            overdrawMs: +(msAsIs - msVisibleOnly).toFixed(3),
            ratio: msVisibleOnly > 0 ? +(msAsIs / msVisibleOnly).toFixed(3) : 0,
            msFrontToBack,
            sortGainMs: +(msAsIs - msFrontToBack).toFixed(3),
            repeats,
        };
    } finally {
        querySet.destroy();
        resolveBuffer.destroy();
        readBuffer.destroy();
        colorTex.destroy();
        depthTex.destroy();
    }
}
