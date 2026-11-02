import { mkdir, readFile, writeFile, copyFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { PNG } from "pngjs";
import { captureDiligentInputs, readDiligentFrame, replayDiligentNative, diligentGrayscale } from "./diligent-reference.js";
import { DILIGENT_COMMIT, DILIGENT_CORE_COMMIT, prepareDiligentSources } from "./diligent-sources.js";
import { decodeWorldNormalHalf, halfToFloat, validateDiligentConfig } from "./diligent-contract.js";
import type { DiligentCaptureConfig } from "./diligent-contract.js";
import { sha256 } from "./sources.js";
import { fetchSsaoKitchen } from "../fetch-ssao-kitchen.js";

function transform(matrix: number[], x: number, y: number, z: number): number[] {
    const w = matrix[12]! * x + matrix[13]! * y + matrix[14]! * z + matrix[15]!;
    return [0, 1, 2].map((c) => (matrix[c * 4]! * x + matrix[c * 4 + 1]! * y + matrix[c * 4 + 2]! * z + matrix[c * 4 + 3]!) / w);
}

/** Full-resolution, original-HLSL replay. Recorded playback is not a GPU benchmark. */
export async function createKitchenReference(smoke = process.argv.includes("--smoke")): Promise<void> {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const cache = join(root, ".ao-reference-cache", "diligent");
    const config: DiligentCaptureConfig = smoke
        ? { scene: "kitchen", width: 320, height: 240, warmup: 8, travel: 4, hold: 4, step: 0.02 }
        : { scene: "kitchen", width: 960, height: 540, warmup: 32, travel: 24, hold: 8, step: 0.01 };
    validateDiligentConfig(config);
    await fetchSsaoKitchen();
    const assetDirectory = join(root, "lab", "public", "ssao-comparison");
    const asset = JSON.parse(await readFile(join(assetDirectory, "kitchen-source.json"), "utf8")) as { glbSha256: string; sourceTriangles: number; outputTriangles: number };
    if (asset.glbSha256 !== sha256(await readFile(join(assetDirectory, "kitchen.glb"))) || asset.sourceTriangles !== 536949 || asset.outputTriangles !== asset.sourceTriangles) {
        throw new Error("Kitchen asset does not match its verified source manifest.");
    }
    await mkdir(cache, { recursive: true });
    const disk = await statfs(cache);
    if (disk.bavail * disk.bsize < 2 * 1024 ** 3) {
        throw new Error("Kitchen native replay needs at least 2 GiB free.");
    }
    const shaders = join(cache, "shaders");
    await prepareDiligentSources(shaders);
    await copyFile(new URL("./diligent-diagnostic.fx", import.meta.url), join(shaders, "diligent-diagnostic.fx"));
    const id = `kitchen-${new Date().toISOString().replace(/[:.]/g, "-")}${smoke ? "-smoke" : ""}`;
    const run = join(cache, "runs", id);
    const captured = join(run, "capture");
    const sequence = await captureDiligentInputs(captured, config);
    const tasks = join(run, "tasks.tsv");
    await writeFile(
        tasks,
        [`diligent-temporal-v1\t${config.width}\t${config.height}`, ...sequence.frames.map((frame) => join(captured, `${frame.index.toString().padStart(4, "0")}.frame.gz`))].join(
            "\n"
        ) + "\n"
    );
    const native = join(run, "native");
    const repeat = join(run, "native-repeat");
    await replayDiligentNative(shaders, tasks, native);
    await replayDiligentNative(shaders, tasks, repeat);
    for (const directory of [native, repeat]) {
        const normals = (await readFile(join(directory, "normal-input-sha256.tsv"), "utf8")).trim().split("\n");
        if (normals.length !== sequence.frames.length || normals.some((line, i) => line !== `${i.toString().padStart(4, "0")}\t${sequence.frames[i]!.signedNormalSha256}`)) {
            throw new Error("Kitchen signed normal inputs differ between WebGPU and D3D11.");
        }
    }
    if (
        !sequence.signedNormalSha256 ||
        sequence.signedNormalSha256 !== sha256(await readFile(join(native, "normal-input.rgba16"))) ||
        sequence.signedNormalSha256 !== sha256(await readFile(join(repeat, "normal-input.rgba16")))
    ) {
        throw new Error("BLite and native Diligent did not consume identical signed RGBA16 world normals.");
    }
    const publicRoot = join(root, "lab", "public", "ao-temporal-reference");
    const destination = join(publicRoot, id);
    await mkdir(join(destination, "frames"), { recursive: true });
    let maxPositionError = 0,
        maxMotionError = 0,
        foreground = 0,
        occluded = 0;
    const frames: { index: number; phase: number; stage: string; cameraAngle: number; prefix: string }[] = [];
    for (const info of sequence.frames) {
        const frame = await readDiligentFrame(captured, sequence, info.index);
        const name = info.index.toString().padStart(4, "0");
        const actual = join(native, name);
        const repeated = join(repeat, name);
        const pixels = config.width * config.height;
        const color = gunzipSync(await readFile(join(captured, `${name}.color.gz`)), { maxOutputLength: pixels * 4 });
        if (color.length !== pixels * 4 || !info.colorHash || sha256(color) !== info.colorHash) {
            throw new Error("Kitchen common color frame is missing or changed after capture.");
        }
        const colorImage = new PNG({ width: config.width, height: config.height });
        colorImage.data.set(color);
        await writeFile(join(destination, "frames", `${name}-color.png`), PNG.sync.write(colorImage));
        const images: Record<string, Uint8Array> = {};
        for (const [label, offset] of [
            ["raw", frame.spatial],
            ["temporal", frame.accumulated],
            ["final", frame.final],
        ] as const) {
            const bytes = new Uint8Array(pixels);
            for (let p = 0; p < pixels; p++) {
                const value = halfToFloat(frame.bytes.readUInt16LE(offset + p * 2));
                if (!Number.isFinite(value) || value < 0 || value > 1) {
                    throw new Error("Captured Kitchen visibility is invalid.");
                }
                bytes[p] = Math.round(value * 255);
            }
            images[`blite-${label}`] = bytes;
        }
        for (const lane of ["native", "shared"]) {
            const history = await readFile(join(actual, `${lane}-history.r16`));
            if (history.length !== pixels * 2 || sha256(history) !== sha256(await readFile(join(repeated, `${lane}-history.r16`)))) {
                throw new Error("Kitchen native history is not deterministic.");
            }
            for (let p = 0; p < pixels; p++) {
                const age = halfToFloat(history.readUInt16LE(p * 2));
                if (!Number.isFinite(age) || age < 0) {
                    throw new Error("Kitchen native history age is invalid.");
                }
            }
            for (const stage of lane === "native" ? ["raw", "temporal", "final"] : ["temporal", "final"]) {
                const file = `${lane}-${stage}.u8`;
                const bytes = await readFile(join(actual, file));
                if (bytes.length !== pixels || sha256(bytes) !== sha256(await readFile(join(repeated, file)))) {
                    throw new Error(`Native Kitchen repeat mismatch: ${name}/${file}`);
                }
                images[`${lane}-${stage}`] = bytes;
            }
        }
        const positions = info.index === 0 ? await readFile(join(actual, "reconstructed-position.rgba32")) : null;
        const inverse = Array.from({ length: 16 }, (_, i) => frame.bytes.readFloatLE(16 + 112 + 5 * 64 + i * 4));
        const previousVP = Array.from({ length: 16 }, (_, i) => frame.bytes.readFloatLE(16 + 576 + 112 + 2 * 64 + i * 4));
        for (let p = 0; p < pixels; p++) {
            const depth = frame.bytes.readFloatLE(frame.depth + p * 4);
            if (!Number.isFinite(depth) || depth < 0 || depth > 1) {
                throw new Error("Kitchen depth is invalid.");
            }
            if (depth === 0) {
                if (images["blite-final"]![p] !== 255 || images["native-final"]![p] !== 255) {
                    throw new Error("Kitchen background AO is not neutral.");
                }
                continue;
            }
            foreground++;
            if (images["native-raw"]![p]! < 242) {
                occluded++;
            }
            const x = (2 * ((p % config.width) + 0.5)) / config.width - 1;
            const y = 1 - (2 * (Math.floor(p / config.width) + 0.5)) / config.height;
            const world = transform(inverse, x, y, depth);
            const old = transform(previousVP, world[0]!, world[1]!, world[2]!);
            if (![...world, ...old, frame.bytes.readFloatLE(frame.motion + p * 8), frame.bytes.readFloatLE(frame.motion + p * 8 + 4)].every(Number.isFinite)) {
                throw new Error("Kitchen position or motion is not finite.");
            }
            maxMotionError = Math.max(
                maxMotionError,
                Math.abs(x - old[0]! - frame.bytes.readFloatLE(frame.motion + p * 8)),
                Math.abs(y - old[1]! - frame.bytes.readFloatLE(frame.motion + p * 8 + 4))
            );
            if (positions) {
                for (let c = 0; c < 3; c++) {
                    const difference = Math.abs(positions.readFloatLE(p * 16 + c * 4) - frame.bytes.readFloatLE(frame.position + p * 16 + c * 4));
                    if (!Number.isFinite(difference)) {
                        throw new Error("Kitchen native reconstructed position is not finite.");
                    }
                    maxPositionError = Math.max(maxPositionError, difference);
                }
            }
            const normal = [0, 1, 2].map((c) => decodeWorldNormalHalf(frame.bytes.readUInt16LE(frame.normal + p * 8 + c * 2)));
            const length = Math.hypot(...normal);
            if (!Number.isFinite(length) || Math.abs(length - 1) > 0.01) {
                throw new Error("Kitchen captured normal is not a unit world normal.");
            }
        }
        for (const [label, bytes] of Object.entries(images)) {
            await writeFile(join(destination, "frames", `${name}-${label}.png`), diligentGrayscale(bytes, config.width, config.height));
        }
        frames.push({ index: info.index, phase: info.phase, stage: info.stage, cameraAngle: info.cameraAngle!, prefix: `frames/${name}-` });
    }
    if (maxPositionError > 0.002 || maxMotionError > 0.0005 || foreground < config.width * config.height || occluded < 100) {
        throw new Error(`Kitchen convention/coverage check failed: ${JSON.stringify({ maxPositionError, maxMotionError, foreground, occluded })}`);
    }
    const metadata = {
        schema: "diligent-kitchen-comparison-v2",
        sharedColorCaptured: true,
        conventionsValidated: true,
        upstream: DILIGENT_COMMIT,
        core: DILIGENT_CORE_COMMIT,
        asset,
        config,
        fov: sequence.fov,
        nativeRepeatExact: true,
        normalInputSha256: sequence.signedNormalSha256,
        allNormalInputsExact: true,
        maxPositionError,
        maxMotionError,
        foregroundSamples: foreground,
        occludedSamples: occluded,
        captureSources: sequence.captureSources,
        adapterHashes: Object.fromEntries(
            await Promise.all(
                ["diligent-native.cs", "diligent-native.ps1", "native.cs", "diligent-diagnostic.fx"].map(async (name) => [
                    name,
                    sha256(await readFile(new URL(name, import.meta.url))),
                ])
            )
        ),
        backend: await readFile(join(native, "backend.txt"), "utf8"),
        settings: { radius: 0.6, falloff: 0.615, radiusMultiplier: 1.457, mipOffset: 3.3, fullResolution: true, fullSceneTaa: false, displayGain: 1 },
        limitations: [
            "Recorded quality comparison, not rendering FPS or a native GPU benchmark.",
            "Original vertex colors with shared nonmetallic PBR shading, not Hydrogent material parity.",
            "The native lane uses original pinned HLSL. The shared-input lane isolates the original denoiser and is not a stock whole-pipeline result.",
        ],
        frames,
    };
    await writeFile(join(destination, "comparison.json"), JSON.stringify(metadata, null, 2));
    await writeFile(join(run, "summary.json"), JSON.stringify({ status: "complete", ...metadata }, null, 2));
    const template = await readFile(new URL("./kitchen-viewer.html", import.meta.url), "utf8");
    const viewer = template.replace("KITCHEN_COMPARISON_URL", `${id}/comparison.json`);
    await writeFile(join(publicRoot, smoke ? "kitchen-smoke.html" : "kitchen.html"), viewer);
    console.info(
        JSON.stringify({ viewer: `/ao-temporal-reference/${smoke ? "kitchen-smoke.html" : "kitchen.html"}`, run, maxPositionError, maxMotionError, frames: frames.length })
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    createKitchenReference().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
