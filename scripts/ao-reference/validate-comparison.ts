import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { createServer } from "vite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EngineContext, GeometryRendererTask, SsaoTask, createSurfaceRenderTargetTexture } from "babylon-lite";
import type { BaselineAoTask } from "ssao-comparison-baseline";
import type { DiligentTemporalGpu } from "../../packages/babylon-lite/src/post-process/ssao-diligent-gpu.js";
import { SSAO_BASELINE } from "../../lab/lite/src/shared/ssao-comparison-contract.js";
import type { ComparisonAlgorithm, ComparisonMode } from "../../lab/lite/src/shared/ssao-comparison-contract.js";
import { temporalValidationLaunchOptions } from "./temporal-validation-options.js";

interface ComparisonObservation {
    engine: EngineContext;
    current: SsaoTask;
    existing: BaselineAoTask;
    geometry: GeometryRendererTask | null;
    color: ReturnType<typeof createSurfaceRenderTargetTexture>;
    currentRelay: ReturnType<typeof createSurfaceRenderTargetTexture>;
    existingRelay: ReturnType<typeof createSurfaceRenderTargetTexture>;
    readonly temporalOwner: DiligentTemporalGpu | null;
    errors: string[];
    calls: Record<string, number>;
    capture: { buffer: GPUBuffer; pitch: number } | null;
    stop(): void;
    frame(): void;
}

interface DisplayCase {
    mode: ComparisonMode;
    algorithm: ComparisonAlgorithm;
    aoOnly: boolean;
    intensity: number;
    divider: number;
}

interface FrameResult extends DisplayCase {
    width: number;
    height: number;
    darkPixels: number;
    maxCompositorError: number;
    movingPixels: number;
    calls: Record<string, number>;
}

interface PresetResult {
    preset: string;
    options: string;
    modes: FrameResult[];
    lit: FrameResult;
    attenuated: FrameResult;
    resized: FrameResult;
    animated?: FrameResult;
    compact?: FrameResult;
}

