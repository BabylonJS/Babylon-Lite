import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { createServer } from "vite";
import { PNG } from "pngjs";
import { prepareDiligentSources, DILIGENT_COMMIT, DILIGENT_CORE_COMMIT } from "./diligent-sources.js";
import { sha256 } from "./sources.js";
import { diligentFrameBytes, diligentFrameCount, DILIGENT_FRAME_MAGIC, halfToFloat, decodeWorldNormalHalf, validateDiligentConfig } from "./diligent-contract.js";
import type { DiligentCaptureConfig, DiligentCaptureFrame } from "./diligent-contract.js";
import type * as CaptureClient from "./diligent-capture-client.js";
import { diligentQualityProblems } from "./diligent-quality.js";
import { fetchSsaoKitchen } from "../fetch-ssao-kitchen.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CACHE = join(ROOT, ".ao-reference-cache", "diligent");

async function captureSourceHashes(config?: DiligentCaptureConfig): Promise<Record<string, string>> {
    const paths = [
        "scripts/ao-reference/diligent-capture-client.ts",
        "scripts/ao-reference/diligent-contract.ts",
        "packages/babylon-lite/src/material/pbr/pbr-geometry-renderable.ts",
        "packages/babylon-lite/src/post-process/ssao-temporal.ts",
        "packages/babylon-lite/src/post-process/ssao-diligent-gpu.ts",
        "packages/babylon-lite/src/post-process/ssao-diligent-wgsl.ts",
        "packages/babylon-lite/src/post-process/ssao-wgsl.ts",
    ];
    if (config?.scene === "kitchen") {
        // The capture page loads the same verified GLB.
        await fetchSsaoKitchen();
        paths.push(
            "lab/lite/src/shared/kitchen-scene.ts",
            "lab/public/ssao-comparison/kitchen.glb",
            "lab/public/ssao-comparison/kitchen-source.json",
            "scripts/ao-reference/diligent-normal-input.ts"
        );
    }
    return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, sha256(await readFile(join(ROOT, path)))] as const)));
}

interface CapturedSequence {
    schema: "diligent-temporal-capture-v1";
    config: DiligentCaptureConfig;
    fov: number;
    signedNormalSha256?: string;
    captureSources: Record<string, string>;
    frames: (DiligentCaptureFrame & { hash: string; meanHash?: string; colorHash?: string })[];
}

interface CapturedFrame {
    bytes: Buffer;
    depth: number;
    normal: number;
    motion: number;
    spatial: number;
    accumulated: number;
    final: number;
    position: number;
}

function decodeFrame(bytes: Buffer, config: DiligentCaptureConfig, index: number): CapturedFrame {
    if (
        bytes.length !== diligentFrameBytes(config, index) ||
        bytes.readUInt32LE(0) !== DILIGENT_FRAME_MAGIC ||
        bytes.readUInt32LE(4) !== index ||
        bytes.readUInt32LE(8) !== config.width ||
        bytes.readUInt32LE(12) !== config.height ||
        bytes.at(-1) !== 0x7f
    ) {
        throw new Error(`Invalid captured frame ${index}.`);
    }
    const pixels = config.width * config.height;
    const depth = 16 + 1152;
    const normal = depth + pixels * 4;
    const motion = normal + pixels * 8;
    const spatial = motion + pixels * 8;
    return { bytes, depth, normal, motion, spatial, accumulated: spatial + pixels * 2, final: spatial + pixels * 4, position: spatial + pixels * 6 };
}

async function readFrame(directory: string, sequence: CapturedSequence, index: number): Promise<CapturedFrame> {
    const bytes = gunzipSync(await readFile(join(directory, `${index.toString().padStart(4, "0")}.frame.gz`)), {
        maxOutputLength: diligentFrameBytes(sequence.config, index),
    });
    if (sha256(bytes) !== sequence.frames[index]!.hash) {
        throw new Error(`Captured frame ${index} changed after capture.`);
    }
    return decodeFrame(bytes, sequence.config, index);
}

