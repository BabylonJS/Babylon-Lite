import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { SCENE348_ASSETS, SCENE348_CAMERAS, SCENE348_PANEL_SIZE, SCENE348_PANELS } from "../../../lab/lite/src/shared/scene348-parallax.js";
import { waitForCanvasReady } from "../parity/compare-utils";

test.use({ baseURL: `http://127.0.0.1:${process.env.LAB_TEST_PORT ?? 5179}` });

interface Scene348GpuState {
    devices: number;
    writes: { bufferSize: number; heightScale: number; min: number; max: number; refinement: number }[];
    errors: string[];
}

declare global {
    interface Window {
        /** @internal Test-only GPU submission tracing. */
        _scene348Gpu?: Scene348GpuState;
    }
}

async function traceScene348Gpu(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const state: Scene348GpuState = { devices: 0, writes: [], errors: [] };
        window._scene348Gpu = state;
        const requestDevice = GPUAdapter.prototype.requestDevice;
        GPUAdapter.prototype.requestDevice = async function (descriptor): Promise<GPUDevice> {
            const device = await requestDevice.call(this, descriptor);
            state.devices++;
            device.addEventListener("uncapturederror", (event) => state.errors.push((event as GPUUncapturedErrorEvent).error.message));
            return device;
        };
        const writeBuffer = GPUQueue.prototype.writeBuffer;
        GPUQueue.prototype.writeBuffer = function (...args: Parameters<GPUQueue["writeBuffer"]>): undefined {
            const [buffer, , source, offset = 0, size] = args;
            if ((buffer.usage & GPUBufferUsage.UNIFORM) !== 0 && source instanceof ArrayBuffer) {
                const length = size ?? source.byteLength - offset;
                if (offset % 4 === 0 && length % 4 === 0) {
                    const values = new Float32Array(source, offset, length / 4);
                    for (let i = 0; i <= values.length - 8; i++) {
                        if (
                            values[i + 1] === 0 &&
                            values[i + 2] === 0 &&
                            values[i + 3] === 0 &&
                            values[i + 4]! >= 1 &&
                            values[i + 4]! <= 64 &&
                            values[i + 5]! >= values[i + 4]! &&
                            values[i + 5]! <= 64 &&
                            values[i + 6]! >= 1 &&
                            values[i + 6]! <= 32 &&
                            values[i + 7] === 3
                        ) {
                            state.writes.push({
                                bufferSize: buffer.size,
                                heightScale: values[i]!,
                                min: values[i + 4]!,
                                max: values[i + 5]!,
                                refinement: values[i + 6]!,
                            });
                            if (state.writes.length > 100) {
                                state.writes.shift();
                            }
                        }
                    }
                }
            }
            return writeBuffer.call(this, ...args);
        };
    });
}

async function setLiveScene348Depth(page: Page, depth: string): Promise<void> {
    await page.locator('input[name="depth"]').evaluate((element, value) => {
        const input = element as HTMLInputElement;
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
    }, depth);
}

async function scene348Pose(canvas: Locator): Promise<[number, number, number]> {
    return canvas.evaluate((element) => {
        const data = (element as HTMLCanvasElement).dataset;
        return [Number(data.cameraAlpha), Number(data.cameraBeta), Number(data.cameraRadius)];
    });
}

async function captureScene(page: Page, url: string): Promise<PNG> {
    await page.goto(url);
    await waitForCanvasReady(page, { timeout: 30_000, label: url });
    await expect(page.locator("#loader-overlay")).toHaveCount(0);
    await expect(page.locator("canvas")).toHaveAttribute("data-draw-calls", "4");
    expect(await page.locator("html").getAttribute("data-gpu-error"), url).toBeNull();
    return PNG.sync.read(await page.locator("canvas").screenshot());
}

