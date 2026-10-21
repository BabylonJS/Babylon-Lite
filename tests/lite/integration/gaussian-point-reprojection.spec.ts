import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { resolve } from "node:path";
import type * as GpsReproject from "../../../packages/babylon-lite/src/gaussian-point-splatting/gps-reproject.js";
import type { Mat4 } from "../../../packages/babylon-lite/src/math/types.js";

test("Gaussian point reprojection selects and filters actual current depth on the GPU", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://localhost:${process.env.LAB_TEST_PORT ?? 5179}/`);
    const bundle = await build({
        entryPoints: [resolve("packages", "babylon-lite", "src", "gaussian-point-splatting", "gps-reproject.ts")],
        bundle: true,
        format: "iife",
        globalName: "gpsReprojectionTest",
        write: false,
    });
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    const result = await page.evaluate(async () => {
        const module = (window as unknown as { gpsReprojectionTest: typeof GpsReproject }).gpsReprojectionTest;
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            throw new Error("WebGPU adapter unavailable");
        }
        const device = await adapter.requestDevice();
        const gpuErrors: string[] = [];
        device.addEventListener("uncapturederror", (event) => gpuErrors.push(event.error.message));
        const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        const run = async (
            kind: "finite" | "infinite" | "orthographic" | "off-axis",
            motion: "backward" | "lateral" | "hole" | "invalid" | "beyond-far" | "out-of-range" | "non-finite"
        ): Promise<{
            kind: string;
            motion: string;
            winner: number;
            color: number[];
            depth: number;
            expectedDepth: number;
            count: number;
            errors: string[];
        }> => {
            device.pushErrorScope("validation");
            const width = 12;
            const generation = 3;
            const resources: GPUBuffer[] = [];
            const make = (size: number, label: string, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST): GPUBuffer => {
                const buffer = device.createBuffer({ size, label, usage });
                resources.push(buffer);
                return buffer;
            };
            const target: GpsReproject.GpsReprojectionTarget = {
                accum: make(width * 16, "test accumulation"),
                depth: make(width * 4, "test depth"),
                counts: make(width * 4, "test counts"),
                buffers: [],
            };
            const projection = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.1 / 99.9, 1, 0, 0, 10 / 99.9, 0]);
            if (kind === "infinite") {
                projection[10] = 0;
                projection[14] = 0.1;
            } else if (kind === "orthographic") {
                projection.set(identity);
                projection[10] = -1 / 99.9;
                projection[14] = 100 / 99.9;
            } else if (kind === "off-axis") {
                projection[8] = 0.2;
                projection[2] = 0.01;
            }
            const matrices = new Float32Array(48);
            matrices.set(identity);
            matrices.set(identity, 16);
            matrices.set(projection, 32);
            const view = identity.slice();
            if (motion === "backward") {
                view[12] = 0.02;
                view[14] = 1;
            } else if (motion === "lateral" || motion === "hole") {
                view[12] = kind === "orthographic" ? -0.05 : -0.1;
            } else if (motion === "invalid") {
                view[14] = -20;
            } else if (motion === "beyond-far") {
                view[14] = 100;
            }
            const params = new Float32Array(52);
            params.set(module.gpsReprojectionMatrix(matrices, identity as unknown as Mat4, view as unknown as Mat4, projection as unknown as Mat4)!);
            params.set([width, 1, generation, 16], 48);
            const colors = new Float32Array(width * 4);
            const background = motion === "hole" ? 6 : 5;
            colors.set([1, 0, 0, 1], 4 * 4);
            colors.set([0, 1, 0, 1], background * 4);
            const depths = new Float32Array(width);
            for (const [pixel, z] of [
                [4, 2],
                [background, 10],
            ]) {
                const x = ((pixel! + 0.5) / width) * 2 - 1;
                // Solve the projection for the view-space X at this exact previous pixel center.
                const viewX = kind === "orthographic" ? x : (x - projection[8]!) * z!;
                depths[pixel!] = (projection[2]! * viewX + projection[10]! * z! + projection[14]!) / (projection[11]! * z! + projection[15]!);
            }
            if (motion === "out-of-range") {
                depths[4] = depths[background] = 1.5;
            } else if (motion === "non-finite") {
                depths[4] = NaN;
                depths[background] = Infinity;
            }
            const counts = new Uint32Array(width);
            counts[4] = counts[background] = (generation << 16) | 12;
            device.queue.writeBuffer(target.accum, 0, colors);
            device.queue.writeBuffer(target.depth, 0, depths);
            device.queue.writeBuffer(target.counts, 0, counts);
            const encoder = device.createCommandEncoder();
            module.gpsRecordReprojection(device, encoder, target, params, make, (pipeline, buffers, x, y) => {
                const group = device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
                });
                const pass = encoder.beginComputePass();
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, group);
                pass.dispatchWorkgroups(x, y);
                pass.end();
            });
            const pixel = motion === "backward" || motion === "hole" ? 5 : 4;
            const readback = make(32, "test readback", GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
            encoder.copyBufferToBuffer(target.accum, pixel * 16, readback, 0, 16);
            encoder.copyBufferToBuffer(target.depth, pixel * 4, readback, 16, 4);
            encoder.copyBufferToBuffer(target.counts, pixel * 4, readback, 20, 4);
            encoder.copyBufferToBuffer(target.history!.winner, pixel * 4, readback, 24, 4);
            device.queue.submit([encoder.finish()]);
            await readback.mapAsync(GPUMapMode.READ);
            const data = readback.getMappedRange().slice(0);
            readback.unmap();
            const floats = new Float32Array(data);
            const integers = new Uint32Array(data);
            const error = await device.popErrorScope();
            resources.forEach((buffer) => buffer.destroy());
            const expectedViewDepth = (motion === "hole" ? 10 : 2) + view[14]!;
            const sourceX = (((motion === "hole" ? background : 4) + 0.5) / width) * 2 - 1;
            const expectedViewX = (kind === "orthographic" ? sourceX : (sourceX - projection[8]!) * (motion === "hole" ? 10 : 2)) + view[12]!;
            return {
                kind,
                motion,
                winner: integers[6]!,
                color: Array.from(floats.subarray(0, 4)),
                depth: floats[4]!,
                expectedDepth: (projection[2]! * expectedViewX + projection[10]! * expectedViewDepth + projection[14]!) / (projection[11]! * expectedViewDepth + projection[15]!),
                count: integers[5]! & 65535,
                errors: error ? [error.message] : [],
            };
        };
        const cases = [];
        for (const kind of ["finite", "infinite"] as const) {
            cases.push(await run(kind, "backward"));
        }
        for (const kind of ["finite", "infinite", "orthographic", "off-axis"] as const) {
            cases.push(await run(kind, "lateral"));
        }
        for (const kind of ["finite", "orthographic"] as const) {
            cases.push(await run(kind, "hole"));
        }
        for (const motion of ["invalid", "beyond-far", "out-of-range", "non-finite"] as const) {
            cases.push(await run("finite", motion));
        }
        await device.queue.onSubmittedWorkDone();
        device.destroy();
        return { cases, gpuErrors };
    });
    expect(errors).toEqual([]);
    expect(result.gpuErrors).toEqual([]);
    for (const entry of result.cases) {
        expect(entry.errors, `${entry.kind}/${entry.motion}`).toEqual([]);
        if (entry.motion !== "backward" && entry.motion !== "lateral" && entry.motion !== "hole") {
            expect(entry.winner).toBe(0);
            expect(entry.color).toEqual([0, 0, 0, 0]);
            expect(entry.depth).toBe(0);
            expect(entry.count).toBe(0);
        } else if (entry.motion === "hole") {
            expect(entry.winner, `${entry.kind}/${entry.motion}`).toBe(0);
            entry.color.forEach((value, index) => expect(value).toBeCloseTo(index % 2, 6));
            expect(entry.depth).toBeCloseTo(entry.expectedDepth, 6);
            expect(entry.count).toBe(6);
        } else {
            expect(entry.winner, `${entry.kind}/${entry.motion}`).toBe(5);
            expect(entry.color[0]).toBeCloseTo(1, 5);
            expect(entry.color[1]).toBeCloseTo(0, 5);
            expect(entry.color[3]).toBeCloseTo(1, 5);
            expect(entry.depth).toBeGreaterThan(0);
            expect(entry.depth).toBeLessThanOrEqual(1);
            expect(entry.depth).toBeCloseTo(entry.expectedDepth, 6);
            expect(entry.count).toBe(12);
        }
    }
});