async function capture(directory: string, config: DiligentCaptureConfig): Promise<CapturedSequence> {
    await mkdir(directory, { recursive: true });
    const captureSources = await captureSourceHashes(config);
    const hashes: string[] = [];
    const meanHashes: string[] = [];
    const colorHashes: string[] = [];
    const receive = async (request: IncomingMessage, response: ServerResponse, index: number, kind: "frame" | "mean" | "color"): Promise<void> => {
        const mean = kind === "mean";
        const color = kind === "color";
        const destinationHashes = color ? colorHashes : mean ? meanHashes : hashes;
        if (
            request.method !== "POST" ||
            index < 0 ||
            index >= diligentFrameCount(config) ||
            destinationHashes[index] ||
            (mean && !config.withReferenceMean) ||
            (color && config.scene !== "kitchen")
        ) {
            throw new Error("Unexpected or duplicate capture request.");
        }
        const parts: Buffer[] = [];
        let size = 0;
        for await (const part of request) {
            const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part as Uint8Array);
            size += buffer.length;
            if (size > (mean || color ? config.width * config.height * 4 : diligentFrameBytes(config, index)) + 65536) {
                throw new Error("Capture packet exceeds its exact size bound.");
            }
            parts.push(buffer);
        }
        const compressed = Buffer.concat(parts);
        const bytes = gunzipSync(compressed, { maxOutputLength: mean || color ? config.width * config.height * 4 : diligentFrameBytes(config, index) });
        if (mean) {
            if (bytes.length !== config.width * config.height * 4) {
                throw new Error("Invalid fixed-pose mean size.");
            }
            for (let i = 0; i < bytes.length; i += 4) {
                const value = bytes.readFloatLE(i);
                if (!Number.isFinite(value) || value < 0 || value > 1.000001) {
                    throw new Error("Invalid fixed-pose AO mean.");
                }
            }
        } else if (color) {
            if (bytes.length !== config.width * config.height * 4) {
                throw new Error("Invalid common color frame size.");
            }
        } else {
            decodeFrame(bytes, config, index);
        }
        await writeFile(join(directory, `${index.toString().padStart(4, "0")}.${kind}.gz`), compressed, { flag: "wx" });
        destinationHashes[index] = sha256(bytes);
        if (kind === "frame" && index % 16 === 0) {
            console.log(`Captured exact GPU frame ${index}/${diligentFrameCount(config)}.`);
        }
        response.end("saved");
    };
    const server = await createServer({
        configFile: false,
        root: ROOT,
        publicDir: false,
        logLevel: "error",
        optimizeDeps: { noDiscovery: true, include: [] },
        resolve: { alias: { "babylon-lite": join(ROOT, "packages", "babylon-lite", "src", "index.ts") } },
        server: { host: "127.0.0.1", port: 0 },
        plugins: [
            {
                name: "diligent-reference-capture",
                configureServer(instance) {
                    instance.middlewares.use((request, response, next) => {
                        if (request.url === "/diligent-capture") {
                            response.setHeader("Content-Type", "text/html");
                            response.end("<title>Diligent AO input capture</title><style>body{margin:0}</style>");
                            return;
                        }
                        const match = /^\/diligent-(frame|mean|color)\/(\d+)$/.exec(request.url ?? "");
                        if (!match) {
                            return next();
                        }
                        const kind = match[1];
                        if (kind !== "frame" && kind !== "mean" && kind !== "color") {
                            throw new Error("Invalid capture endpoint.");
                        }
                        void receive(request, response, Number(match[2]), kind).catch((error: unknown) => {
                            response.statusCode = 500;
                            response.end(String(error));
                        });
                    });
                },
            },
        ],
    });
    let browser: Browser | undefined;
    try {
        await server.listen();
        const address = server.httpServer!.address();
        if (!address || typeof address === "string") {
            throw new Error("Capture server did not bind.");
        }
        browser = await chromium.launch({ channel: "msedge", headless: true });
        const page = await browser.newPage({ viewport: { width: config.width, height: config.height } });
        await page.goto(`http://127.0.0.1:${address.port}/diligent-capture`);
        const result = await page.evaluate(async (config: DiligentCaptureConfig) => {
            const url = "/scripts/ao-reference/diligent-capture-client.ts";
            const client: typeof CaptureClient = await import(url);
            return client.captureDiligentSequence(config);
        }, config);
        if (hashes.filter(Boolean).length !== diligentFrameCount(config)) {
            throw new Error("The frame capture is incomplete.");
        }
        if (config.withReferenceMean && meanHashes.filter(Boolean).length !== diligentFrameCount(config)) {
            throw new Error("The fixed-pose reference means are incomplete.");
        }
        if (config.scene === "kitchen" && colorHashes.filter(Boolean).length !== diligentFrameCount(config)) {
            throw new Error("The shared color capture is incomplete.");
        }
        if (JSON.stringify(captureSources) !== JSON.stringify(await captureSourceHashes(config))) {
            throw new Error("Capture source changed while recording the sequence.");
        }
        const sequence: CapturedSequence = {
            schema: "diligent-temporal-capture-v1",
            config,
            fov: result.fov,
            signedNormalSha256: result.signedNormalSha256,
            captureSources,
            frames: result.frames.map((frame) => ({ ...frame, hash: hashes[frame.index]!, meanHash: meanHashes[frame.index], colorHash: colorHashes[frame.index] })),
        };
        await writeFile(join(directory, "capture.json"), JSON.stringify(sequence, null, 2));
        return sequence;
    } finally {
        await browser?.close();
        await server.close();
    }
}