function panelDifference(actual: PNG, reference: PNG, panel: (typeof SCENE348_PANELS)[number]): number {
    expect(actual.width).toBe(reference.width);
    expect(actual.height).toBe(reference.height);
    const pixelsPerUnit = actual.height / (2 * SCENE348_CAMERAS.front.radius * Math.tan(0.4));
    const centerX = actual.width / 2 + panel.x * pixelsPerUnit;
    const centerY = actual.height / 2 - panel.y * pixelsPerUnit;
    const halfSize = (SCENE348_PANEL_SIZE * pixelsPerUnit) / 2 - 8;
    const x0 = Math.max(0, Math.ceil(centerX - halfSize));
    const x1 = Math.min(actual.width, Math.floor(centerX + halfSize));
    const y0 = Math.max(0, Math.ceil(centerY - halfSize));
    const y1 = Math.min(actual.height, Math.floor(centerY + halfSize));
    let difference = 0;
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            const offset = (y * actual.width + x) * 4;
            for (let channel = 0; channel < 3; channel++) {
                difference += Math.abs(actual.data[offset + channel]! - reference.data[offset + channel]!);
            }
        }
    }
    return difference / ((x1 - x0) * (y1 - y0) * 3);
}

for (const implementation of ["lite", "babylon"] as const) {
    for (const asset of ["stone", "wall"] as const) {
        test(`Scene 348 - ${implementation} ${asset} displaces both POM panels but neither control`, async ({ page }) => {
            await page.addInitScript(() => {
                const original = GPUDevice.prototype.createShaderModule;
                GPUDevice.prototype.createShaderModule = function (descriptor: GPUShaderModuleDescriptor): GPUShaderModule {
                    if (descriptor.code.includes("fn parallaxOcclusion(") || descriptor.code.includes("fn parallaxOffset(")) {
                        document.documentElement.dataset.pomShader = "true";
                    }
                    this.addEventListener(
                        "uncapturederror",
                        (event) => {
                            document.documentElement.dataset.gpuError = (event as GPUUncapturedErrorEvent).error.message;
                        },
                        { once: true }
                    );
                    return original.call(this, descriptor);
                };
            });
            const path = implementation === "lite" ? "/scene348.html" : "/babylon-ref-scene348.html";
            const off = await captureScene(page, `${path}?embed=1&view=front&pom=off&asset=${asset}`);
            const on = await captureScene(page, `${path}?embed=1&view=front&pom=on&asset=${asset}`);
            await expect(page.locator("html")).toHaveAttribute("data-pom-shader", "true");
            await expect(page.locator("canvas")).toHaveAttribute("data-color-texture", SCENE348_ASSETS[asset].color);
            await expect(page.locator("canvas")).toHaveAttribute("data-height-texture", SCENE348_ASSETS[asset].normalHeight);
            const zeroDepth = await captureScene(page, `${path}?embed=1&view=front&pom=on&depth=0&asset=${asset}`);
            for (const panel of SCENE348_PANELS) {
                const effect = panelDifference(on, off, panel);
                expect(effect, `${implementation}: ${panel.name}`).toBeGreaterThanOrEqual(0);
                if (panel.pom) {
                    expect(effect, `${implementation}: POM must visibly affect ${panel.family}`).toBeGreaterThan(0.5);
                } else {
                    expect(effect, `${implementation}: ${panel.family} control must remain unchanged`).toBeLessThan(0.01);
                }
                expect(panelDifference(zeroDepth, off, panel), `${implementation}: zero depth must disable displacement`).toBeLessThan(0.01);
            }
        });
    }
}

