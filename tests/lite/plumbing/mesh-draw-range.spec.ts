import { expect, test } from "@playwright/test";
import type { MeshDrawRange } from "../../../packages/babylon-lite/src/index";
import type { MeshDrawRangeTest } from "../../../lab/lite/src/mesh-draw-range-test";

interface DrawTrace {
    draws: number[][];
    geometryAllocations: number;
    uploads: number;
    indexBuffers: number[];
    errors: string[];
}

declare global {
    interface Window {
        drawRangeTrace: DrawTrace;
        meshDrawRangeTest: MeshDrawRangeTest;
        waitForDrawRangeGpu(): Promise<void>;
    }
}

for (const material of ["shader", "standard", "pbr"] as const) {
    test(`exact ranges reach native WebGPU submissions without geometry uploads or replacement (${material})`, async ({ page }) => {
        await page.addInitScript(() => {
            const trace: DrawTrace = { draws: [], geometryAllocations: 0, uploads: 0, indexBuffers: [], errors: [] };
            window.drawRangeTrace = trace;
            const buffers = new WeakMap<GPUBuffer, number>();
            const encoders = new WeakMap<GPURenderBundleEncoder, number[][]>();
            const bundles = new WeakMap<GPURenderBundle, number[][]>();
            const devices = new WeakSet<GPUDevice>();
            let nextBuffer = 0;
            const createBuffer = GPUDevice.prototype.createBuffer;
            GPUDevice.prototype.createBuffer = function (descriptor) {
                if (!devices.has(this)) {
                    devices.add(this);
                    this.addEventListener("uncapturederror", (event) => trace.errors.push(event.error.message));
                    window.waitForDrawRangeGpu = () => this.queue.onSubmittedWorkDone();
                }
                const buffer = createBuffer.call(this, descriptor);
                buffers.set(buffer, ++nextBuffer);
                if (descriptor.usage & (GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX)) {
                    trace.geometryAllocations++;
                }
                return buffer;
            };
            const writeBuffer = GPUQueue.prototype.writeBuffer;
            GPUQueue.prototype.writeBuffer = function (...args) {
                trace.uploads++;
                Reflect.apply(writeBuffer, this, args);
            };
            const bundleDraw = GPURenderBundleEncoder.prototype.drawIndexed;
            GPURenderBundleEncoder.prototype.drawIndexed = function (count, instances = 1, firstIndex = 0, baseVertex = 0, firstInstance = 0) {
                let draws = encoders.get(this);
                if (!draws) {
                    draws = [];
                    encoders.set(this, draws);
                }
                draws.push([count, instances, firstIndex, baseVertex, firstInstance]);
                bundleDraw.call(this, count, instances, firstIndex, baseVertex, firstInstance);
            };
            const finish = GPURenderBundleEncoder.prototype.finish;
            GPURenderBundleEncoder.prototype.finish = function (descriptor) {
                const bundle = finish.call(this, descriptor);
                bundles.set(bundle, encoders.get(this) ?? []);
                return bundle;
            };
            const executeBundles = GPURenderPassEncoder.prototype.executeBundles;
            GPURenderPassEncoder.prototype.executeBundles = function (values) {
                const snapshot = Array.from(values);
                for (const bundle of snapshot) {
                    trace.draws.push(...(bundles.get(bundle) ?? []));
                }
                executeBundles.call(this, snapshot);
            };
            const directDraw = GPURenderPassEncoder.prototype.drawIndexed;
            GPURenderPassEncoder.prototype.drawIndexed = function (count, instances = 1, firstIndex = 0, baseVertex = 0, firstInstance = 0) {
                trace.draws.push([count, instances, firstIndex, baseVertex, firstInstance]);
                directDraw.call(this, count, instances, firstIndex, baseVertex, firstInstance);
            };
            for (const prototype of [GPURenderBundleEncoder.prototype, GPURenderPassEncoder.prototype]) {
                const setIndexBuffer = prototype.setIndexBuffer;
                prototype.setIndexBuffer = function (buffer, format, offset, size) {
                    trace.indexBuffers.push(buffers.get(buffer)!);
                    setIndexBuffer.call(this, buffer, format, offset, size);
                };
            }
        });
        await page.goto(`/lite/mesh-draw-range-test.html?material=${material}`);
        await expect(page.locator("canvas")).toHaveAttribute("data-ready", "true");
        const initial = await page.evaluate(async () => {
            await window.waitForDrawRangeGpu();
            return window.drawRangeTrace;
        });
        expect(initial.draws).toEqual([[6, 1, 0, 0, 0]]);
        const cardIndexBuffer = initial.indexBuffers[0];
        expect(cardIndexBuffer).toBeGreaterThan(0);

        const select = async (kind: "card" | "points", range: MeshDrawRange, expected: number[]) => {
            const result = await page.evaluate(
                async ({ kind, range }) => {
                    const trace = window.drawRangeTrace;
                    const before = trace.uploads;
                    window.meshDrawRangeTest.select(kind, range);
                    const selectionUploads = trace.uploads - before;
                    trace.draws = [];
                    trace.indexBuffers = [];
                    window.meshDrawRangeTest.render();
                    await window.waitForDrawRangeGpu();
                    const geometry = window.meshDrawRangeTest.geometry()!;
                    return { ...trace, selectionUploads, vertexCount: geometry.positions.length / 3, indexCount: geometry.indices.length };
                },
                { kind, range }
            );
            expect(result.draws).toEqual([expected]);
            expect(result.vertexCount).toBe(range.vertices.count);
            expect(result.indexCount).toBe(range.indices.count);
            expect(result.selectionUploads).toBe(0);
            expect(result.geometryAllocations).toBe(initial.geometryAllocations);
            if (kind === "card") {
                expect(result.indexBuffers.every((id) => id === cardIndexBuffer)).toBe(true);
            }
            expect(result.errors).toEqual([]);
        };
        await select("card", { vertices: { offset: 0, count: 3 }, indices: { offset: 0, count: 3 } }, [3, 1, 0, 0, 0]);
        for (const capacity of [false, true]) {
            const restored = await page.evaluate(async (capacity) => {
                window.meshDrawRangeTest.restoreCard(capacity);
                window.drawRangeTrace.draws = [];
                window.meshDrawRangeTest.render();
                await window.waitForDrawRangeGpu();
                return window.drawRangeTrace;
            }, capacity);
            expect(restored.draws).toEqual([[6, 1, 0, 0, 0]]);
            expect(restored.geometryAllocations).toBe(initial.geometryAllocations);
            expect(restored.errors).toEqual([]);
            await select("card", { vertices: { offset: 0, count: 3 }, indices: { offset: 0, count: 3 } }, [3, 1, 0, 0, 0]);
        }
        await select("card", { vertices: { offset: 0, count: 4 }, indices: { offset: 0, count: 6 } }, [6, 1, 0, 0, 0]);
        await select("card", { vertices: { offset: 1, count: 3 }, indices: { offset: 0, count: 3 } }, [3, 1, 0, 1, 0]);
        await select("card", { vertices: { offset: 0, count: 4 }, indices: { offset: 3, count: 3 } }, [3, 1, 3, 0, 0]);
        await select("card", { vertices: { offset: 0, count: 0 }, indices: { offset: 0, count: 0 } }, [0, 1, 0, 0, 0]);
        await select("points", { vertices: { offset: 0, count: 5 }, indices: { offset: 0, count: 5 } }, [5, 1, 0, 0, 0]);
        await select("points", { vertices: { offset: 1, count: 3 }, indices: { offset: 0, count: 3 } }, [3, 1, 0, 1, 0]);
        await page.evaluate(async () => {
            window.drawRangeTrace.draws = [];
            window.meshDrawRangeTest.render();
            await window.waitForDrawRangeGpu();
        });
        expect(await page.evaluate(() => window.drawRangeTrace.draws)).toEqual([[3, 1, 0, 1, 0]]);
        await page.evaluate(() => window.meshDrawRangeTest.dispose());
    });
}