async function runNative(shaders: string, tasks: string, output: string): Promise<void> {
    const args = [
        "-NoLogo",
        "-NoProfile",
        "-File",
        fileURLToPath(new URL("./diligent-native.ps1", import.meta.url)),
        "-ShaderDirectory",
        shaders,
        "-TasksFile",
        tasks,
        "-OutputDirectory",
        output,
    ];
    await new Promise<void>((done, reject) => {
        const child = spawn("pwsh", args, { cwd: ROOT, stdio: "inherit", windowsHide: true });
        child.once("error", reject);
        child.once("exit", (code) => (code === 0 ? done() : reject(new Error(`Native Diligent reference exited with ${code}.`))));
    });
}

function matrix(bytes: Buffer, offset: number): number[] {
    return Array.from({ length: 16 }, (_, i) => bytes.readFloatLE(offset + i * 4));
}

function transform(out: number[], m: number[], x: number, y: number, z: number): void {
    const w = m[12]! * x + m[13]! * y + m[14]! * z + m[15]!;
    for (let c = 0; c < 3; c++) {
        out[c] = (m[c * 4]! * x + m[c * 4 + 1]! * y + m[c * 4 + 2]! * z + m[c * 4 + 3]!) / w;
    }
}

export function grayscale(values: Uint8Array, width: number, height: number): Buffer {
    if (values.length !== width * height) {
        throw new Error("AO image size mismatch.");
    }
    const image = new PNG({ width, height });
    for (let i = 0; i < values.length; i++) {
        image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = values[i]!;
        image.data[i * 4 + 3] = 255;
    }
    return PNG.sync.write(image);
}

function halfImage(frame: CapturedFrame, offset: number, pixels: number): Uint8Array {
    const values = new Uint8Array(pixels);
    for (let i = 0; i < pixels; i++) {
        const value = halfToFloat(frame.bytes.readUInt16LE(offset + i * 2));
        if (!Number.isFinite(value) || value < 0 || value > 1) {
            throw new Error("Captured AO is outside its finite [0,1] contract.");
        }
        values[i] = Math.round(value * 255);
    }
    return values;
}