test("Scene 348 - both native POM variants move inset samples in the same UV direction", async ({ page }) => {
    const size = 256;
    const color = new PNG({ width: size, height: size });
    const normalHeight = new PNG({ width: size, height: size });
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const offset = (y * size + x) * 4;
            color.data.set([x, y, 64, 255], offset);
            normalHeight.data.set([128, 128, 255, 64], offset);
        }
    }
    // A UV ramp and constant height expose signed ray displacement independently
    // of the authored textures' relief, lighting detail, and sampling differences.
    await page.route(SCENE348_ASSETS.stone.color, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG.sync.write(color) }));
    await page.route(SCENE348_ASSETS.stone.normalHeight, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG.sync.write(normalHeight) }));
    for (const path of ["/scene348.html", "/babylon-ref-scene348.html"]) {
        const off = await captureScene(page, `${path}?embed=1&view=front&depth=0.16&pom=off`);
        const on = await captureScene(page, `${path}?embed=1&view=front&depth=0.16&pom=on`);
        const pixelsPerUnit = on.height / (2 * SCENE348_CAMERAS.front.radius * Math.tan(0.4));
        for (const panel of SCENE348_PANELS) {
            if (!panel.pom) {
                continue;
            }
            const centerX = Math.round(on.width / 2 + panel.x * pixelsPerUnit);
            const centerY = Math.round(on.height / 2 - panel.y * pixelsPerUnit);
            let redChange = 0;
            let greenChange = 0;
            for (let y = centerY - 1; y <= centerY + 1; y++) {
                for (let x = centerX - 1; x <= centerX + 1; x++) {
                    const offset = (y * on.width + x) * 4;
                    redChange += on.data[offset]! - off.data[offset]!;
                    greenChange += on.data[offset + 1]! - off.data[offset + 1]!;
                }
            }
            expect(redChange / 9, `${path}: ${panel.family} must sample farther along +U, not reverse the depth bias`).toBeGreaterThan(1);
            expect((greenChange / 9) * -Math.sign(panel.y), `${path}: ${panel.family} must preserve the inset V direction`).toBeGreaterThan(1);
        }
    }
});

