import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import type { SgCase } from "./spec-gloss-fixture";

const cases: SgCase[] = [
    { name: "defaults" },
    { name: "diffuse factor", diffuseFactor: [0.052861, 0.138432, 0.052861, 0.8], specularFactor: [0.2, 0.5, 0.8] },
    { name: "diffuse texture", diffuse: true },
    { name: "diffuse product", diffuse: true, diffuseFactor: [0.052861, 0.138432, 0.052861, 0.8] },
    { name: "specular factor", specularFactor: [0.2, 0.5, 0.8] },
    { name: "specular texture", specular: true },
    { name: "legacy texture-only SG", specular: true, legacy: true },
    { name: "specular product", specular: true, specularFactor: [0.2, 0.5, 0.8] },
    { name: "glossiness factor", glossinessFactor: 0.3 },
    { name: "glossiness product", specular: true, glossinessFactor: 0.3 },
    { name: "combined", diffuse: true, specular: true, diffuseFactor: [0.3, 0.6, 0.9, 0.8], specularFactor: [0.2, 0.5, 0.8], glossinessFactor: 0.3 },
    { name: "fallback ignored", diffuseFactor: [0.3, 0.6, 0.9, 0.8], specularFactor: [0.2, 0.5, 0.8], glossinessFactor: 0.3, fallback: true },
    { name: "vertex color", diffuse: true, specular: true, diffuseFactor: [0.3, 0.6, 0.9, 0.8], specularFactor: [0.2, 0.5, 0.8], glossinessFactor: 0.3, vertexColor: true },
    {
        name: "UV transform and texCoord",
        diffuse: true,
        specular: true,
        diffuseFactor: [0.3, 0.6, 0.9, 0.8],
        specularFactor: [0.2, 0.5, 0.8],
        glossinessFactor: 0.3,
        transformed: true,
    },
    { name: "texCoord without transform extension", diffuse: true, specular: true, specularFactor: [0.2, 0.5, 0.8], uv1: true },
    { name: "MR control", mr: true },
    { name: "MR reflectance initializer then plugin", mr: true, animatedOcclusion: true, plugin: true },
    {
        name: "animated occlusion with SG",
        diffuse: true,
        specular: true,
        diffuseFactor: [0.3, 0.6, 0.9, 0.8],
        specularFactor: [0.2, 0.5, 0.8],
        glossinessFactor: 0.3,
        animatedOcclusion: true,
    },
    { name: "SG variant ignores MR fallback", fallback: true, variant: true, diffuseFactor: [0.3, 0.6, 0.9, 0.8], specularFactor: [0.2, 0.5, 0.8], glossinessFactor: 0.3 },
    { name: "plugin modifies initialized SG F0", specular: true, specularFactor: [0.2, 0.5, 0.8], glossinessFactor: 0.3, plugin: true },
    { name: "reflectance then SG then plugin", specular: true, specularFactor: [0.2, 0.5, 0.8], glossinessFactor: 0.3, animatedOcclusion: true, plugin: true },
    {
        name: "transformed reflectance then SG then plugin",
        specular: true,
        specularFactor: [0.2, 0.5, 0.8],
        glossinessFactor: 0.3,
        animatedOcclusion: true,
        plugin: true,
        reflectanceUv: true,
    },
    { name: "MASK discard", diffuse: true, diffuseFactor: [1, 1, 1, 0.4], alphaMode: "MASK" },
    { name: "MASK survives", diffuse: true, diffuseFactor: [1, 1, 1, 0.8], alphaMode: "MASK" },
    { name: "BLEND alpha once", diffuse: true, diffuseFactor: [1, 1, 1, 0.8], alphaMode: "BLEND" },
];

function linear(byte: number) {
    const x = byte / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

for (const c of cases) {
    test(`SG numerical conformance — ${c.name}`, async ({ page }) => {
        await page.goto(`http://localhost:${process.env.LAB_TEST_PORT ?? 5179}/`);
        const result = await page.evaluate(
            async ({ path, value }) => {
                const { runSgCase } = await import(/* @vite-ignore */ path);
                const adapter = await navigator.gpu.requestAdapter();
                if (!adapter) {
                    throw new Error("WebGPU required for numerical conformance");
                }
                const device = await adapter.requestDevice();
                const errors: string[] = [];
                device.addEventListener("uncapturederror", (e) => errors.push(e.error.message));
                try {
                    const result = await runSgCase(device, value);
                    await device.queue.onSubmittedWorkDone();
                    return { ...result, errors };
                } finally {
                    device.destroy();
                }
            },
            { path: `/@fs/${resolve("tests/lite/plumbing/spec-gloss-fixture.ts").replaceAll("\\", "/")}`, value: c }
        );
        expect(result.errors).toEqual([]);
        if (c.mr) {
            const d = [linear(218), linear(124), linear(170), 153 / 255];
            // Animated occlusion selects the real reflectance initializer and
            // uses the fixture's white G/B ORM sample: metallic=1, roughness=1.
            const expected = c.plugin
                ? [d, [d[0]! * 0.5, d[1]! * 0.5, d[2]! * 0.5, 0], [0, 0, 0, 1]]
                : [d, [...d.slice(0, 3).map((x) => 0.04 * 0.6 + x * 0.4), 0.2], [...d.slice(0, 3).map((x) => x * 0.96 * 0.6), 0.8]];
            expect(result.values[3][0]).toBeCloseTo(c.animatedOcclusion ? 1 + (64 / 255 - 1) * 0.4 : 1, 3);
            // The existing MR factor-only loader bakes factors into 8-bit sRGB.
            // Allow one UNORM step for that round trip and hardware sRGB conversion.
            for (let row = 0; row < 3; row++) {
                for (let col = 0; col < 4; col++) {
                    expect(Math.abs(result.values[row][col] - expected[row]![col]!)).toBeLessThan(1 / 255);
                }
            }
            return;
        }
        if (c.name === "MASK discard") {
            expect(result.values).toEqual([
                [-1, -1, -1, -1],
                [-1, -1, -1, -1],
                [-1, -1, -1, -1],
                [-1, -1, -1, -1],
            ]);
            return;
        }
        const d = (c.diffuse ? [linear(128), linear(64), linear(192), 128 / 255] : [1, 1, 1, 1]).map(
            (x, i) => x * (c.diffuseFactor?.[i] ?? 1) * (c.vertexColor ? [0.5, 0.25, 0.75, 0.5][i]! : 1)
        );
        const s = (c.specular ? [linear(64), linear(128), linear(192)] : [1, 1, 1]).map((x, i) => x * (c.specularFactor?.[i] ?? 1));
        const g = (c.specular ? 128 / 255 : 1) * (c.glossinessFactor ?? 1);
        // The plugin changes F0 after SG initializes surfaceAlbedo.
        expect(result.values[3][0]).toBeCloseTo(c.animatedOcclusion ? 1 + (64 / 255 - 1) * 0.4 : 1, 3);
        expect(result.values[3].slice(1)).toEqual([1, 1, 1]);
        const f0 = c.plugin ? s.map((x) => x * 0.5) : s;
        const expected = [d, [...f0, g], [...d.slice(0, 3).map((x) => x * (1 - Math.max(...s))), 1 - g]];
        for (let row = 0; row < 3; row++) {
            for (let col = 0; col < 4; col++) {
                expect(result.values[row][col], `${c.name} [${row},${col}]`).toBeCloseTo(expected[row]![col]!, 3);
            }
        }
    });
}