async function publish(run: string, captured: string, sequence: CapturedSequence, native: string, repeat: string, smoke: boolean): Promise<void> {
    const { width, height } = sequence.config;
    const pixels = width * height;
    const publicRoot = join(ROOT, "lab", "public", "ao-temporal-reference");
    const id = run.split(/[\\/]/).at(-1)!;
    const destination = join(publicRoot, id);
    const present = !process.argv.includes("--metrics-only");
    if (present) {
        await mkdir(join(destination, "frames"), { recursive: true });
    }
    let maxPositionError = 0;
    let maxMotionError = 0;
    let maxSphereNormalError = 0;
    let floorNormalSamples = 0;
    let sphereNormalSamples = 0;
    let foreground = 0;
    let occluded = 0;
    let backgroundMismatch = 0;
    let maxWarmHistory = 0;
    const bounds = { x: width, y: height, right: 0, bottom: 0 };
    const frameMetadata = [];
    const heldRawHashes = new Set<string>();
    const initialInputs = { blite: new Float64Array(pixels), native: new Float64Array(pixels), shared: new Float64Array(pixels), clipped: new Float64Array(pixels) };
    const lagProxy = Object.fromEntries(
        ["blite", "native", "shared", "clipped"].map((lane) => [lane, { meanExtraOcclusion: null as number | null, frame: null as number | null, samples: 0 }])
    );
    const held = new Map<string, { sum: Float64Array; squared: Float64Array; count: Uint16Array }>();
    for (const lane of ["blite", "native", "shared", "clipped"]) {
        held.set(lane, { sum: new Float64Array(pixels), squared: new Float64Array(pixels), count: new Uint16Array(pixels) });
    }
    const world = [0, 0, 0];
    const projected = [0, 0, 0];
    const qualityLanes = ["blite", "shared", "clipped"] as const;
    const quality = Object.fromEntries(qualityLanes.map((lane) => [lane, { flickerSquared: 0, residualSquared: 0, pairs: 0, pixels: 0, maximumExcessTrail: 0 }]));
    const previousResidual = Object.fromEntries(qualityLanes.map((lane) => [lane, new Float32Array(pixels)]));
    const previousFloor = new Uint8Array(pixels);
    const initialFloor = new Uint8Array(pixels);
    let initialMean: Buffer | undefined;
    let qualityTrailSamples = 0;
    for (let index = 0; index < sequence.frames.length; index++) {
        const frame = await readFrame(captured, sequence, index);
        const name = index.toString().padStart(4, "0");
        const upstream = join(native, name);
        const second = join(repeat, name);
        const raw = await readFile(join(upstream, "native-raw.u8"));
        const referenceMean = sequence.config.withReferenceMean ? gunzipSync(await readFile(join(captured, `${name}.mean.gz`)), { maxOutputLength: pixels * 4 }) : undefined;
        if (referenceMean && sha256(referenceMean) !== sequence.frames[index]!.meanHash) {
            throw new Error(`Fixed-pose mean ${index} changed after capture.`);
        }
        if (index === 0) {
            initialMean = referenceMean;
        }
        const images = {
            "blite-raw": halfImage(frame, frame.spatial, pixels),
            "blite-temporal": halfImage(frame, frame.accumulated, pixels),
            "blite-final": halfImage(frame, frame.final, pixels),
            "native-raw": raw,
            "native-temporal": await readFile(join(upstream, "native-temporal.u8")),
            "native-final": await readFile(join(upstream, "native-final.u8")),
            "shared-temporal": await readFile(join(upstream, "shared-temporal.u8")),
            "shared-final": await readFile(join(upstream, "shared-final.u8")),
            "clipped-temporal": await readFile(join(upstream, "clipped-temporal.u8")),
            "clipped-final": await readFile(join(upstream, "clipped-final.u8")),
        };
        for (const [key, image] of Object.entries(images)) {
            if (!key.startsWith("blite-") && sha256(image) !== sha256(await readFile(join(second, `${key}.u8`)))) {
                throw new Error(`Native output is not reproducible: ${name}/${key}.`);
            }
            if (present) {
                await writeFile(join(destination, "frames", `${name}-${key}.png`), grayscale(image, width, height));
            }
        }
        if (referenceMean && present) {
            const preview = new Uint8Array(pixels);
            for (let p = 0; p < pixels; p++) {
                preview[p] = Math.round(referenceMean.readFloatLE(p * 4) * 255);
            }
            await writeFile(join(destination, "frames", `${name}-reference.png`), grayscale(preview, width, height));
        }
        const positions = index === 0 ? await readFile(join(upstream, "reconstructed-position.rgba32")) : null;
        const history = await readFile(join(upstream, "native-history.r16"));
        const inverse = matrix(frame.bytes, 16 + 112 + 5 * 64);
        const previousProjection = matrix(frame.bytes, 16 + 576 + 112 + 2 * 64);
        const currentInfo = sequence.frames[index]!;
        if (currentInfo.stage === "hold") {
            heldRawHashes.add(sha256(raw));
        }
        const previousX = sequence.frames[Math.max(0, index - 1)]!.sphereX;
        const lagSum = { blite: 0, native: 0, shared: 0, clipped: 0 };
        const lagCount = { blite: 0, native: 0, shared: 0, clipped: 0 };
        const trailSum = { blite: 0, shared: 0, clipped: 0 };
        let spatialTrailSum = 0,
            trailPixels = 0;
        const settled = currentInfo.stage === "hold" && sequence.frames[Math.max(0, index - Math.max(2, Math.floor(sequence.config.hold / 2)))]?.stage === "hold";
        for (let p = 0; p < pixels; p++) {
            const wasFloor = previousFloor[p] !== 0;
            previousFloor[p] = 0;
            if (currentInfo.stage === "warmup") {
                initialInputs.blite[p] = initialInputs.blite[p]! + images["blite-raw"][p]! / (255 * sequence.config.warmup);
                initialInputs.shared[p] = initialInputs.blite[p]!;
                initialInputs.clipped[p] = initialInputs.blite[p]!;
                initialInputs.native[p] = initialInputs.native[p]! + raw[p]! / (255 * sequence.config.warmup);
            }
            const depth = frame.bytes.readFloatLE(frame.depth + p * 4);
            if (!Number.isFinite(depth) || depth < 0 || depth > 1) {
                throw new Error("Invalid captured depth.");
            }
            if (depth === 0) {
                if (images["native-final"][p] !== 255 || images["shared-final"][p] !== 255) {
                    backgroundMismatch++;
                }
                continue;
            }
            const x = p % width;
            const y = Math.floor(p / width);
            transform(world, inverse, (2 * (x + 0.5)) / width - 1, 1 - (2 * (y + 0.5)) / height, depth);
            foreground++;
            if (raw[p]! < 242) {
                occluded++;
            }
            if (positions) {
                for (let c = 0; c < 3; c++) {
                    const expected = frame.bytes.readFloatLE(frame.position + p * 16 + c * 4);
                    const actual = positions.readFloatLE(p * 16 + c * 4);
                    if (!Number.isFinite(actual)) {
                        throw new Error("Non-finite native position reconstruction.");
                    }
                    maxPositionError = Math.max(maxPositionError, Math.abs(expected - actual));
                }
            }
            const age = halfToFloat(history.readUInt16LE(p * 2));
            if (!Number.isFinite(age) || age < 1 || age > 16) {
                throw new Error("Invalid native history length.");
            }
            if (index === sequence.config.warmup - 1) {
                maxWarmHistory = Math.max(maxWarmHistory, age);
            }
            const nx = decodeWorldNormalHalf(frame.bytes.readUInt16LE(frame.normal + p * 8));
            const ny = decodeWorldNormalHalf(frame.bytes.readUInt16LE(frame.normal + p * 8 + 2));
            const nz = decodeWorldNormalHalf(frame.bytes.readUInt16LE(frame.normal + p * 8 + 4));
            const normalLength = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (normalLength < 0.99 || normalLength > 1.01) {
                throw new Error("Captured world normal is not unit length after decoding.");
            }
            const downwardNormal = ny < 0;
            const sphere = (world[1]! > 0.001 || downwardNormal) && Math.abs(world[2]!) < 0.8 && Math.abs(world[0]! - currentInfo.sphereX) < 0.8;
            if (sphere) {
                sphereNormalSamples++;
                const dx = world[0]! - currentInfo.sphereX;
                const dy = world[1]! - 0.75;
                const dz = world[2]!;
                const radialLength = Math.sqrt(dx * dx + dy * dy + dz * dz);
                maxSphereNormalError = Math.max(maxSphereNormalError, 1 - (nx * dx + ny * dy + nz * dz) / (radialLength * normalLength));
            } else if (Math.abs(world[1]!) < 0.001 && !(Math.abs(world[0]! + 1.8) < 0.401 && Math.abs(world[2]! + 1.5) < 0.401)) {
                floorNormalSamples++;
                if (Math.abs(nx) > 0.001 || ny < 0.999 || Math.abs(nz) > 0.001) {
                    throw new Error("Decoded floor normal is not world +Y.");
                }
            }
            const oldX = world[0]! - (sphere ? currentInfo.sphereX - previousX : 0);
            transform(projected, previousProjection, oldX, world[1]!, world[2]!);
            const expectedX = (2 * (x + 0.5)) / width - 1 - projected[0]!;
            const expectedY = 1 - (2 * (y + 0.5)) / height - projected[1]!;
            maxMotionError = Math.max(
                maxMotionError,
                Math.abs(expectedX - frame.bytes.readFloatLE(frame.motion + p * 8)),
                Math.abs(expectedY - frame.bytes.readFloatLE(frame.motion + p * 8 + 4))
            );
            const floor = Math.abs(world[1]!) < 0.001 && ny > 0.999 && (world[0]! - currentInfo.sphereX) ** 2 + world[2]! ** 2 < 2.25;
            if (floor) {
                if (index === 0) {
                    initialFloor[p] = 1;
                }
                if (referenceMean) {
                    const expected = referenceMean.readFloatLE(p * 4);
                    const currentSpatial = halfToFloat(frame.bytes.readUInt16LE(frame.spatial + p * 2));
                    const evaluateNoise = expected < 0.98 && currentInfo.stage !== "warmup";
                    const evaluateTrail = initialFloor[p] !== 0 && initialMean!.readFloatLE(p * 4) < 0.94 && expected - initialMean!.readFloatLE(p * 4) > 0.04;
                    if (evaluateTrail) {
                        spatialTrailSum += Math.max(0, expected - currentSpatial);
                        trailPixels++;
                    }
                    for (const lane of qualityLanes) {
                        const actual = lane === "blite" ? halfToFloat(frame.bytes.readUInt16LE(frame.final + p * 2)) : images[`${lane}-final`][p]! / 255;
                        const residual = actual - expected;
                        if (evaluateNoise) {
                            const stats = quality[lane]!;
                            stats.residualSquared += residual * residual;
                            stats.pixels++;
                            if (wasFloor) {
                                stats.flickerSquared += (residual - previousResidual[lane]![p]!) ** 2;
                                stats.pairs++;
                            }
                        }
                        previousResidual[lane]![p] = residual;
                        if (evaluateTrail) {
                            trailSum[lane] += Math.max(0, expected - actual);
                        }
                    }
                    previousFloor[p] = evaluateNoise ? 1 : 0;
                }
                bounds.x = Math.min(bounds.x, x);
                bounds.y = Math.min(bounds.y, y);
                bounds.right = Math.max(bounds.right, x);
                bounds.bottom = Math.max(bounds.bottom, y);
                if (currentInfo.stage !== "warmup" && currentInfo.sphereX > sequence.frames[0]!.sphereX + 0.04 && world[0]! < sequence.frames[0]!.sphereX) {
                    for (const lane of ["blite", "native", "shared", "clipped"] as const) {
                        if (initialInputs[lane][p]! >= 0.94) {
                            continue;
                        }
                        const incoming = lane === "native" ? raw[p]! : images["blite-raw"][p]!;
                        lagSum[lane] += (incoming - images[`${lane}-final`][p]!) / 255;
                        lagCount[lane]++;
                    }
                }
                if (settled) {
                    for (const [lane, stats] of held) {
                        const value = images[`${lane}-final` as keyof typeof images][p]! / 255;
                        stats.sum[p] = stats.sum[p]! + value;
                        stats.squared[p] = stats.squared[p]! + value * value;
                        stats.count[p] = stats.count[p]! + 1;
                    }
                }
            }
        }
        for (const lane of ["blite", "native", "shared", "clipped"] as const) {
            if (lagCount[lane] < (smoke ? 8 : 100)) {
                continue;
            }
            const mean = lagSum[lane] / lagCount[lane];
            const previous = lagProxy[lane]!;
            if (previous.meanExtraOcclusion === null || mean > previous.meanExtraOcclusion) {
                lagProxy[lane] = { meanExtraOcclusion: mean, frame: index, samples: lagCount[lane] };
            }
        }
        if (trailPixels >= (smoke ? 8 : 100)) {
            qualityTrailSamples += trailPixels;
            for (const lane of qualityLanes) {
                quality[lane]!.maximumExcessTrail = Math.max(quality[lane]!.maximumExcessTrail, (trailSum[lane] - spatialTrailSum) / trailPixels);
            }
        }
        if (index === 0) {
            if (!images["native-temporal"].equals(raw)) {
                throw new Error("Native first-frame reset did not select current AO.");
            }
            for (let p = 0; p < pixels; p++) {
                if (Math.abs(images["shared-temporal"][p]! - images["blite-raw"][p]!) > 1) {
                    throw new Error("Shared-input reset did not preserve the identical noisy AO.");
                }
                if (images["clipped-temporal"][p] !== images["shared-temporal"][p]) {
                    throw new Error("The clipping candidate changed first-frame initialization.");
                }
            }
        }
        frameMetadata.push({ ...currentInfo, prefix: `frames/${name}-` });
    }
    if (
        maxPositionError > 0.001 ||
        maxMotionError > 0.0002 ||
        maxSphereNormalError > 0.02 ||
        floorNormalSamples < 100 ||
        sphereNormalSamples < 100 ||
        foreground < pixels ||
        occluded < 100 ||
        backgroundMismatch ||
        maxWarmHistory < Math.min(8, sequence.config.warmup)
    ) {
        throw new Error(
            `Native reference convention/coverage validation failed: ${JSON.stringify({ maxPositionError, maxMotionError, maxSphereNormalError, foreground, occluded, backgroundMismatch, maxWarmHistory })}`
        );
    }
    if (heldRawHashes.size < Math.min(3, sequence.config.hold)) {
        throw new Error("Native AO sampling did not vary while geometry was held fixed.");
    }
    const heldFloorRms: Record<string, number> = {};
    for (const [lane, stats] of held) {
        let sum = 0;
        let count = 0;
        for (let p = 0; p < pixels; p++) {
            if (stats.count[p]! < 2) {
                continue;
            }
            const mean = stats.sum[p]! / stats.count[p]!;
            sum += Math.max(0, stats.squared[p]! / stats.count[p]! - mean * mean);
            count++;
        }
        if (!count) {
            throw new Error(`The held-floor measurement has no samples for ${lane}.`);
        }
        heldFloorRms[lane] = Math.sqrt(sum / count);
    }
    const crop = {
        x: Math.max(0, bounds.x - 12),
        y: Math.max(0, bounds.y - 48),
        width: Math.min(width, bounds.right + 12) - Math.max(0, bounds.x - 12),
        height: Math.min(height, bounds.bottom + 12) - Math.max(0, bounds.y - 48),
    };
    const sources = await readFile(new URL("./diligent-source-lock.json", import.meta.url), "utf8");
    const metadata = {
        schema: "diligent-ao-comparison-v1",
        conventionsValidated: true,
        upstream: DILIGENT_COMMIT,
        core: DILIGENT_CORE_COMMIT,
        sourceLockSha256: sha256(sources),
        adapterHashes: Object.fromEntries(
            await Promise.all(
                [
                    "scripts/ao-reference/native.cs",
                    "scripts/ao-reference/diligent-native.cs",
                    "scripts/ao-reference/diligent-native.ps1",
                    "scripts/ao-reference/diligent-diagnostic.fx",
                    "scripts/ao-reference/diligent-capture-client.ts",
                    "scripts/ao-reference/diligent-contract.ts",
                    "packages/babylon-lite/src/post-process/ssao-diligent-gpu.ts",
                    "packages/babylon-lite/src/post-process/ssao-diligent-wgsl.ts",
                ].map(async (path) => [path, sha256(await readFile(join(ROOT, path)))] as const)
            )
        ),
        backend: await readFile(join(native, "backend.txt"), "utf8"),
        config: sequence.config,
        fov: sequence.fov,
        fps: 60,
        nativeRepeatExact: true,
        distinctNativeHeldSamples: heldRawHashes.size,
        captureSources: sequence.captureSources,
        maxPositionError,
        maxMotionError,
        maxSphereNormalError,
        floorNormalSamples,
        sphereNormalSamples,
        generatedHostSha256: sha256(await readFile(join(CACHE, "shaders", "diligent-host-base.cs"))),
        normalEncoding: "Captured BLite WORLD_NORMAL = N*0.5+0.5; native upload decodes 2*value-1 into signed RGBA16F.",
        blitePipeline: "native-format-transport",
        candidate: {
            name: "Diligent-derived history variance clipping",
            maximumVarianceGamma: 0.5,
            guideCurrentWeight: 0.75,
            guide: "Geometry-rejected 3x3 taps with three-pixel spacing; current AO remains unblurred.",
            shaderHash: sha256(await readFile(join(CACHE, "shaders", "SSAO_ComputeTemporalAccumulation_Clipped.fx"))),
            upstreamReference: false,
        },
        quality: sequence.config.withReferenceMean
            ? Object.fromEntries(
                  qualityLanes.map((lane) => {
                      const stats = quality[lane]!;
                      if (!stats.pairs || !stats.pixels || !qualityTrailSamples) {
                          throw new Error(`No floor reference-mean coverage for ${lane}.`);
                      }
                      return [
                          lane,
                          {
                              floorFlickerRms: Math.sqrt(stats.flickerSquared / stats.pairs),
                              floorResidualRms: Math.sqrt(stats.residualSquared / stats.pixels),
                              maximumExcessTrail: stats.maximumExcessTrail,
                              pairs: stats.pairs,
                          },
                      ];
                  })
              )
            : null,
        heldFloorRms,
        departingFloorResidualProxy: lagProxy,
        departingFloorMinimumSamples: smoke ? 8 : 100,
        crop,
        smoke,
        frames: frameMetadata,
        settings: {
            radius: 0.6,
            falloff: 0.615,
            multiplier: 1.457,
            mipOffset: 3.3,
            temporalStability: 0.9,
            reconstructionRadius: 4,
            fullSceneTaa: false,
            nativeMaxHistory: 16,
            nativeAoFormat: "r8unorm",
            nativeHistoryFormat: "r16float",
            sharedInputFormat: "r16float",
            bliteMaxHistory: 16,
            bliteActiveHistoryCap: "Native geometric history age; resolution-aware blend only for transported stationary receivers",
            bliteAoFormat: "rgba16float",
        },
    };
    const problems = metadata.quality ? diligentQualityProblems(metadata.quality, heldFloorRms) : [];
    await writeFile(
        join(run, "summary.json"),
        JSON.stringify({ ...metadata, qualityAccepted: metadata.quality ? problems.length === 0 : null, qualityProblems: problems }, null, 2)
    );
    if (present && problems.length) {
        throw new Error(`AO quality rejected: ${problems.join(" ")}`);
    }
    if (present) {
        await writeFile(join(destination, "comparison.json"), JSON.stringify(metadata, null, 2));
        const template = await readFile(new URL("./diligent-viewer.html", import.meta.url), "utf8");
        await writeFile(join(publicRoot, smoke ? "smoke.html" : "index.html"), template.replace("COMPARISON_JSON_URL", `${id}/comparison.json`));
    }
    console.log(
        JSON.stringify(
            {
                maxPositionError,
                maxMotionError,
                nativeRepeatExact: true,
                heldFloorRms,
                quality: metadata.quality,
                departingFloorResidualProxy: lagProxy,
                viewer: `/ao-temporal-reference/${smoke ? "smoke.html" : "index.html"}`,
            },
            null,
            2
        )
    );
}