async function captureComparisonFrame(display: DisplayCase): Promise<FrameResult> {
    const state = (window as Window & { ssaoComparisonValidation?: ComparisonObservation }).ssaoComparisonValidation;
    if (!state) {
        throw new Error("Comparison observation seam is missing.");
    }
    state.stop();
    const device = state.engine._device;
    if (
        state.current.depthTexture !== state.color.rt ||
        state.existing.depthTexture !== state.color.rt ||
        (state.geometry && state.geometry.geometryDepthTexture !== state.color.rt)
    ) {
        throw new Error("Algorithms do not share the actual depth target.");
    }
    for (let frame = 0; frame < 64; frame++) {
        state.frame();
    }
    const { width, height } = state.engine.canvas;
    for (const target of [state.color, state.currentRelay, state.existingRelay]) {
        if (target.rt._width !== width || target.rt._height !== height) {
            throw new Error("Comparison inputs and presentation relays must follow the actual canvas dimensions.");
        }
    }
    const context = state.engine.canvas.getContext("webgpu");
    const configuration = context?.getConfiguration();
    if (!context || !configuration) {
        throw new Error("Comparison canvas has no configured WebGPU context.");
    }
    // Readback is test-only; the shipped demo keeps the normal swapchain usage.
    context.configure({ ...configuration, usage: configuration.usage | GPUTextureUsage.COPY_SRC });
    const read = async (texture: GPUTexture | null, stride: number): Promise<Uint8Array<ArrayBuffer>> => {
        if (!texture) {
            throw new Error("Comparison readback texture is missing.");
        }
        const pitch = Math.ceil((texture.width * stride) / 256) * 256;
        const buffer = device.createBuffer({ size: pitch * texture.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        try {
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: pitch }, [texture.width, texture.height]);
            device.queue.submit([encoder.finish()]);
            await buffer.mapAsync(GPUMapMode.READ);
            const mapped = new Uint8Array(buffer.getMappedRange());
            const bytes = new Uint8Array(texture.width * texture.height * stride);
            for (let y = 0; y < texture.height; y++) {
                bytes.set(mapped.subarray(y * pitch, y * pitch + texture.width * stride), y * texture.width * stride);
            }
            return bytes;
        } finally {
            buffer.destroy();
        }
    };
    const pitch = Math.ceil((width * 4) / 256) * 256;
    const output = device.createBuffer({ size: pitch * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    let displayed: Uint8Array<ArrayBuffer>;
    try {
        device.pushErrorScope("validation");
        state.capture = { buffer: output, pitch };
        state.calls = {};
        try {
            state.frame();
        } finally {
            state.capture = null;
        }
        const captureError = await device.popErrorScope();
        if (captureError) {
            throw new Error(captureError.message);
        }
        await output.mapAsync(GPUMapMode.READ);
        displayed = new Uint8Array(output.getMappedRange()).slice();
    } finally {
        output.destroy();
    }
    const currentBytes = await read(state.currentRelay.rt._colorTexture, 8);
    const existingBytes = await read(state.existingRelay.rt._colorTexture, 8);
    const colorBytes = display.aoOnly ? null : await read(state.color.rt._colorTexture, 4);
    const currentView = new DataView(currentBytes.buffer);
    const existingView = new DataView(existingBytes.buffer);
    const half = (bits: number): number => {
        const exponent = (bits >> 10) & 31;
        const mantissa = bits & 1023;
        const sign = bits & 32768 ? -1 : 1;
        if (exponent === 31) {
            return mantissa ? NaN : sign * Infinity;
        }
        return sign * (exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24);
    };
    let dark = 0;
    let maxError = 0;
    let worst: { x: number; y: number; channel: number; actual: number; expected: number; useCurrent: boolean } | null = null;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (display.mode === "split" && Math.abs((x + 0.5) / width - display.divider) < 1 / width) {
                continue;
            }
            const useCurrent = display.mode === "split" ? (x + 0.5) / width < display.divider : display.algorithm === "current";
            const value = half((useCurrent ? currentView : existingView).getUint16((y * width + x) * 8, true));
            const visibility = useCurrent ? value : 1 - value;
            if (!Number.isFinite(visibility) || visibility < 0 || visibility > 1) {
                throw new Error("Comparison visibility is invalid.");
            }
            const strength = 1 - Math.min(1, Math.max(0, (1 - visibility) * display.intensity * (useCurrent ? 1 : 3)));
            for (let channel = 0; channel < 3; channel++) {
                const expected = colorBytes ? (colorBytes[(y * width + x) * 4 + channel]! / 255) * strength : strength;
                const actual = displayed[y * pitch + x * 4 + channel]! / 255;
                const error = Math.abs(actual - expected);
                if (error > maxError) {
                    maxError = error;
                    worst = { x, y, channel, actual, expected, useCurrent };
                }
            }
            if (visibility < 0.98) {
                dark++;
            }
        }
    }
    if (maxError > 1 / 255 + 0.001) {
        throw new Error(
            `Common compositor changed polarity, UVs, intensity or color: ${JSON.stringify({ display, maxError, worst, format: state.color.rt._colorTexture?.format, errors: state.errors })}`
        );
    }
    if (dark < 16) {
        throw new Error("Comparison did not exercise nonzero AO.");
    }
    const currentActive = display.mode === "split" || display.algorithm === "current";
    const existingActive = display.mode === "split" || display.algorithm === "existing";
    const geometryActive = currentActive && !!state.geometry;
    if (currentActive) {
        const reduced =
            document.querySelector<HTMLSelectElement>("#reconstruction")!.value === "half" &&
            document.querySelector<HTMLInputElement>("#half")!.checked &&
            width >= 320 &&
            height >= 224;
        const expectedWidth = reduced ? Math.ceil(width / 2) : width;
        const expectedHeight = reduced ? Math.ceil(height / 2) : height;
        if (
            state.current._gpu?.width !== expectedWidth ||
            state.current._gpu.height !== expectedHeight ||
            state.current.outputTexture._width !== width ||
            state.current.outputTexture._height !== height
        ) {
            throw new Error("AO working dimensions or public output do not match the selected reconstruction mode.");
        }
        if (state.temporalOwner) {
            for (const texture of [...state.temporalOwner.history, ...state.temporalOwner.counts, state.temporalOwner.geometry]) {
                if (texture.width !== expectedWidth || texture.height !== expectedHeight) {
                    throw new Error("Temporal history did not follow the selected reconstruction resolution.");
                }
            }
        }
    }
    const expectedCalls = {
        "ao-xegtao": currentActive,
        "ao-pr839": existingActive,
        "inputs-xegtao": geometryActive,
        "inputs-existing": !geometryActive,
        "present-xegtao-relay": currentActive,
        "present-pr839-relay": existingActive,
        "present-common-composite": true,
    };
    for (const [name, active] of Object.entries(expectedCalls)) {
        if ((state.calls[name] ?? 0) !== Number(active)) {
            throw new Error(`Incorrect execution selection for ${name}: ${JSON.stringify(state.calls)}`);
        }
    }
    let movingPixels = 0;
    if (geometryActive && state.geometry?.geometryLinearVelocityTexture) {
        const velocityTexture = state.geometry.geometryLinearVelocityTexture._colorTexture!;
        // The demo uses the engine's RGBA16F default; FP32 velocity remains supported by the reader.
        const halfVelocity = velocityTexture.format === "rgba16float";
        const stride = halfVelocity ? 8 : 16;
        const bytes = await read(velocityTexture, stride);
        const view = new DataView(bytes.buffer);
        const component = (i: number, c: number): number => (halfVelocity ? half(view.getUint16(i * 8 + c * 2, true)) : view.getFloat32(i * 16 + c * 4, true));
        for (let i = 0; i < width * height; i++) {
            if (Math.abs(component(i, 0)) + Math.abs(component(i, 1)) > 1e-6) {
                if (component(i, 2) <= 0) {
                    throw new Error("Animated receiver velocity lost previous view depth.");
                }
                movingPixels++;
            }
        }
    }
    if (state.errors.length) {
        throw new Error(state.errors.join("\n"));
    }
    return { ...display, width, height, darkPixels: dark, maxCompositorError: maxError, movingPixels, calls: state.calls };
}

