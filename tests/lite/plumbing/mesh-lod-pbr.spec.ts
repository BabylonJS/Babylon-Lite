import { resolve } from "node:path";
import { expect, test } from "../parity/parity-fixtures";
import type * as Probe from "./fixtures/mesh-lod-pbr.js";

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
