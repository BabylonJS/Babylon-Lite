import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

const gpuModuleUrl = `/@fs/${resolve(__dirname, "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-gpu.ts").replaceAll("\\", "/")}`;
const materialModuleUrl = `/@fs/${resolve(__dirname, "../../../packages/babylon-lite/src/loader-splat-stream/splat-stream-material.ts").replaceAll("\\", "/")}`;
const retirementModuleUrl = `/@fs/${resolve(__dirname, "../../../packages/babylon-lite/src/engine/gpu-resource-retirement.ts").replaceAll("\\", "/")}`;

test.beforeEach(async ({ page }) => {
    await page.goto("/");
});

test("compiles shaders and gathers canonical SOG records without clamping color", async ({ page }) => {
    const result = await page.evaluate(async (moduleUrl) => {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            return null;
        }

        const device = await adapter.requestDevice();
        device.pushErrorScope("validation");
        const gpu = await import(moduleUrl);
        const encoder = device.createCommandEncoder();
        const engine = { _device: device, _currentEncoder: encoder };
        const scale = new Float32Array(256);
        scale[2] = Math.log(1);
        scale[3] = Math.log(2);
        scale[4] = Math.log(3);
        const sh0 = new Float32Array(256);
        sh0[0] = -1.5 / 0.28209479177387814;
        sh0[1] = 1.5 / 0.28209479177387814;
        const metadata = {
            count: 4,
            meansMin: new Float32Array([0, 0, -Math.log(2)]),
            meansMax: new Float32Array([0, 0, -Math.log(2)]),
            scaleCodebook: scale,
            sh0Codebook: sh0,
            imageUrls: ["", "", "", "", ""],
        };
        const images = Array.from({ length: 5 }, () => new Uint8Array(16));
        for (let index = 0; index < 4; index++) {
            images[2]![index * 4] = 2;
            images[2]![index * 4 + 1] = 3;
            images[2]![index * 4 + 2] = 4;
            images[3]![index * 4] = 128;
            images[3]![index * 4 + 1] = 128;
            images[3]![index * 4 + 2] = 128;
            images[3]![index * 4 + 3] = 252 + index;
            images[4]![index * 4] = index & 1;
            images[4]![index * 4 + 1] = (index + 1) & 1;
            images[4]![index * 4 + 2] = index & 1;
            images[4]![index * 4 + 3] = 64 + index;
        }
        const source = gpu.uploadSplatStreamSourceBytes(device, metadata, 2, 2, images);
        const state = gpu.createSplatStreamGpuState(engine, 4, 1024 * 1024);
        gpu.setSplatStreamGpuIntervals(state, [{ source, sourceOffset: 0, count: 4, destinationOffset: 0 }], 1);
        const signature = { _sampleCount: 1 };
        const batch = gpu.createSplatStreamDrawBatch(state, signature);
        const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        batch.reset();
        batch.queue({
            count: 4,
            key: "first",
            worldView: identity,
            projection: identity,
            width: 64,
            height: 64,
            near: 0.01,
        });

        batch.flush(engine);
        const canonicalRead = device.createBuffer({ size: 4 * 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const indirectRead = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        encoder.copyBufferToBuffer(state.canonical, 0, canonicalRead, 0, 4 * 64);
        encoder.copyBufferToBuffer(batch.passGpu.indirect, 0, indirectRead, 0, 16);
        device.queue.submit([encoder.finish()]);
        await Promise.all([canonicalRead.mapAsync(GPUMapMode.READ), indirectRead.mapAsync(GPUMapMode.READ)]);
        const records = Array.from(new Float32Array(canonicalRead.getMappedRange().slice(0)));
        const indirect = Array.from(new Uint32Array(indirectRead.getMappedRange().slice(0)));
        const error = await device.popErrorScope();
        return { records, indirect, error: error?.message };
    }, gpuModuleUrl);
    test.skip(result === null, "A WebGPU adapter is unavailable");
    expect(result!.error).toBeUndefined();
    expect(result!.indirect).toEqual([6, 4, 0, 0]);
    const covariance = (selector: number): number[] => {
        const a = (128 / 255 - 0.5) * Math.SQRT2;
        const d = Math.sqrt(Math.max(0, 1 - 3 * a * a));
        const quaternions = [
            [a, a, a, d],
            [d, a, a, a],
            [a, d, a, a],
            [a, a, d, a],
        ];
        const q = quaternions[selector]!;
        const x = q[0]!;
        const y = q[1]!;
        const z = q[2]!;
        const w = q[3]!;
        const rotation = [
            [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * z * w, 2 * x * z + 2 * y * w],
            [2 * x * y + 2 * z * w, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * x * w],
            [2 * x * z - 2 * y * w, 2 * y * z + 2 * x * w, 1 - 2 * x * x - 2 * y * y],
        ];
        const scales = [2, 4, 6];
        const m = rotation.map((row) => row.map((value, axis) => value * scales[axis]!));
        const c = m.map((row, i) => m.map((other, j) => row.reduce((sum, value, axis) => sum + value * other[axis]!, 0) * (i === 2 ? -1 : 1) * (j === 2 ? -1 : 1)));
        return [c[0]![0]!, c[0]![1]!, c[0]![2]!, c[1]![1]!, c[1]![2]!, c[2]![2]!];
    };
    for (let index = 0; index < 4; index++) {
        const record = result!.records.slice(index * 16, index * 16 + 16);
        expect(record[2]).toBeCloseTo(1, 5);
        expect(record[3]).toBeCloseTo((64 + index) / 255, 6);
        const expectedCovariance = covariance(index);
        [record[4], record[5], record[6], record[7], record[8], record[9]].forEach((value, component) => {
            expect(value).toBeCloseTo(expectedCovariance[component]!, 4);
        });
        expect(record[12]).toBeCloseTo(index % 2 ? 2 : -1, 5);
        expect(record[13]).toBeCloseTo(index % 2 ? -1 : 2, 5);
    }
});

test("uploads byte-preserving external images into gather source textures", async ({ page }) => {
    const result = await page.evaluate(
        async ({ moduleUrl, retirementUrl }) => {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                return null;
            }
            const device = await adapter.requestDevice();
            device.pushErrorScope("validation");
            const gpu = await import(moduleUrl);
            const retirement = await import(retirementUrl);
            const engine = { _device: device, _currentEncoder: device.createCommandEncoder() };
            const scale = new Float32Array(256);
            const sh0 = new Float32Array(256);
            const metadata = {
                count: 1,
                meansMin: new Float32Array([0, 0, -Math.log(2)]),
                meansMax: new Float32Array([0, 0, -Math.log(2)]),
                scaleCodebook: scale,
                sh0Codebook: sh0,
                imageUrls: ["", "", "", "", ""],
            };
            const bytes = [
                [0, 0, 0, 17],
                [0, 0, 0, 29],
                [0, 0, 0, 43],
                [128, 128, 128, 252],
                [0, 0, 0, 128],
            ];
            const images = await Promise.all(
                bytes.map((value) =>
                    createImageBitmap(new ImageData(new Uint8ClampedArray(value), 1, 1), {
                        premultiplyAlpha: "none",
                        colorSpaceConversion: "none",
                        imageOrientation: "none",
                    })
                )
            );
            const source = gpu.uploadSplatStreamSourceImages(device, metadata, 1, 1, images);
            images.forEach((image) => image.close());
            const state = gpu.createSplatStreamGpuState(engine, 1, 1024 * 1024);
            gpu.setSplatStreamGpuIntervals(state, [{ source, sourceOffset: 0, count: 1, destinationOffset: 0 }], 1);
            const batch = gpu.createSplatStreamDrawBatch(state, { _sampleCount: 1 });
            const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
            batch.queue({ count: 1, key: "external-image", worldView: identity, projection: identity, width: 64, height: 64, near: 0.01 });
            batch.flush(engine);
            const canonicalRead = device.createBuffer({ size: 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            const indirectRead = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            engine._currentEncoder.copyBufferToBuffer(state.canonical, 0, canonicalRead, 0, 64);
            engine._currentEncoder.copyBufferToBuffer(batch.passGpu.indirect, 0, indirectRead, 0, 16);
            device.queue.submit([engine._currentEncoder.finish()]);
            retirement.flushGpuResourceRetirements(engine);
            await Promise.all([canonicalRead.mapAsync(GPUMapMode.READ), indirectRead.mapAsync(GPUMapMode.READ)]);
            const record = Array.from(new Float32Array(canonicalRead.getMappedRange().slice(0)));
            const indirect = Array.from(new Uint32Array(indirectRead.getMappedRange().slice(0)));
            const error = await device.popErrorScope();
            return { record, indirect, error: error?.message };
        },
        { moduleUrl: gpuModuleUrl, retirementUrl: retirementModuleUrl }
    );
    test.skip(result === null, "A WebGPU adapter is unavailable");
    expect(result!.error).toBeUndefined();
    expect(result!.indirect).toEqual([6, 1, 0, 0]);
    expect(result!.record[2]).toBeCloseTo(1, 5);
    expect(result!.record[3]).toBeCloseTo(128 / 255, 6);
    expect(result!.record.slice(12, 15)).toEqual([0.5, 0.5, 0.5]);
});

test("bootstrap GPU signal stays false when every canonical splat has zero opacity", async ({ page }) => {
    const result = await page.evaluate(
        async ({ moduleUrl, retirementUrl }) => {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                return null;
            }
            const device = await adapter.requestDevice();
            const gpu = await import(moduleUrl);
            const retirement = await import(retirementUrl);
            const encoder = device.createCommandEncoder();
            const engine = { _device: device, _currentEncoder: encoder };
            const state = gpu.createSplatStreamGpuState(engine, 4, 1024 * 1024);
            const canonical = new Float32Array(4 * 16);
            for (let index = 0; index < 4; index++) {
                canonical[index * 16 + 2] = 1;
                canonical[index * 16 + 4] = canonical[index * 16 + 7] = canonical[index * 16 + 9] = 0.001;
            }
            device.queue.writeBuffer(state.canonical, 0, canonical);
            state.count = 4;
            state.contentGeneration = state.gatheredGeneration = 1;
            const batch = gpu.createSplatStreamDrawBatch(state, { _sampleCount: 1 });
            const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
            batch.queue({ count: 4, key: "zero-opacity", worldView: identity, projection: identity, width: 64, height: 64, near: 0.01 });
            batch.flush(engine);
            const signal = batch.takeBootstrapSignal();
            device.queue.submit([encoder.finish()]);
            retirement.flushGpuResourceRetirements(engine);
            return signal ? await signal : null;
        },
        { moduleUrl: gpuModuleUrl, retirementUrl: retirementModuleUrl }
    );
    test.skip(result === null, "A WebGPU adapter is unavailable");
    expect(result).toBe(false);
});

test("culls behind-camera splats and resets the indirect prefix with Lite perspective transforms", async ({ page }) => {
    const result = await page.evaluate(
        async ({ moduleUrl, retirementUrl }) => {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                return null;
            }
            const device = await adapter.requestDevice();
            device.pushErrorScope("validation");
            const gpu = await import(moduleUrl);
            const retirement = await import(retirementUrl);
            const engine = { _device: device, _currentEncoder: device.createCommandEncoder() };
            const state = gpu.createSplatStreamGpuState(engine, 8, 1024 * 1024);
            const canonical = new Float32Array(8 * 16);
            const sourceX = [1.25, 0.25, 0.126, 0.125, 0.124, -1.75, 5.25, -0.25];
            for (let index = 0; index < sourceX.length; index++) {
                const base = index * 16;
                canonical[base] = sourceX[index]!;
                canonical[base + 3] = 1;
                const variance = index === 6 ? 1e20 : 0.001;
                canonical[base + 4] = canonical[base + 7] = canonical[base + 9] = variance;
                canonical[base + 12] = canonical[base + 13] = canonical[base + 14] = 1;
            }
            device.queue.writeBuffer(state.canonical, 0, canonical);
            state.count = 8;
            state.contentGeneration = state.gatheredGeneration = 1;
            const batch = gpu.createSplatStreamDrawBatch(state, { _sampleCount: 1 });
            const near = 0.125;
            const far = 100;
            const focal = 1 / Math.tan(0.8 * 0.5);
            const projection = new Float32Array([focal, 0, 0, 0, 0, focal, 0, 0, 0, 0, -near / (far - near), 1, 0, 0, (far * near) / (far - near), 0]);
            const rotatedTranslated = new Float32Array([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0.25, 1]);

            const run = async (worldView: Float32Array, key: string) => {
                engine._currentEncoder = device.createCommandEncoder();
                batch.reset();
                batch.queue({ count: 8, key, worldView, projection, width: 640, height: 480, near });
                batch.flush(engine);
                const sortedRead = device.createBuffer({ size: 8 * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                const indirectRead = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                engine._currentEncoder.copyBufferToBuffer(batch.passGpu.sorted, 0, sortedRead, 0, 8 * 8);
                engine._currentEncoder.copyBufferToBuffer(batch.passGpu.indirect, 0, indirectRead, 0, 16);
                device.queue.submit([engine._currentEncoder.finish()]);
                retirement.flushGpuResourceRetirements(engine);
                await Promise.all([sortedRead.mapAsync(GPUMapMode.READ), indirectRead.mapAsync(GPUMapMode.READ)]);
                const words = new Uint32Array(sortedRead.getMappedRange().slice(0));
                return {
                    sorted: Array.from({ length: 8 }, (_, index) => ({ key: words[index * 2]!, index: words[index * 2 + 1]! })),
                    indirect: Array.from(new Uint32Array(indirectRead.getMappedRange().slice(0))),
                };
            };

            const mixed = await run(rotatedTranslated, "mixed");
            const allBehind = new Float32Array(rotatedTranslated);
            allBehind[14] = -10;
            const culled = await run(allBehind, "all-behind");
            const error = await device.popErrorScope();
            return { mixed, culled, error: error?.message };
        },
        { moduleUrl: gpuModuleUrl, retirementUrl: retirementModuleUrl }
    );
    test.skip(result === null, "A WebGPU adapter is unavailable");
    expect(result!.error).toBeUndefined();
    expect(result!.mixed.indirect).toEqual([6, 3, 0, 0]);
    expect(result!.mixed.sorted.slice(0, 3).map((entry) => entry.index)).toEqual([5, 7, 4]);
    expect(result!.mixed.sorted.slice(0, 3).every((entry) => entry.key !== 0xffffffff)).toBe(true);
    expect(result!.culled.indirect).toEqual([6, 0, 0, 0]);
});

test("matches Lite Gaussian viewport normalization and culls a large offscreen ellipse", async ({ page }) => {
    const result = await page.evaluate(async (moduleUrl) => {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            return null;
        }
        const device = await adapter.requestDevice();
        device.pushErrorScope("validation");
        const gpu = await import(moduleUrl);
        const engine = { _device: device, _currentEncoder: device.createCommandEncoder() };
        const state = gpu.createSplatStreamGpuState(engine, 2, 1024 * 1024);
        const width = 640;
        const height = 480;
        const depth = 2;
        const focal = 1 / Math.tan(0.8 * 0.5);
        const projection = new Float32Array([focal, 0, 0, 0, 0, focal, 0, 0, 0, 0, -0.1 / 99.9, 1, 0, 0, 10 / 99.9, 0]);
        const jx = (focal / depth) * (width * 0.5);
        const pixelAxis = 12;
        const covarianceX = (pixelAxis * pixelAxis * 0.5 - 0.3) / (jx * jx);
        const canonical = new Float32Array(2 * 16);
        for (let index = 0; index < 2; index++) {
            const base = index * 16;
            canonical[base + 2] = depth;
            canonical[base + 3] = 1;
            canonical[base + 4] = covarianceX;
            canonical[base + 7] = canonical[base + 9] = 0.0001;
            canonical[base + 12] = canonical[base + 13] = canonical[base + 14] = 1;
        }
        canonical[16] = (1.1 * depth) / focal;
        device.queue.writeBuffer(state.canonical, 0, canonical);
        state.count = 2;
        state.contentGeneration = state.gatheredGeneration = 1;
        const batch = gpu.createSplatStreamDrawBatch(state, { _sampleCount: 1 });
        const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        batch.queue({ count: 2, key: "viewport-normalization", worldView: identity, projection, width, height, near: 0.1 });
        batch.flush(engine);
        const projectedRead = device.createBuffer({ size: 2 * 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const sortedRead = device.createBuffer({ size: 2 * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const indirectRead = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        engine._currentEncoder.copyBufferToBuffer(batch.passGpu.projected, 0, projectedRead, 0, 2 * 64);
        engine._currentEncoder.copyBufferToBuffer(batch.passGpu.sorted, 0, sortedRead, 0, 2 * 8);
        engine._currentEncoder.copyBufferToBuffer(batch.passGpu.indirect, 0, indirectRead, 0, 16);
        device.queue.submit([engine._currentEncoder.finish()]);
        await Promise.all([projectedRead.mapAsync(GPUMapMode.READ), sortedRead.mapAsync(GPUMapMode.READ), indirectRead.mapAsync(GPUMapMode.READ)]);
        const projected = Array.from(new Float32Array(projectedRead.getMappedRange().slice(0)));
        const sorted = Array.from(new Uint32Array(sortedRead.getMappedRange().slice(0)));
        const indirect = Array.from(new Uint32Array(indirectRead.getMappedRange().slice(0)));
        const error = await device.popErrorScope();
        return { projected, sorted, indirect, error: error?.message };
    }, gpuModuleUrl);
    test.skip(result === null, "A WebGPU adapter is unavailable");
    expect(result!.error).toBeUndefined();
    expect(result!.indirect).toEqual([6, 1, 0, 0]);
    expect(Math.hypot(result!.projected[4]!, result!.projected[5]!)).toBeCloseTo(0.0375, 5);
    expect(result!.sorted.slice(0, 2)).toEqual([result!.sorted[0]!, 0]);
});

test("rejects far-off-axis near-plane centers and caps valid ellipse axes", async ({ page }) => {
    const result = await page.evaluate(async (moduleUrl) => {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            return null;
        }
        const device = await adapter.requestDevice();
        device.pushErrorScope("validation");
        const gpu = await import(moduleUrl);
        const engine = { _device: device, _currentEncoder: device.createCommandEncoder() };
        const state = gpu.createSplatStreamGpuState(engine, 3, 1024 * 1024);
        const width = 640;
        const height = 480;
        const near = 0.1;
        const far = 100;
        const focal = 1 / Math.tan(0.8 * 0.5);
        const projection = new Float32Array([focal, 0, 0, 0, 0, focal, 0, 0, 0, 0, -near / (far - near), 1, 0, 0, (far * near) / (far - near), 0]);
        const canonical = new Float32Array(3 * 16);
        for (let index = 0; index < 3; index++) {
            const base = index * 16;
            canonical[base + 2] = index === 0 ? 0.2 : 2;
            canonical[base + 3] = 1;
            const variance = index === 0 ? 1e20 : index === 1 ? 100 : 3e38;
            canonical[base + 4] = canonical[base + 7] = canonical[base + 9] = variance;
            canonical[base + 12] = canonical[base + 13] = canonical[base + 14] = 1;
        }
        canonical[0] = (2730 * canonical[2]!) / focal;
        device.queue.writeBuffer(state.canonical, 0, canonical);
        state.count = 3;
        state.contentGeneration = state.gatheredGeneration = 1;
        const batch = gpu.createSplatStreamDrawBatch(state, { _sampleCount: 1 });
        const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        batch.queue({ count: 3, key: "projection-domain-guards", worldView: identity, projection, width, height, near });
        batch.flush(engine);
        const projectedRead = device.createBuffer({ size: 3 * 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const sortedRead = device.createBuffer({ size: 3 * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const indirectRead = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        engine._currentEncoder.copyBufferToBuffer(batch.passGpu.projected, 0, projectedRead, 0, 3 * 64);
        engine._currentEncoder.copyBufferToBuffer(batch.passGpu.sorted, 0, sortedRead, 0, 3 * 8);
        engine._currentEncoder.copyBufferToBuffer(batch.passGpu.indirect, 0, indirectRead, 0, 16);
        device.queue.submit([engine._currentEncoder.finish()]);
        await Promise.all([projectedRead.mapAsync(GPUMapMode.READ), sortedRead.mapAsync(GPUMapMode.READ), indirectRead.mapAsync(GPUMapMode.READ)]);
        const projected = Array.from(new Float32Array(projectedRead.getMappedRange().slice(0)));
        const sorted = Array.from(new Uint32Array(sortedRead.getMappedRange().slice(0)));
        const indirect = Array.from(new Uint32Array(indirectRead.getMappedRange().slice(0)));
        const error = await device.popErrorScope();
        return { projected, sorted, indirect, error: error?.message };
    }, gpuModuleUrl);
    test.skip(result === null, "A WebGPU adapter is unavailable");
    expect(result!.error).toBeUndefined();
    expect(result!.indirect).toEqual([6, 1, 0, 0]);
    expect(result!.sorted.slice(0, 2)).toEqual([result!.sorted[0]!, 1]);
    const onAxis = result!.projected.slice(16, 32);
    const clipW = onAxis[3]!;
    const majorPixels = Math.hypot((onAxis[4]! / clipW) * 640, (onAxis[5]! / clipW) * 480);
    const minorPixels = Math.hypot((onAxis[8]! / clipW) * 640, (onAxis[9]! / clipW) * 480);
    expect([majorPixels, minorPixels].every((value) => value >= 1023.9 && value <= 1024.001)).toBe(true);
    expect(onAxis.every(Number.isFinite)).toBe(true);
});

test("reuses pass state for the same render-task signature and isolates distinct signatures", async ({ page }) => {
    const result = await page.evaluate(async (moduleUrl) => {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            return null;
        }
        const device = await adapter.requestDevice();
        device.pushErrorScope("validation");
        const gpu = await import(moduleUrl);
        const engine = { _device: device };
        const state = gpu.createSplatStreamGpuState(engine, 4, 1024 * 1024);
        const signature = { _sampleCount: 1 };
        const sameA = gpu.getSplatStreamDrawBatch(state, signature);
        const allocatedAfterFirst = state.ledger.allocatedBytes;
        const sameB = gpu.getSplatStreamDrawBatch(state, signature);
        const allocatedAfterRebind = state.ledger.allocatedBytes;
        const distinct = gpu.getSplatStreamDrawBatch(state, { _sampleCount: 1 });
        const allocatedAfterDistinct = state.ledger.allocatedBytes;
        const error = await device.popErrorScope();
        return {
            same: sameA === sameB,
            distinct: sameA !== distinct,
            allocatedAfterFirst,
            allocatedAfterRebind,
            allocatedAfterDistinct,
            error: error?.message,
        };
    }, gpuModuleUrl);
    test.skip(result === null, "A WebGPU adapter is unavailable");
    expect(result!.error).toBeUndefined();
    expect([result!.same, result!.distinct]).toEqual([true, true]);
    expect(result!.allocatedAfterRebind).toBe(result!.allocatedAfterFirst);
    expect(result!.allocatedAfterDistinct).toBeGreaterThan(result!.allocatedAfterRebind);
});

test("preserves radix integrity when active counts collapse below the allocated root stride", async ({ page }) => {
    const result = await page.evaluate(
        async ({ moduleUrl, retirementUrl }) => {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                return null;
            }
            const device = await adapter.requestDevice();
            device.pushErrorScope("validation");
            const gpu = await import(moduleUrl);
            const retirement = await import(retirementUrl);
            const capacity = 500_000;
            const maxCount = 65_537;
            const engine = { _device: device, _currentEncoder: device.createCommandEncoder() };
            const state = gpu.createSplatStreamGpuState(engine, capacity, 256 * 1024 * 1024);
            const canonical = new Float32Array(maxCount * 16);
            for (let index = 0; index < maxCount; index++) {
                const base = index * 16;
                canonical[base + 2] = 0.2 + ((index * 73) % 997) / 100;
                canonical[base + 3] = index % 19 === 0 ? 0 : 1;
                canonical[base + 4] = canonical[base + 7] = canonical[base + 9] = 0.001;
                canonical[base + 12] = canonical[base + 13] = canonical[base + 14] = 1;
            }
            device.queue.writeBuffer(state.canonical, 0, canonical);
            state.contentGeneration = state.gatheredGeneration = 1;
            const batch = gpu.createSplatStreamDrawBatch(state, { _sampleCount: 1 });
            const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

            const run = async (count: number, frame: number) => {
                state.count = count;
                engine._currentEncoder = device.createCommandEncoder();
                batch.reset();
                batch.queue({ count, key: `collapse-${frame}-${count}`, worldView: identity, projection: identity, width: 4096, height: 4096, near: 0.01 });
                batch.flush(engine);
                const sortedRead = device.createBuffer({ size: count * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                const indirectRead = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                engine._currentEncoder.copyBufferToBuffer(batch.passGpu.sorted, 0, sortedRead, 0, count * 8);
                engine._currentEncoder.copyBufferToBuffer(batch.passGpu.indirect, 0, indirectRead, 0, 16);
                device.queue.submit([engine._currentEncoder.finish()]);
                retirement.flushGpuResourceRetirements(engine);
                await Promise.all([sortedRead.mapAsync(GPUMapMode.READ), indirectRead.mapAsync(GPUMapMode.READ)]);
                const words = new Uint32Array(sortedRead.getMappedRange());
                const indirect = Array.from(new Uint32Array(indirectRead.getMappedRange()));
                const expectedValid = count - (Math.floor((count - 1) / 19) + 1);
                const failures: string[] = [];
                if (indirect[1] !== expectedValid) {
                    failures.push(`indirect ${indirect[1]} != ${expectedValid}`);
                }
                const seen = new Uint8Array(count);
                let previousKey = 0;
                for (let slot = 0; slot < count; slot++) {
                    const key = words[slot * 2]!;
                    const index = words[slot * 2 + 1]!;
                    if (slot < expectedValid) {
                        if (key === 0xffffffff || index >= count || seen[index] || index % 19 === 0 || (slot > 0 && key < previousKey)) {
                            failures.push(`invalid prefix at ${slot}: key=${key} index=${index}`);
                            break;
                        }
                        seen[index] = 1;
                        previousKey = key;
                    }
                }
                return { count, indirect, failures };
            };

            const frames = [];
            for (const [frame, count] of [65_537, 59_589, 65_536, 65_537].entries()) {
                frames.push(await run(count, frame));
            }
            const error = await device.popErrorScope();
            return { frames, error: error?.message };
        },
        { moduleUrl: gpuModuleUrl, retirementUrl: retirementModuleUrl }
    );
    test.skip(result === null, "A WebGPU adapter is unavailable");
    expect(result!.error).toBeUndefined();
    expect(result!.frames.map((frame) => frame.failures)).toEqual([[], [], [], []]);
});

for (const [count, requestedCapacity] of [
    [0, 1],
    [1, 1],
    [7, 7],
    [255, 255],
    [256, 256],
    [257, 257],
    [600, 40_000],
    [65_537, 65_537],
    [70_001, 200_000],
] as const) {
    test(`stably sorts ${count} projected records at capacity ${requestedCapacity}`, async ({ page }) => {
        const result = await page.evaluate(
            async ({ moduleUrl, count, requestedCapacity }) => {
                const adapter = await navigator.gpu.requestAdapter();
                if (!adapter) {
                    return null;
                }
                const device = await adapter.requestDevice();
                device.pushErrorScope("validation");
                const gpu = await import(moduleUrl);
                const encoder = device.createCommandEncoder();
                const engine = { _device: device, _currentEncoder: encoder };
                const state = gpu.createSplatStreamGpuState(engine, requestedCapacity, 128 * 1024 * 1024);
                const values = new Float32Array(Math.max(count, 1) * 16);
                const bits = new Uint32Array(values.buffer);
                const expected: Array<{ key: number; index: number }> = [];
                let validCount = 0;
                for (let index = 0; index < count; index++) {
                    const base = index * 16;
                    const invalid = index % 31 === 0;
                    const depth = index % 9 === 0 ? 3 : Math.fround(0.1 + ((index * 73) % 509) / 97);
                    values[base + 2] = depth;
                    values[base + 3] = invalid ? 0 : 1;
                    values[base + 4] = values[base + 7] = values[base + 9] = 0.001;
                    values[base + 12] = values[base + 13] = values[base + 14] = 1;
                    const depthBits = new Uint32Array(new Float32Array([depth]).buffer)[0]!;
                    if (!invalid) {
                        expected.push({ key: ~depthBits >>> 0, index });
                        validCount++;
                    }
                }
                if (count) {
                    device.queue.writeBuffer(state.canonical, 0, bits, 0, count * 16);
                }
                state.count = count;
                state.contentGeneration = state.gatheredGeneration = 1;
                const batch = gpu.createSplatStreamDrawBatch(state, { _sampleCount: 1 });
                const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
                batch.reset();
                batch.queue({ count, key: "sort", worldView: identity, projection: identity, width: 4096, height: 4096, near: 0.01 });
                batch.flush(engine);
                const keyBytes = Math.max(count * 8, 8);
                const keysRead = device.createBuffer({ size: keyBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                const argsRead = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                const runtimeRead = device.createBuffer({ size: 128, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                if (count) {
                    encoder.copyBufferToBuffer(batch.passGpu.sorted, 0, keysRead, 0, count * 8);
                }
                encoder.copyBufferToBuffer(batch.passGpu.indirect, 0, argsRead, 0, 16);
                encoder.copyBufferToBuffer(batch.passGpu.runtime, 0, runtimeRead, 0, 128);
                device.queue.submit([encoder.finish()]);
                await Promise.all([keysRead.mapAsync(GPUMapMode.READ), argsRead.mapAsync(GPUMapMode.READ), runtimeRead.mapAsync(GPUMapMode.READ)]);
                const words = new Uint32Array(keysRead.getMappedRange().slice(0));
                const actual = Array.from({ length: validCount }, (_, index) => ({ key: words[index * 2]!, index: words[index * 2 + 1]! }));
                expected.sort((a, b) => a.key - b.key || a.index - b.index);
                const error = await device.popErrorScope();
                return {
                    actual,
                    expected,
                    args: Array.from(new Uint32Array(argsRead.getMappedRange().slice(0))),
                    runtime: Array.from(new Uint32Array(runtimeRead.getMappedRange().slice(0))),
                    levelCount: batch.passGpu.levels.length,
                    validCount,
                    error: error?.message,
                };
            },
            { moduleUrl: gpuModuleUrl, count, requestedCapacity }
        );
        test.skip(result === null, "A WebGPU adapter is unavailable");
        expect(result!.error).toBeUndefined();
        expect(result!.actual).toEqual(result!.expected);
        expect(result!.args).toEqual([6, result!.validCount, 0, 0]);
        expect(result!.runtime[0]).toBe(result!.validCount);
        if (count === 0) {
            expect(result!.runtime.every((value) => value === 0)).toBe(true);
        } else {
            const dispatch = (slot: number): number[] => result!.runtime.slice(4 + slot * 3, 7 + slot * 3);
            let levelItems = Math.ceil(result!.validCount / 256);
            expect(dispatch(0)).toEqual([levelItems, 1, 1]);
            for (let level = 0; level < result!.levelCount; level++) {
                expect(dispatch(1 + level)).toEqual([Math.max(1, Math.ceil(levelItems / 256)), 16, 1]);
                levelItems = Math.ceil(levelItems / 256);
            }
            let childItems = Math.ceil(result!.validCount / 256);
            for (let child = 0; child + 1 < result!.levelCount; child++) {
                expect(dispatch(1 + result!.levelCount + child)).toEqual([Math.ceil(childItems / 256), 16, 1]);
                childItems = Math.ceil(childItems / 256);
            }
        }
    });
}

test("compacts zero-many-one-zero survivors with stable cross-group ties and fresh indirect work", async ({ page }) => {
    const result = await page.evaluate(
        async ({ moduleUrl, retirementUrl }) => {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                return null;
            }
            const device = await adapter.requestDevice();
            device.pushErrorScope("validation");
            const gpu = await import(moduleUrl);
            const retirement = await import(retirementUrl);
            const capacity = 600;
            const engine = { _device: device, _currentEncoder: device.createCommandEncoder() };
            const state = gpu.createSplatStreamGpuState(engine, capacity, 16 * 1024 * 1024);
            state.count = capacity;
            state.contentGeneration = state.gatheredGeneration = 1;
            const batch = gpu.createSplatStreamDrawBatch(state, { _sampleCount: 1 });
            const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

            const run = async (name: string, live: (index: number) => boolean) => {
                const canonical = new Float32Array(capacity * 16);
                const expected: number[] = [];
                for (let index = 0; index < capacity; index++) {
                    const base = index * 16;
                    canonical[base + 2] = 3;
                    canonical[base + 3] = live(index) ? 1 : 0;
                    canonical[base + 4] = canonical[base + 7] = canonical[base + 9] = 0.001;
                    canonical[base + 12] = canonical[base + 13] = canonical[base + 14] = 1;
                    if (live(index)) {
                        expected.push(index);
                    }
                }
                device.queue.writeBuffer(state.canonical, 0, canonical);
                engine._currentEncoder = device.createCommandEncoder();
                batch.reset();
                batch.queue({ count: capacity, key: name, worldView: identity, projection: identity, width: 4096, height: 4096, near: 0.01 });
                batch.flush(engine);
                const keysRead = device.createBuffer({ size: Math.max(expected.length * 8, 8), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                const argsRead = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                const runtimeRead = device.createBuffer({ size: 128, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                if (expected.length) {
                    engine._currentEncoder.copyBufferToBuffer(batch.passGpu.sorted, 0, keysRead, 0, expected.length * 8);
                }
                engine._currentEncoder.copyBufferToBuffer(batch.passGpu.indirect, 0, argsRead, 0, 16);
                engine._currentEncoder.copyBufferToBuffer(batch.passGpu.runtime, 0, runtimeRead, 0, 128);
                device.queue.submit([engine._currentEncoder.finish()]);
                retirement.flushGpuResourceRetirements(engine);
                await Promise.all([keysRead.mapAsync(GPUMapMode.READ), argsRead.mapAsync(GPUMapMode.READ), runtimeRead.mapAsync(GPUMapMode.READ)]);
                const words = new Uint32Array(keysRead.getMappedRange());
                const pairs = Array.from({ length: expected.length }, (_, slot) => ({ key: words[slot * 2]!, index: words[slot * 2 + 1]! }));
                return {
                    expected,
                    pairs,
                    args: Array.from(new Uint32Array(argsRead.getMappedRange())),
                    runtime: Array.from(new Uint32Array(runtimeRead.getMappedRange())),
                };
            };

            const frames = [
                await run("zero-a", () => false),
                await run("many", (index) => index % 5 !== 0),
                await run("one", (index) => index === 511),
                await run("zero-b", () => false),
            ];
            const error = await device.popErrorScope();
            return { frames, error: error?.message };
        },
        { moduleUrl: gpuModuleUrl, retirementUrl: retirementModuleUrl }
    );
    test.skip(result === null, "A WebGPU adapter is unavailable");
    expect(result!.error).toBeUndefined();
    for (const frame of result!.frames) {
        expect(frame.args).toEqual([6, frame.expected.length, 0, 0]);
        expect(frame.runtime[0]).toBe(frame.expected.length);
        expect(frame.runtime.slice(4, 7)).toEqual([Math.ceil(frame.expected.length / 256), 1, 1]);
        expect(frame.pairs.map((pair) => pair.index)).toEqual(frame.expected);
        expect(frame.pairs.every((pair) => pair.key !== 0xffffffff)).toBe(true);
    }
});

test("accounts and retires compaction resources while preserving the demo capacity", async ({ page }) => {
    const result = await page.evaluate(
        async ({ moduleUrl, retirementUrl }) => {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                return null;
            }
            const device = await adapter.requestDevice();
            device.pushErrorScope("validation");
            const gpu = await import(moduleUrl);
            const retirement = await import(retirementUrl);
            const engine = { _device: device, _currentEncoder: device.createCommandEncoder() };
            const budgetedDemoCapacity = gpu.getSplatStreamGpuCapacity(
                { limits: { maxComputeWorkgroupsPerDimension: 65_535, maxBufferSize: 1024 ** 3, maxStorageBufferBindingSize: 1024 ** 3 } } as GPUDevice,
                4_010_000,
                1024 ** 3
            );
            const state = gpu.createSplatStreamGpuState(engine, 257, 16 * 1024 * 1024);
            const beforeBatch = { allocated: state.ledger.allocatedBytes, held: state.ledger.heldBytes };
            const batch = gpu.createSplatStreamDrawBatch(state, { _sampleCount: 1 });
            const afterBatch = { allocated: state.ledger.allocatedBytes, held: state.ledger.heldBytes };
            batch.destroy();
            gpu.retireSplatStreamGpuState(state);
            device.queue.submit([engine._currentEncoder.finish()]);
            retirement.flushGpuResourceRetirements(engine);
            await device.queue.onSubmittedWorkDone();
            await Promise.resolve();
            const retired = { allocated: state.ledger.allocatedBytes, held: state.ledger.heldBytes };
            const error = await device.popErrorScope();
            return { budgetedDemoCapacity, beforeBatch, afterBatch, retired, error: error?.message };
        },
        { moduleUrl: gpuModuleUrl, retirementUrl: retirementModuleUrl }
    );
    test.skip(result === null, "A WebGPU adapter is unavailable");
    expect(result!.error).toBeUndefined();
    expect(result!.budgetedDemoCapacity).toBe(4_010_000);
    expect(result!.beforeBatch.allocated).toBeGreaterThan(0);
    expect(result!.beforeBatch.held).toBeGreaterThan(0);
    expect(result!.afterBatch.allocated).toBe(result!.beforeBatch.allocated + result!.beforeBatch.held);
    expect(result!.afterBatch.held).toBe(0);
    expect(result!.retired).toEqual({ allocated: 0, held: 0 });
});

test("isolates chunked gather and camera snapshots across two passes in one submission", async ({ page }) => {
    const result = await page.evaluate(async (moduleUrl) => {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            return null;
        }
        const device = await adapter.requestDevice();
        device.pushErrorScope("validation");
        const gpu = await import(moduleUrl);
        const encoder = device.createCommandEncoder();
        const engine = { _device: device, _currentEncoder: encoder };
        const makeSource = (selector: number) => {
            const sh0Codebook = new Float32Array(256);
            sh0Codebook[selector] = selector;
            const metadata = {
                count: 1,
                meansMin: new Float32Array([0, 0, -Math.log(2)]),
                meansMax: new Float32Array([0, 0, -Math.log(2)]),
                scaleCodebook: new Float32Array(256),
                sh0Codebook,
                imageUrls: ["", "", "", "", ""],
            };
            const images = Array.from({ length: 5 }, () => new Uint8Array(4));
            images[3]!.set([128, 128, 128, 252]);
            images[4]!.set([selector, 0, 0, 255]);
            return gpu.uploadSplatStreamSourceBytes(device, metadata, 1, 1, images);
        };
        const sourceA = makeSource(1);
        const sourceB = makeSource(2);
        const intervalCount = 4097;
        const state = gpu.createSplatStreamGpuState(engine, intervalCount, 16 * 1024 * 1024);
        const batchA = gpu.createSplatStreamDrawBatch(state, { _sampleCount: 1 });
        const batchB = gpu.createSplatStreamDrawBatch(state, { _sampleCount: 1 });
        const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        const offscreen = identity.slice();
        offscreen[12] = 100;
        const canonicalFirstA = device.createBuffer({ size: 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const canonicalLastA = device.createBuffer({ size: 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const indirectA = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const canonicalB = device.createBuffer({ size: 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const indirectB = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

        gpu.setSplatStreamGpuIntervals(
            state,
            Array.from({ length: intervalCount }, (_, destinationOffset) => ({
                source: sourceA,
                sourceOffset: 0,
                count: 1,
                destinationOffset,
            })),
            1
        );
        batchA.queue({ count: intervalCount, key: "pass-a", worldView: identity, projection: identity, width: 64, height: 64, near: 0.01 });
        batchA.flush(engine);
        encoder.copyBufferToBuffer(state.canonical, 0, canonicalFirstA, 0, 64);
        encoder.copyBufferToBuffer(state.canonical, (intervalCount - 1) * 64, canonicalLastA, 0, 64);
        encoder.copyBufferToBuffer(batchA.passGpu.indirect, 0, indirectA, 0, 16);

        gpu.setSplatStreamGpuIntervals(state, [{ source: sourceB, sourceOffset: 0, count: 1, destinationOffset: 0 }], 2);
        batchB.queue({ count: 1, key: "pass-b", worldView: offscreen, projection: identity, width: 64, height: 64, near: 0.01 });
        batchB.flush(engine);
        encoder.copyBufferToBuffer(state.canonical, 0, canonicalB, 0, 64);
        encoder.copyBufferToBuffer(batchB.passGpu.indirect, 0, indirectB, 0, 16);

        device.queue.submit([encoder.finish()]);
        const reads = [canonicalFirstA, canonicalLastA, indirectA, canonicalB, indirectB];
        await Promise.all(reads.map((buffer) => buffer.mapAsync(GPUMapMode.READ)));
        const canonical = (buffer: GPUBuffer) => Array.from(new Float32Array(buffer.getMappedRange().slice(0)));
        const indirect = (buffer: GPUBuffer) => Array.from(new Uint32Array(buffer.getMappedRange().slice(0)));
        const firstA = canonical(canonicalFirstA);
        const lastA = canonical(canonicalLastA);
        const second = canonical(canonicalB);
        const error = await device.popErrorScope();
        return {
            firstColorA: firstA[12],
            lastColorA: lastA[12],
            colorB: second[12],
            indirectA: indirect(indirectA),
            indirectB: indirect(indirectB),
            error: error?.message,
        };
    }, gpuModuleUrl);
    test.skip(result === null, "A WebGPU adapter is unavailable");
    expect(result!.error).toBeUndefined();
    expect(result!.lastColorA).toBe(result!.firstColorA);
    expect(result!.colorB).not.toBe(result!.firstColorA);
    expect(result!.indirectA).toEqual([6, 4097, 0, 0]);
    expect(result!.indirectB).toEqual([6, 0, 0, 0]);
});

test("keeps distinct stable selection identities for actual material bindings", async ({ page }) => {
    const result = await page.evaluate(
        async ({ gpuUrl, materialUrl }) => {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                return null;
            }
            const device = await adapter.requestDevice();
            device.pushErrorScope("validation");
            const gpu = await import(gpuUrl);
            const material = await import(materialUrl);
            const engine = { _device: device, _currentEncoder: device.createCommandEncoder() };
            const state = gpu.createSplatStreamGpuState(engine, 1, 8 * 1024 * 1024);
            const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
            const seen: object[] = [];
            const renderable = material.buildSplatStreamGpuRenderable(
                state,
                () => identity,
                (_context: unknown, binding: object) => seen.push(binding)
            );
            const signature = { _colorFormat: "rgba8unorm", _sampleCount: 1 };
            const first = renderable.bind(engine, signature);
            const second = renderable.bind(engine, signature);
            const camera = {
                fov: 1,
                nearPlane: 0.01,
                farPlane: 100,
                children: [],
                worldMatrix: identity,
                worldMatrixVersion: 0,
                _viewCache: new Float32Array(16),
                _projCache: new Float32Array(16),
                _vpCache: new Float32Array(16),
            };
            const context = { targetWidth: 64, targetHeight: 64, _camera: camera };
            first.update(context);
            second.update(context);
            first.update(context);
            second.update(context);
            const error = await device.popErrorScope();
            return {
                distinct: seen[0] !== seen[1],
                firstStable: seen[0] === seen[2],
                secondStable: seen[1] === seen[3],
                identityCount: new Set(seen).size,
                error: error?.message,
            };
        },
        { gpuUrl: gpuModuleUrl, materialUrl: materialModuleUrl }
    );
    test.skip(result === null, "A WebGPU adapter is unavailable");
    expect(result!.error).toBeUndefined();
    expect(result).toMatchObject({ distinct: true, firstStable: true, secondStable: true, identityCount: 2 });
});

test("protects gather descriptors under a full source ledger until the prior submission retires", async ({ page }) => {
    const result = await page.evaluate(async (moduleUrl) => {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            return null;
        }
        const device = await adapter.requestDevice();
        device.pushErrorScope("validation");
        const gpu = await import(moduleUrl);
        const retirement = await import(new URL("../engine/gpu-resource-retirement.ts", new URL(moduleUrl, location.href)).href);
        let encoder = device.createCommandEncoder();
        const engine: {
            _device: GPUDevice;
            _currentEncoder: GPUCommandEncoder;
        } = { _device: device, _currentEncoder: encoder };
        const makeSource = (selector: number) => {
            const metadata = {
                count: 1,
                meansMin: new Float32Array([0, 0, -Math.log(2)]),
                meansMax: new Float32Array([0, 0, -Math.log(2)]),
                scaleCodebook: new Float32Array(256),
                sh0Codebook: Float32Array.from({ length: 256 }, (_, index) => (index === selector ? selector : 0)),
                imageUrls: ["", "", "", "", ""],
            };
            const images = Array.from({ length: 5 }, () => new Uint8Array(4));
            images[3]!.set([128, 128, 128, 252]);
            images[4]!.set([selector, 0, 0, 255]);
            return gpu.uploadSplatStreamSourceBytes(device, metadata, 1, 1, images);
        };
        const sourceA = makeSource(1);
        const sourceB = makeSource(2);
        const state = gpu.createSplatStreamGpuState(engine, 1, 1024 * 1024);
        gpu.holdSplatStreamGatherParameters(state, 1);
        const batch = gpu.createSplatStreamDrawBatch(state, { _sampleCount: 1 });
        const filler = state.ledger.maxBytes - state.ledger.allocatedBytes - state.ledger.heldBytes;
        if (!state.ledger.tryReserve(filler)) {
            throw new Error("failed to saturate the source ledger");
        }
        const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        const read = () => device.createBuffer({ size: 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const beforeRetirement = read();
        const afterRetirement = read();

        gpu.setSplatStreamGpuIntervals(state, [{ source: sourceA, sourceOffset: 0, count: 1, destinationOffset: 0 }], 1);
        batch.queue({ count: 1, key: "a", worldView: identity, projection: identity, width: 64, height: 64, near: 0.01 });
        batch.flush(engine);
        gpu.setSplatStreamGpuIntervals(state, [{ source: sourceB, sourceOffset: 0, count: 1, destinationOffset: 0 }], 2);
        batch.queue({ count: 1, key: "b-blocked", worldView: identity, projection: identity, width: 64, height: 64, near: 0.01 });
        batch.flush(engine);
        encoder.copyBufferToBuffer(state.canonical, 0, beforeRetirement, 0, 64);
        device.queue.submit([encoder.finish()]);
        await retirement.waitForGpuResourceRetirements(engine);

        encoder = device.createCommandEncoder();
        engine._currentEncoder = encoder;
        batch.queue({ count: 1, key: "b-retired", worldView: identity, projection: identity, width: 64, height: 64, near: 0.01 });
        batch.flush(engine);
        encoder.copyBufferToBuffer(state.canonical, 0, afterRetirement, 0, 64);
        device.queue.submit([encoder.finish()]);
        await Promise.all([beforeRetirement.mapAsync(GPUMapMode.READ), afterRetirement.mapAsync(GPUMapMode.READ)]);
        const color = (buffer: GPUBuffer) => new Float32Array(buffer.getMappedRange().slice(0))[12];
        const error = await device.popErrorScope();
        return {
            before: color(beforeRetirement),
            after: color(afterRetirement),
            inFlight: state.gatherParametersInFlight,
            heldBytes: state.ledger.heldBytes,
            allocatedBytes: state.ledger.allocatedBytes,
            maxBytes: state.ledger.maxBytes,
            error: error?.message,
        };
    }, gpuModuleUrl);
    test.skip(result === null, "A WebGPU adapter is unavailable");
    expect(result!.error).toBeUndefined();
    expect(result!.before).not.toBe(result!.after);
    expect(result!.inFlight).toBe(1);
    expect(result!.heldBytes).toBe(0);
    expect(result!.allocatedBytes).toBe(result!.maxBytes);
});
