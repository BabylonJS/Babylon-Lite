import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import type * as Lite from "../../../packages/babylon-lite/src/index.js";

const moduleUrl = `/@fs/${resolve("packages", "babylon-lite", "src", "index.ts").replace(/\\/g, "/")}`;

for (const samples of [1, 4] as const) {
    for (const utilityFirst of [false, true]) {
        test(`utility layers preserve scene and text pixels at MSAA ${samples}, utility-first=${utilityFirst}`, async ({ page }) => {
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(`http://localhost:${process.env.LAB_TEST_PORT ?? 5179}/`);
            await page.setContent('<canvas width="400" height="300" style="width:400px;height:300px"></canvas>');
            const result = await page.evaluate(
                async ({ moduleUrl, samples, utilityFirst }) => {
                    const lite = (await import(moduleUrl)) as typeof Lite;
                    const canvas = document.querySelector("canvas")!;
                    const engine = await lite.createEngine(canvas, { msaaSamples: samples, maxDevicePixelRatio: 1 });
                    const gpuErrors: string[] = [];
                    engine._device.addEventListener("uncapturederror", (event) => gpuErrors.push(event.error.message));
                    const main = lite.createSceneContext(engine);
                    main.clearColor = { r: 0.2, g: 0.3, b: 0.4, a: 1 };
                    main.camera = lite.createFreeCamera({ x: 0, y: 0, z: -8 }, { x: 0, y: 0, z: 0 });
                    const first = lite.createUtilityLayer(main, { addDefaultLight: false });
                    const nested = lite.createUtilityLayer(first.scene, { addDefaultLight: false });
                    const second = lite.createUtilityLayer(main, { addDefaultLight: false });
                    const box = (scene: Lite.SceneContext, x: number, color: [number, number, number], size: number): Lite.Mesh => {
                        const mesh = lite.createBox(engine, size);
                        mesh.position.set(x, 0, 0);
                        const material = lite.createStandardMaterial();
                        material.diffuseColor = [0, 0, 0];
                        material.emissiveColor = color;
                        mesh.material = material;
                        lite.addToScene(scene, mesh);
                        return mesh;
                    };
                    box(main, 0, [0, 0, 1], 3);
                    const red = box(first.scene, -1.1, [1, 0, 0], 1.4);
                    const yellow = box(nested.scene, 0, [1, 1, 0], 0.8);
                    const green = box(second.scene, 1.1, [0, 1, 0], 1.4);
                    lite.setMeshVisible(red, false);
                    lite.setMeshVisible(yellow, false);
                    lite.setMeshVisible(green, false);
                    const font = await lite.loadFont("/fonts/Inter.ttf");
                    const text = lite.createTextRenderer(engine, {
                        clear: false,
                        layers: [
                            lite.createTextLayer(lite.createDefaultTextData(font, 40, "OVERLAY TEXT", [1, 1, 1, 1]), {
                                positionPx: { x: 24, y: 130 },
                            }),
                        ],
                    });
                    try {
                        if (utilityFirst) {
                            await lite.registerUtilityLayer(nested);
                            await lite.registerUtilityLayer(first);
                        }
                        await lite.registerScene(main);
                        lite.registerTextRenderer(text);
                        await lite.startEngine(engine);
                        const baseline = await lite.captureScreenshot(engine);
                        await lite.registerUtilityLayer(first);
                        lite.setMeshVisible(red, true);
                        const single = await lite.captureScreenshot(engine);
                        await lite.registerUtilityLayer(nested);
                        lite.setMeshVisible(yellow, true);
                        await lite.registerUtilityLayer(second);
                        lite.setMeshVisible(green, true);
                        const multiple = await lite.captureScreenshot(engine);
                        lite.unregisterScene(main);
                        await lite.registerScene(main);
                        const restored = await lite.captureScreenshot(engine);
                        const summarize = (shot: Lite.Screenshot) => {
                            let textPixels = 0;
                            let preservedTextPixels = 0;
                            let redPixels = 0;
                            let yellowPixels = 0;
                            let greenPixels = 0;
                            let bluePixels = 0;
                            for (let i = 0; i < shot.data.length; i += 4) {
                                const [r, g, b] = [shot.data[i]!, shot.data[i + 1]!, shot.data[i + 2]!];
                                // Only opaque glyph interiors stay identical when the color beneath anti-aliased edges changes.
                                if (baseline.data[i] === 255 && baseline.data[i + 1] === 255 && baseline.data[i + 2] === 255) {
                                    textPixels++;
                                    if (r === baseline.data[i] && g === baseline.data[i + 1] && b === baseline.data[i + 2]) {
                                        preservedTextPixels++;
                                    }
                                }
                                if (r > 200 && g < 30 && b < 30) {
                                    redPixels++;
                                }
                                if (g > 200 && r < 30 && b < 30) {
                                    greenPixels++;
                                }
                                if (r > 200 && g > 200 && b < 30) {
                                    yellowPixels++;
                                }
                                if (b > 200 && r < 30 && g < 30) {
                                    bluePixels++;
                                }
                            }
                            const corner = (8 * shot.width + 8) * 4;
                            return {
                                textPixels,
                                preservedTextPixels,
                                redPixels,
                                yellowPixels,
                                greenPixels,
                                bluePixels,
                                background: Array.from(shot.data.slice(corner, corner + 4)),
                                baselineBackground: Array.from(baseline.data.slice(corner, corner + 4)),
                            };
                        };
                        await engine._device.queue.onSubmittedWorkDone();
                        return {
                            single: summarize(single),
                            multiple: summarize(multiple),
                            restored: summarize(restored),
                            order: lite.getRenderingContexts(engine).map((context) => {
                                if (context === main) {
                                    return "main";
                                }
                                if (context === first.scene) {
                                    return "first";
                                }
                                if (context === nested.scene) {
                                    return "nested";
                                }
                                if (context === second.scene) {
                                    return "second";
                                }
                                return lite.getRenderingContextKind(context);
                            }),
                            gpuErrors,
                        };
                    } finally {
                        lite.disposeTextRenderer(text);
                        lite.disposeUtilityLayer(nested);
                        lite.disposeUtilityLayer(first);
                        lite.disposeUtilityLayer(second);
                        lite.disposeScene(main);
                        lite.disposeEngine(engine);
                    }
                },
                { moduleUrl, samples, utilityFirst }
            );
            for (const shot of [result.single, result.multiple, result.restored]) {
                expect(shot.textPixels).toBeGreaterThan(200);
                expect(shot.preservedTextPixels).toBe(shot.textPixels);
                expect(shot.redPixels).toBeGreaterThan(200);
                expect(shot.bluePixels).toBeGreaterThan(200);
                expect(shot.background).toEqual(shot.baselineBackground);
                expect(shot.background.slice(0, 3).every((channel) => channel > 30)).toBe(true);
            }
            expect(result.multiple.greenPixels).toBeGreaterThan(200);
            expect(result.multiple.yellowPixels).toBeGreaterThan(200);
            expect(result.restored.greenPixels).toBeGreaterThan(200);
            expect(result.restored.yellowPixels).toBeGreaterThan(200);
            expect(result.single.greenPixels).toBe(0);
            expect(result.single.yellowPixels).toBe(0);
            expect(result.order).toEqual(["main", "first", "nested", "second", "text-renderer"]);
            expect(result.gpuErrors).toEqual([]);
            expect(errors).toEqual([]);
        });
    }

    test(`a former overlay clears when it becomes the base scene at MSAA ${samples}`, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://localhost:${process.env.LAB_TEST_PORT ?? 5179}/`);
        await page.setContent('<canvas width="64" height="64" style="width:64px;height:64px"></canvas>');
        const result = await page.evaluate(
            async ({ moduleUrl, samples }) => {
                const lite = (await import(moduleUrl)) as typeof Lite;
                const canvas = document.querySelector("canvas")!;
                const engine = await lite.createEngine(canvas, { msaaSamples: samples, maxDevicePixelRatio: 1 });
                const gpuErrors: string[] = [];
                engine._device.addEventListener("uncapturederror", (event) => gpuErrors.push(event.error.message));
                const first = lite.createSceneContext(engine);
                first.clearColor = { r: 1, g: 0, b: 0, a: 1 };
                first.camera = lite.createFreeCamera({ x: 0, y: 0, z: -8 }, { x: 0, y: 0, z: 0 });
                const main = lite.createSceneContext(engine);
                main.clearColor = { r: 0, g: 0, b: 1, a: 1 };
                main.camera = lite.createFreeCamera({ x: 0, y: 0, z: -8 }, { x: 0, y: 0, z: 0 });
                let utility: Lite.UtilityLayer | undefined;
                try {
                    await lite.registerScene(first);
                    await lite.registerScene(main);
                    utility = lite.createUtilityLayer(main, { addDefaultLight: false });
                    await lite.registerUtilityLayer(utility);
                    await lite.startEngine(engine);
                    const before = await lite.captureScreenshot(engine);
                    lite.unregisterScene(main);
                    lite.unregisterScene(first);
                    await lite.registerScene(main);
                    const after = await lite.captureScreenshot(engine);
                    lite.unregisterScene(main);
                    lite.unregisterScene(utility.scene);
                    await lite.registerScene(first);
                    await lite.registerScene(main);
                    lite.unregisterScene(main);
                    lite.unregisterScene(first);
                    await lite.registerScene(main);
                    const afterAlone = await lite.captureScreenshot(engine);
                    await engine._device.queue.onSubmittedWorkDone();
                    return {
                        before: Array.from(before.data.slice(0, 4)),
                        after: Array.from(after.data.slice(0, 4)),
                        afterAlone: Array.from(afterAlone.data.slice(0, 4)),
                        gpuErrors,
                    };
                } finally {
                    if (utility) {
                        lite.disposeUtilityLayer(utility);
                    }
                    lite.disposeScene(main);
                    lite.disposeScene(first);
                    lite.disposeEngine(engine);
                }
            },
            { moduleUrl, samples }
        );
        expect(result.before[0]).toBeGreaterThan(200);
        expect(result.before[2]).toBeLessThan(30);
        expect(result.after[0]).toBeLessThan(30);
        expect(result.after[2]).toBeGreaterThan(200);
        expect(result.afterAlone[0]).toBeLessThan(30);
        expect(result.afterAlone[2]).toBeGreaterThan(200);
        expect(result.gpuErrors).toEqual([]);
        expect(errors).toEqual([]);
    });

    test(`ordinary overlays retarget after their base scene changes at MSAA ${samples}`, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://localhost:${process.env.LAB_TEST_PORT ?? 5179}/`);
        await page.setContent('<canvas width="64" height="64" style="width:64px;height:64px"></canvas>');
        const result = await page.evaluate(
            async ({ moduleUrl, samples }) => {
                const lite = (await import(moduleUrl)) as typeof Lite;
                const canvas = document.querySelector("canvas")!;
                const engine = await lite.createEngine(canvas, { msaaSamples: samples, maxDevicePixelRatio: 1 });
                const gpuErrors: string[] = [];
                engine._device.addEventListener("uncapturederror", (event) => gpuErrors.push(event.error.message));
                const first = lite.createSceneContext(engine);
                const replacement = lite.createSceneContext(engine);
                const overlay = lite.createSceneContext(engine);
                const camera = lite.createFreeCamera({ x: 0, y: 0, z: -8 }, { x: 0, y: 0, z: 0 });
                first.camera = replacement.camera = overlay.camera = camera;
                first.clearColor = { r: 1, g: 0, b: 0, a: 1 };
                replacement.clearColor = { r: 0, g: 0, b: 1, a: 1 };
                const box = lite.createBox(engine, 2);
                const material = lite.createStandardMaterial();
                material.diffuseColor = [0, 0, 0];
                material.emissiveColor = [0, 1, 0];
                box.material = material;
                lite.addToScene(overlay, box);
                try {
                    await lite.registerScene(first);
                    await lite.registerScene(overlay);
                    await lite.startEngine(engine);
                    const before = await lite.captureScreenshot(engine);
                    lite.unregisterScene(overlay);
                    lite.unregisterScene(first);
                    await lite.registerScene(replacement);
                    await lite.registerScene(overlay);
                    const after = await lite.captureScreenshot(engine);
                    await engine._device.queue.onSubmittedWorkDone();
                    const pixel = (shot: Lite.Screenshot, x: number, y: number) => Array.from(shot.data.slice((y * shot.width + x) * 4, (y * shot.width + x + 1) * 4));
                    return {
                        beforeBackground: pixel(before, 0, 0),
                        beforeOverlay: pixel(before, 32, 32),
                        afterBackground: pixel(after, 0, 0),
                        afterOverlay: pixel(after, 32, 32),
                        gpuErrors,
                    };
                } finally {
                    lite.disposeScene(overlay);
                    lite.disposeScene(first);
                    lite.disposeScene(replacement);
                    lite.disposeEngine(engine);
                }
            },
            { moduleUrl, samples }
        );
        expect(result.beforeBackground[0]).toBeGreaterThan(200);
        expect(result.beforeBackground[2]).toBeLessThan(30);
        expect(result.afterBackground[0]).toBeLessThan(30);
        expect(result.afterBackground[2]).toBeGreaterThan(200);
        for (const pixel of [result.beforeOverlay, result.afterOverlay]) {
            expect(pixel[0]).toBeLessThan(30);
            expect(pixel[1]).toBeGreaterThan(200);
            expect(pixel[2]).toBeLessThan(30);
        }
        expect(result.gpuErrors).toEqual([]);
        expect(errors).toEqual([]);
    });
}
