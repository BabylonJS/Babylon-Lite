import { resolve } from "node:path";
import { expect, test } from "../parity/parity-fixtures";
import type * as Probe from "./fixtures/mesh-lod-pbr.js";
import type * as Winding from "./fixtures/mesh-lod-winding.js";

test("production MeshLoD and ordinary PBR agree on metallic lighting and roughness/AA float outputs", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(
        async (url) => {
            const { createMeshLoDPbrProbe } = (await import(url)) as typeof Probe;
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                throw new Error("WebGPU adapter unavailable");
            }
            const device = await adapter.requestDevice();
            let probe: Awaited<ReturnType<typeof createMeshLoDPbrProbe>> | undefined;
            try {
                device.pushErrorScope("validation");
                probe = await createMeshLoDPbrProbe(device);
                const cases: Probe.MeshLoDPbrCase[] = [
                    { roughness: 0, specularAA: false, varyingNormals: false, lightType: "hemispheric" },
                    { roughness: 0.02, specularAA: false, varyingNormals: false, lightType: "hemispheric" },
                    { roughness: 0.4, specularAA: false, varyingNormals: false, lightType: "hemispheric" },
                    { roughness: 0.02, specularAA: false, varyingNormals: false, lightType: "directional" },
                    { roughness: 0.02, specularAA: false, varyingNormals: true, lightType: "hemispheric" },
                    { roughness: 0.02, specularAA: true, varyingNormals: true, lightType: "hemispheric" },
                ];
                const outputs = [];
                for (const options of cases) {
                    outputs.push(await probe.read(options));
                }
                const error = await device.popErrorScope();
                if (error) {
                    throw new Error(error.message);
                }
                return outputs;
            } finally {
                probe?.dispose();
                device.destroy();
            }
        },
        `/@fs/${resolve(__dirname, "fixtures", "mesh-lod-pbr.ts").replaceAll("\\", "/")}`
    );
    for (const output of result) {
        expect(output.ordinary[0]).toBeGreaterThan(0);
        for (let component = 0; component < 4; component++) {
            expect(Number.isFinite(output.meshLoD[component])).toBe(true);
            expect(output.meshLoD[component]).toBeCloseTo(output.ordinary[component]!, 5);
        }
    }
    expect(result[0]!.ordinary[0]).not.toBeCloseTo(result[1]!.ordinary[0]!, 4);
    expect(result[4]!.ordinary[0]).not.toBeCloseTo(result[5]!.ordinary[0]!, 3);
});

for (const [doubleSided, cone] of [
    [false, false],
    [false, true],
    [true, true],
] as const) {
    test(`production MeshLoD preserves mixed-handed winding and runtime reflections (double-sided=${doubleSided}, cone=${cone})`, async ({ page }) => {
        await page.goto("/");
        const outputs = await page.evaluate(
            async ({ url, doubleSided, cone }) => {
                const { createMeshLoDWindingProbe } = (await import(url)) as typeof Winding;
                const canvas = document.createElement("canvas");
                canvas.width = 64;
                canvas.height = 32;
                const probe = await createMeshLoDWindingProbe(canvas, doubleSided, cone);
                try {
                    const results = [];
                    for (const mode of ["cpu", "gpu"] as const) {
                        for (const flipped of [false, true, false]) {
                            results.push(await probe.read(mode, flipped));
                            results.push(await probe.read(mode, flipped, true));
                        }
                    }
                    return results;
                } finally {
                    await probe.dispose();
                }
            },
            { url: `/@fs/${resolve(__dirname, "fixtures", "mesh-lod-winding.ts").replaceAll("\\", "/")}`, doubleSided, cone }
        );
        outputs.forEach((output, index) => {
            if (index % 2 === 0 || doubleSided || !cone) {
                expect(output.draws).toBe(1);
            }
            for (const sample of output.samples) {
                if (index % 2 === 0) {
                    expect(sample[0]).toBeGreaterThan(0.8);
                    expect(sample[3]).toBe(1);
                } else {
                    expect(sample[0]).toBeLessThan(0.01);
                    expect(sample[3]).toBe(doubleSided ? 1 : 0);
                }
            }
        });
    });
}