/** Bounded native-GPU contracts, not screenshot parity or a timing benchmark. */
export async function validateSsaoComparison(generateThumbnail = process.argv.includes("--thumbnail")): Promise<void> {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const directory = resolve(root, ".ao-reference-cache", "ssao-comparison");
    await mkdir(directory, { recursive: true });
    const sourceHtml = await readFile(resolve(root, "lab", "lite", "demo-ssao-comparison.html"), "utf8");
    const html = sourceHtml.replace('src="/lite/bundle/demos/ssao-comparison.js"', 'src="/bundle/demos/ssao-comparison.js"');
    const code = await readFile(resolve(root, "lab", "public", "bundle", "demos", "ssao-comparison.js"), "utf8");
    const marker = "await startEngine(engine);";
    const registration = "await registerScene(scene);";
    if (code.split(marker).length !== 2 || code.split(registration).length !== 2 || !code.includes("function _renderFrame(") || !code.includes("function resizeEngine(")) {
        throw new Error("Build the comparison with --debug before validation.");
    }
    const observed = code
        .replace(
            registration,
            `globalThis.__comparisonGpuErrors=[];engine._device.addEventListener("uncapturederror",event=>globalThis.__comparisonGpuErrors.push(event.error.message));
let observedTemporal=null;if(temporal){const previous=temporal._prepareGpu;temporal._prepareGpu=(owner,velocity)=>{previous?.(owner,velocity);observedTemporal=owner;};}${registration}`
        )
        .replace(
            marker,
            `
const check=globalThis.ssaoComparisonValidation={engine,current,existing,geometry,color,currentRelay,existingRelay,get temporalOwner(){return observedTemporal;},errors:globalThis.__comparisonGpuErrors,calls:{},capture:null,stop:()=>stopEngine(engine),frame:()=>{resizeEngine(engine);_renderFrame(engine,16);}};
for(const task of [colorTask,geometry,current,existing,copyCurrent,copyExisting,compositor].filter(Boolean)){
const execute=task.execute;
task.execute=()=>{check.calls[task.name]=(check.calls[task.name]??0)+1;if(execute)return execute.call(task);let draws=0;for(const pass of task._passes)draws+=pass._execute();return draws;};
}
const present=compositor.execute;
compositor.execute=()=>{const draws=present();if(check.capture){engine._currentEncoder.copyTextureToBuffer({texture:engine.scRT._colorTexture},{buffer:check.capture.buffer,bytesPerRow:check.capture.pitch},[engine.canvas.width,engine.canvas.height]);}return draws;};
${marker}`
        );
    const server = await createServer({
        root: resolve(root, "lab"),
        configFile: false,
        publicDir: resolve(root, "lab", "public"),
        logLevel: "error",
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { host: "127.0.0.1", port: 0 },
        plugins: [
            {
                name: "ssao-comparison-check",
                configureServer(instance) {
                    instance.middlewares.use("/comparison-check", (_request, response) => {
                        response.setHeader("Content-Type", "text/html");
                        response.end(html);
                    });
                },
            },
        ],
    });
    let browser: Browser | undefined;
    const results: PresetResult[] = [];
    try {
        await server.listen();
        const address = server.httpServer?.address();
        if (!address || typeof address === "string") {
            throw new Error("Comparison validation server did not bind.");
        }
        browser = await chromium.launch(temporalValidationLaunchOptions(false));
        for (const [preset, options] of [
            ["contacts", ""],
            ["layers", ""],
            ["motion", ""],
            ["cornell", ""],
            ["contacts", "&temporal=0&normals=0&half=0"],
            ["contacts", "&normals=0"],
            ["contacts", "&temporal=0"],
            ["contacts", "&reconstruction=half"],
            ["contacts", "&reconstruction=half&temporal=0&normals=0"],
            ["contacts", "&reconstruction=half&normals=0"],
            ["contacts", "&reconstruction=half&temporal=0"],
            ["layers", "&reconstruction=half"],
            ["cornell", "&reconstruction=half"],
            ["motion", "&reconstruction=half"],
        ]) {
            const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(String(error)));
            page.on("response", (response) => {
                if (response.status() >= 400) {
                    errors.push(`HTTP ${response.status()}: ${response.url()}`);
                }
            });
            await page.addInitScript("globalThis.__name=value=>value;");
            await page.route("**/bundle/demos/ssao-comparison.js", (route) => route.fulfill({ contentType: "text/javascript", body: observed }));
            try {
                await page.goto(`http://127.0.0.1:${address.port}/comparison-check?scene=${preset}${options}`);
                await page.waitForFunction(() => document.querySelector("canvas")?.dataset.ready === "true" || !!document.querySelector("canvas")?.dataset.error);
                const startup = await page.locator("canvas").getAttribute("data-error");
                if (startup) {
                    throw new Error(startup);
                }
                if ((await page.locator("#intensity").inputValue()) !== "0.5") {
                    throw new Error("Comparison did not start at intensity 0.5.");
                }
                if (preset === "contacts" && !options) {
                    await page.locator("#mode").selectOption("single");
                    for (const algorithm of ["current", "existing"]) {
                        await page.locator("#algorithm").selectOption(algorithm);
                        await page.waitForFunction((algorithm) => {
                            const text = document.getElementById("timingValues")!.textContent ?? "";
                            const task = algorithm === "current" ? "ao-xegtao:" : "ao-pr839:";
                            return (text.includes("total:") && text.includes(task)) || text.includes("GPU timestamp queries unsupported.");
                        }, algorithm);
                        const text = await page.locator("#timingValues").innerText();
                        if (text.includes("total:")) {
                            const rows = [...text.matchAll(/^(.+): ([0-9.]+) ms$/gm)];
                            const total = rows.find((row) => row[1] === "total");
                            const tasks = rows.filter((row) => row[1] !== "total");
                            const sum = tasks.reduce((value, row) => value + Number(row[2]), 0);
                            if (!total || !tasks.length || Math.abs(Number(total[2]) - sum) > 0.0005 * (tasks.length + 1) + 1e-9) {
                                throw new Error(`GPU timing total does not sum the displayed task averages: ${text}`);
                            }
                        }
                    }
                }
                if (await page.locator("#animate").isChecked()) {
                    await page.locator("#animate").uncheck();
                }
                await page.locator("#reset").click();
                const check = async (mode: ComparisonMode, algorithm: ComparisonAlgorithm, aoOnly = true, intensity = 0.5, divider = 0.5) => {
                    await page.locator("#mode").selectOption(mode);
                    await page.locator("#algorithm").selectOption(algorithm);
                    await page.locator("#aoOnly").setChecked(aoOnly);
                    for (const [id, value] of [
                        ["intensity", intensity],
                        ["divider", divider],
                    ] as const) {
                        await page.locator(`#${id}`).evaluate((element: HTMLInputElement, value) => {
                            element.value = String(value);
                            element.dispatchEvent(new Event("input", { bubbles: true }));
                        }, value);
                    }
                    return page.evaluate(captureComparisonFrame, { mode, algorithm, aoOnly, intensity, divider });
                };
                const modes = [await check("split", "current"), await check("single", "current"), await check("single", "existing")];
                const lit = await check("split", "current", false, 1, 0.37);
                const attenuated = await check("split", "current", true, 0.35);
                await page.setViewportSize({ width: 901, height: 653 });
                const resized = await check("split", "current");
                if (resized.width !== 901 || resized.height !== 653) {
                    throw new Error("Comparison did not resize to the requested dimensions.");
                }
                const result: PresetResult = { preset: preset!, options: options!, modes, lit, attenuated, resized };
                if (preset === "motion") {
                    await page.locator("#animate").check();
                    result.animated = await check("split", "current");
                    if (result.animated.movingPixels < 16) {
                        throw new Error("Motion scene did not produce moving-receiver velocity.");
                    }
                }
                if (preset === "contacts" && !options) {
                    await page.setViewportSize({ width: 319, height: 223 });
                    result.compact = await check("split", "current");
                    if (result.compact.width !== 319 || result.compact.height !== 223) {
                        throw new Error("Comparison did not resize below the Half safeguard.");
                    }
                    if (generateThumbnail) {
                        await page.setViewportSize({ width: 1280, height: 720 });
                        await check("split", "current");
                        await page.evaluate(() => {
                            for (const selector of [".controls", ".timings", "#status"]) {
                                document.querySelector<HTMLElement>(selector)!.style.display = "none";
                            }
                        });
                        const thumbnail = await page.screenshot({ path: resolve(root, "lab", "public", "thumbnails", "demo-ssao-comparison.jpg"), type: "jpeg", quality: 60 });
                        if (thumbnail.length >= 1_000_000) {
                            throw new Error("Comparison thumbnail exceeds the request screenshot size limit.");
                        }
                    }
                }
                if (errors.length) {
                    throw new Error(errors.join("\n"));
                }
                results.push(result);
                console.info(JSON.stringify(result));
            } finally {
                await page.close();
            }
        }
        await writeFile(resolve(directory, "native.json"), JSON.stringify({ status: "complete", baseline: SSAO_BASELINE, results }, null, 2));
    } catch (error) {
        await writeFile(resolve(directory, "native.json"), JSON.stringify({ status: "failed", baseline: SSAO_BASELINE, results, error: String(error) }, null, 2));
        throw error;
    } finally {
        await Promise.all([browser?.close(), server.close()]);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    validateSsaoComparison().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