test("Scene 348 - comparison settings and orbit state stay synchronized", async ({ page }) => {
    await page.goto("/lite/compare-scene348.html");
    const liteCanvas = page.frameLocator("#lite-frame").locator("canvas");
    const babylonCanvas = page.frameLocator("#babylon-frame").locator("canvas");
    await expect(liteCanvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(babylonCanvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(liteCanvas).toHaveAttribute("data-view", "grazing");
    await expect(babylonCanvas).toHaveAttribute("data-view", "grazing");
    await page.locator('select[name="asset"]').selectOption("wall");
    await expect(liteCanvas).toHaveAttribute("data-asset", "wall", { timeout: 30_000 });
    await expect(babylonCanvas).toHaveAttribute("data-asset", "wall", { timeout: 30_000 });
    await page.locator('select[name="view"]').selectOption("front");
    await expect(liteCanvas).toHaveAttribute("data-camera-alpha", String(SCENE348_CAMERAS.front.alpha));
    await expect(babylonCanvas).toHaveAttribute("data-camera-alpha", String(SCENE348_CAMERAS.front.alpha));
    await page.locator('select[name="view"]').selectOption("grazing");
    await expect(liteCanvas).toHaveAttribute("data-camera-alpha", String(SCENE348_CAMERAS.grazing.alpha));
    await expect(babylonCanvas).toHaveAttribute("data-camera-alpha", String(SCENE348_CAMERAS.grazing.alpha));
    await page.locator('input[name="depth"]').evaluate((element) => {
        const input = element as HTMLInputElement;
        input.value = "0.10";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await expect(liteCanvas).toHaveAttribute("data-depth", "0.1", { timeout: 30_000 });
    await expect(babylonCanvas).toHaveAttribute("data-depth", "0.1", { timeout: 30_000 });
    await expect(liteCanvas).toHaveAttribute("data-height-scale", String(SCENE348_PANEL_SIZE * 0.1));
    await expect(babylonCanvas).toHaveAttribute("data-parallax-scale-bias", "0.1");
    await expect(liteCanvas).toHaveAttribute("data-ready", "true");
    await expect(babylonCanvas).toHaveAttribute("data-ready", "true");

    for (const canvas of [liteCanvas, babylonCanvas]) {
        const previous = Number(await canvas.getAttribute("data-camera-alpha"));
        const bounds = await canvas.boundingBox();
        expect(bounds).not.toBeNull();
        await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
        await page.mouse.down();
        await page.mouse.move(bounds!.x + bounds!.width / 2 - 80, bounds!.y + bounds!.height / 2 + 10, { steps: 8 });
        await page.mouse.up();
        await expect.poll(async () => Math.abs(Number(await canvas.getAttribute("data-camera-alpha")) - previous)).toBeGreaterThan(0.02);
        await expect
            .poll(async () => Math.abs(Number(await liteCanvas.getAttribute("data-camera-alpha")) - Number(await babylonCanvas.getAttribute("data-camera-alpha"))))
            .toBeLessThan(0.0001);
    }
});

test("Scene 348 - live comparison controls preserve documents, devices, canvases, and the custom camera", async ({ page }) => {
    await traceScene348Gpu(page);
    let documents = 0;
    page.on("request", (request) => {
        if (request.resourceType() === "document") {
            documents++;
        }
    });
    await page.goto("/lite/compare-scene348.html");
    const canvases = [page.frameLocator("#lite-frame").locator("canvas"), page.frameLocator("#babylon-frame").locator("canvas")];
    for (const canvas of canvases) {
        await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
        await canvas.evaluate((element) => {
            (element as HTMLCanvasElement).dataset.testIdentity = "persistent";
        });
    }
    const initialDocuments = documents;
    const initialTimeOrigins = await Promise.all(canvases.map((canvas) => canvas.evaluate(() => performance.timeOrigin)));
    const bounds = (await canvases[0]!.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 - 90, bounds.y + bounds.height / 2 + 30, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => Math.abs((await scene348Pose(canvases[0]!))[0] - SCENE348_CAMERAS.grazing.alpha)).toBeGreaterThan(0.02);
    await expect.poll(async () => Math.abs((await scene348Pose(canvases[0]!))[0] - (await scene348Pose(canvases[1]!))[0])).toBeLessThan(0.0001);
    const customPose = await scene348Pose(canvases[0]!);

    await setLiveScene348Depth(page, "0.10");
    for (const canvas of canvases) {
        await expect(canvas).toHaveAttribute("data-depth", "0.1");
        await expect(canvas).toHaveAttribute("data-updating", "false");
    }
    await page.locator('select[name="quality"]').selectOption("high");
    for (const canvas of canvases) {
        await expect(canvas).toHaveAttribute("data-quality", "high");
        await expect(canvas).toHaveAttribute("data-updating", "false");
    }
    // Inspect actual submitted feature UBO data, not only the toolbar metadata:
    // Standard has its own 64-byte buffer; PBR appends the fields to its material UBO.
    await expect
        .poll(async () =>
            canvases[0]!.evaluate(() => {
                const state = window._scene348Gpu;
                if (!state) {
                    throw new Error("Scene348 GPU tracing was not installed.");
                }
                const writes = state.writes.filter((write) => Math.abs(write.heightScale - 0.24) < 0.00001 && write.min === 16 && write.max === 64 && write.refinement === 16);
                return writes.some((write) => write.bufferSize === 64) && writes.some((write) => write.bufferSize > 64);
            })
        )
        .toBe(true);
    await page.locator('select[name="asset"]').selectOption("wall");
    for (const canvas of canvases) {
        await expect(canvas).toHaveAttribute("data-asset", "wall", { timeout: 30_000 });
        await expect(canvas).toHaveAttribute("data-updating", "false");
    }
    await page.locator('select[name="pom"]').selectOption("off");
    for (const canvas of canvases) {
        await expect(canvas).toHaveAttribute("data-pom", "off");
        await expect(canvas).toHaveAttribute("data-updating", "false");
    }
    await page.locator('input[name="depth"]').evaluate((element) => {
        const input = element as HTMLInputElement;
        for (const value of ["0.11", "0.13", "0.16", "0"]) {
            input.value = value;
            input.dispatchEvent(new Event("input", { bubbles: true }));
        }
    });
    for (const canvas of canvases) {
        await expect(canvas).toHaveAttribute("data-depth", "0");
        await expect(canvas).toHaveAttribute("data-updating", "false");
    }
    await page.locator('select[name="pom"]').selectOption("on");
    await setLiveScene348Depth(page, "0.10");
    for (let i = 0; i < canvases.length; i++) {
        const canvas = canvases[i]!;
        await expect(canvas).toHaveAttribute("data-pom", "on");
        await expect(canvas).toHaveAttribute("data-depth", "0.1");
        await expect(canvas).toHaveAttribute("data-updating", "false");
        await expect(canvas).toHaveAttribute("data-test-identity", "persistent");
        expect(await canvas.evaluate(() => performance.timeOrigin)).toBe(initialTimeOrigins[i]);
        const pose = await scene348Pose(canvas);
        for (let component = 0; component < 3; component++) {
            expect(pose[component]).toBeCloseTo(customPose[component]!, 6);
        }
        const gpu = await canvas.evaluate(() => {
            if (!window._scene348Gpu) {
                throw new Error("Scene348 GPU tracing was not installed.");
            }
            return window._scene348Gpu;
        });
        expect(gpu.devices).toBe(1);
        expect(gpu.errors).toEqual([]);
    }
    expect(documents).toBe(initialDocuments);
    expect(new URL(page.url()).searchParams.get("depth")).toBe("0.1");
    expect(new URL(page.url()).searchParams.get("quality")).toBe("high");
});

for (const route of ["/scene348.html", "/babylon-ref-scene348.html", "/bundle-scene348.html", "/bundle-bjs-scene348.html"]) {
    test(`Scene 348 - standalone live controls do not reload ${route}`, async ({ page }) => {
        if (route.startsWith("/bundle-")) {
            const file = route.includes("bjs") ? "bjs-scene348.js" : "scene348.js";
            test.skip(!existsSync(resolve(__dirname, "..\\..\\..\\lab\\public\\bundle", file)), "Build the scene348 production bundles before checking their controls.");
        }
        await page.goto(route);
        const canvas = page.locator("canvas");
        await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
        await expect(canvas).toHaveAttribute("data-view", "grazing");
        await canvas.evaluate((element) => {
            (element as HTMLCanvasElement).dataset.testIdentity = "standalone";
        });
        const timeOrigin = await page.evaluate(() => performance.timeOrigin);
        await page.locator('select[name="quality"]').selectOption("low");
        await setLiveScene348Depth(page, "0.12");
        await expect(canvas).toHaveAttribute("data-quality", "low");
        await expect(canvas).toHaveAttribute("data-depth", "0.12");
        await expect(canvas).toHaveAttribute("data-updating", "false");
        await expect(canvas).toHaveAttribute("data-test-identity", "standalone");
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    });
}

test("Scene 348 - live controls chosen before renderer readiness are retained", async ({ page }) => {
    await page.route(SCENE348_ASSETS.stone.normalHeight, async (route) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        await route.continue();
    });
    await page.goto("/lite/compare-scene348.html", { waitUntil: "domcontentloaded" });
    await page.locator('select[name="quality"]').selectOption("low");
    await setLiveScene348Depth(page, "0.10");
    for (const frame of ["#lite-frame", "#babylon-frame"]) {
        const canvas = page.frameLocator(frame).locator("canvas");
        await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
        await expect(canvas).toHaveAttribute("data-quality", "low");
        await expect(canvas).toHaveAttribute("data-depth", "0.1");
        await expect(canvas).toHaveAttribute("data-updating", "false");
    }
});

test("Scene 348 - production bundles preserve both native source renders", async ({ page }) => {
    const bundleDirectory = resolve(__dirname, "..\\..\\..\\lab\\public\\bundle");
    test.skip(
        !existsSync(resolve(bundleDirectory, "scene348.js")) || !existsSync(resolve(bundleDirectory, "bjs-scene348.js")),
        "Build scene348,bjs-scene348 before checking their production render output."
    );
    for (const [source, bundle] of [
        ["/scene348.html", "/bundle-scene348.html"],
        ["/babylon-ref-scene348.html", "/bundle-bjs-scene348.html"],
    ]) {
        const reference = await captureScene(page, `${source}?embed=1`);
        const actual = await captureScene(page, `${bundle}?embed=1`);
        expect(actual.width).toBe(reference.width);
        expect(actual.height).toBe(reference.height);
        expect(actual.data, `${bundle} must preserve the source scene's pixels`).toEqual(reference.data);
    }
});