export async function createDiligentReference(): Promise<void> {
    const smoke = process.argv.includes("--smoke");
    const reuse = process.argv.indexOf("--reuse");
    if (reuse >= 0 && !process.argv[reuse + 1]) {
        throw new Error("--reuse requires the captured sequence directory.");
    }
    const config: DiligentCaptureConfig = smoke
        ? { width: 192, height: 144, warmup: 8, travel: 4, hold: 4, step: 0.02 }
        : { width: 668, height: 536, warmup: 32, travel: 32, hold: 16, step: 0.01 };
    config.withReferenceMean = process.argv.includes("--quality");
    validateDiligentConfig(config);
    await mkdir(CACHE, { recursive: true });
    const disk = await statfs(CACHE);
    if (disk.bavail * disk.bsize < 2 * 1024 ** 3) {
        throw new Error("The reference needs at least 2 GiB of free workspace disk space.");
    }
    const shaders = join(CACHE, "shaders");
    await prepareDiligentSources(shaders);
    await copyFile(new URL("./diligent-diagnostic.fx", import.meta.url), join(shaders, "diligent-diagnostic.fx"));
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}${smoke ? "-smoke" : ""}`;
    const run = join(CACHE, "runs", id);
    const captured = reuse >= 0 ? resolve(process.argv[reuse + 1] ?? "") : join(run, "capture");
    const sequence = reuse >= 0 ? (JSON.parse(await readFile(join(captured, "capture.json"), "utf8")) as CapturedSequence) : await capture(captured, config);
    validateDiligentConfig(sequence.config);
    if (sequence.schema !== "diligent-temporal-capture-v1" || sequence.frames.length !== diligentFrameCount(sequence.config)) {
        throw new Error("Invalid cached sequence metadata.");
    }
    if (JSON.stringify(sequence.captureSources) !== JSON.stringify(await captureSourceHashes())) {
        throw new Error("The cached sequence was captured from different BLite sources.");
    }
    await mkdir(run, { recursive: true });
    const tasks = join(run, "tasks.tsv");
    await writeFile(
        tasks,
        [
            `diligent-temporal-v1\t${sequence.config.width}\t${sequence.config.height}`,
            ...sequence.frames.map((frame) => join(captured, `${frame.index.toString().padStart(4, "0")}.frame.gz`)),
        ].join("\n") + "\n"
    );
    const native = join(run, "native");
    const repeat = join(run, "native-repeat");
    await runNative(shaders, tasks, native);
    await runNative(shaders, tasks, repeat);
    await publish(run, captured, sequence, native, repeat, smoke);
}

export { capture as captureDiligentInputs, readFrame as readDiligentFrame, runNative as replayDiligentNative, grayscale as diligentGrayscale };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void createDiligentReference().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
