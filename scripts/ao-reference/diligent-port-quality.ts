import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { decodeWorldNormalHalf, halfToFloat } from "./diligent-contract.js";
import type { DiligentCaptureConfig, DiligentCaptureFrame } from "./diligent-contract.js";
import { grayscale } from "./diligent-reference.js";

async function evaluate(): Promise<void> {
    const run = resolve(process.argv[2] ?? "");
    const capturedFinal = process.argv.includes("--captured-final");
    const previousIndex = process.argv.indexOf("--previous");
    if (previousIndex >= 0 && !process.argv[previousIndex + 1]) {
        throw new Error("--previous requires an exact earlier capture directory.");
    }
    const previousCapture = previousIndex >= 0 ? resolve(process.argv[previousIndex + 1]!) : undefined;
    const tasks = (await readFile(join(run, "tasks.tsv"), "utf8")).trim().split(/\r?\n/);
    const capture = JSON.parse(await readFile(join(dirname(tasks[1]!), "capture.json"), "utf8")) as { config: DiligentCaptureConfig; frames: DiligentCaptureFrame[] };
    const { width, height } = capture.config;
    const pixels = width * height;
    if (tasks.length - 1 !== capture.frames.length || !capture.config.withReferenceMean) {
        throw new Error("Quality evaluation requires a complete sequence with fixed-pose means.");
    }
    const lanes = ["native", "wgsl", "transport"] as const;
    const metrics = Object.fromEntries(lanes.map((lane) => [lane, { flicker: 0, residual: 0, pairs: 0, samples: 0, maximumExcessTrail: 0 }]));
    const previousResidual = Object.fromEntries(lanes.map((lane) => [lane, new Float64Array(pixels)]));
    const previousFloor = new Uint8Array(pixels);
    const initialFloor = new Uint8Array(pixels);
    const initialMean = gunzipSync(await readFile(tasks[1]!.replace(".frame.gz", ".mean.gz")));
    for (const frame of capture.frames) {
        const path = tasks[frame.index + 1]!;
        const packet = gunzipSync(await readFile(path));
        const mean = gunzipSync(await readFile(path.replace(".frame.gz", ".mean.gz")));
        const name = frame.index.toString().padStart(4, "0");
        const actualBytes = new Uint8Array(pixels);
        for (let p = 0; p < pixels; p++) {
            actualBytes[p] = Math.round(halfToFloat(packet.readUInt16LE(1168 + pixels * 24 + p * 2)) * 255);
        }
        const images = {
            native: await readFile(join(run, "native", name, "shared-final.u8")),
            wgsl: await readFile(join(run, "wgsl", name, "final.u8")),
            transport: capturedFinal ? actualBytes : await readFile(join(run, "transport", name, "final.u8")),
        };
        const inverse = new Float32Array(16);
        for (let c = 0; c < 4; c++) {
            for (let r = 0; r < 4; r++) {
                inverse[c * 4 + r] = packet.readFloatLE(16 + 112 + 5 * 64 + (r * 4 + c) * 4);
            }
        }
        const trail = Object.fromEntries(lanes.map((lane) => [lane, 0]));
        let spatialTrail = 0;
        let trailPixels = 0;
        for (let p = 0; p < pixels; p++) {
            const wasFloor = previousFloor[p] !== 0;
            previousFloor[p] = 0;
            const depth = packet.readFloatLE(1168 + p * 4);
            if (depth === 0) {
                continue;
            }
            const x = (2 * ((p % width) + 0.5)) / width - 1,
                y = 1 - (2 * (Math.floor(p / width) + 0.5)) / height;
            const w = inverse[3]! * x + inverse[7]! * y + inverse[11]! * depth + inverse[15]!;
            const wx = (inverse[0]! * x + inverse[4]! * y + inverse[8]! * depth + inverse[12]!) / w;
            const wy = (inverse[1]! * x + inverse[5]! * y + inverse[9]! * depth + inverse[13]!) / w;
            const wz = (inverse[2]! * x + inverse[6]! * y + inverse[10]! * depth + inverse[14]!) / w;
            const ny = decodeWorldNormalHalf(packet.readUInt16LE(1168 + pixels * 4 + p * 8 + 2));
            if (Math.abs(wy) >= 0.001 || ny <= 0.999 || (wx - frame.sphereX) ** 2 + wz * wz >= 2.25) {
                continue;
            }
            if (frame.index === 0) {
                initialFloor[p] = 1;
            }
            const expected = mean.readFloatLE(p * 4);
            const evaluateNoise = expected < 0.98 && frame.stage !== "warmup";
            const startMean = initialMean.readFloatLE(p * 4);
            const evaluateTrail = initialFloor[p] !== 0 && startMean < 0.94 && expected - startMean > 0.04;
            if (evaluateTrail) {
                spatialTrail += Math.max(0, expected - halfToFloat(packet.readUInt16LE(1168 + pixels * 20 + p * 2)));
                trailPixels++;
            }
            for (const lane of lanes) {
                const actual = images[lane][p]! / 255;
                const residual = actual - expected;
                const metric = metrics[lane]!;
                if (evaluateNoise) {
                    metric.residual += residual * residual;
                    metric.samples++;
                    if (wasFloor) {
                        metric.flicker += (residual - previousResidual[lane]![p]!) ** 2;
                        metric.pairs++;
                    }
                }
                previousResidual[lane]![p] = residual;
                if (evaluateTrail) {
                    trail[lane]! += Math.max(0, expected - actual);
                }
            }
            previousFloor[p] = evaluateNoise ? 1 : 0;
        }
        if (trailPixels >= 100) {
            for (const lane of lanes) {
                const metric = metrics[lane]!;
                metric.maximumExcessTrail = Math.max(metric.maximumExcessTrail, (trail[lane]! - spatialTrail) / trailPixels);
            }
        }
    }
    const result = Object.fromEntries(
        lanes.map((lane) => {
            const metric = metrics[lane]!;
            if (metric.pairs < 100 || metric.samples < 100) {
                throw new Error(`Insufficient ${lane} floor data`);
            }
            return [
                lane,
                {
                    floorFlickerRms: Math.sqrt(metric.flicker / metric.pairs),
                    floorResidualRms: Math.sqrt(metric.residual / metric.samples),
                    maximumExcessTrail: metric.maximumExcessTrail,
                    pairs: metric.pairs,
                },
            ];
        })
    );
    console.log(JSON.stringify(result, null, 2));
    await writeFile(join(run, "port-quality.json"), JSON.stringify(result, null, 2));
    if (process.argv.includes("--publish")) {
        const destination = resolve("lab\\public\\ao-temporal-reference\\complete-port");
        await mkdir(join(destination, "frames"), { recursive: true });
        const inherited = JSON.parse(await readFile(join(dirname(dirname(tasks[1]!)), "summary.json"), "utf8")) as Record<string, unknown>;
        const metadata = {
            ...inherited,
            port: true,
            candidate: { name: "Occlusion-history transport", integrated: capturedFinal, historyLength: 16, spatialGuide: false },
            quality: result,
            qualityAccepted: false,
            frames: capture.frames.map((frame) => ({ ...frame, prefix: `frames/${frame.index.toString().padStart(4, "0")}-` })),
        };
        await writeFile(join(destination, "comparison.json"), JSON.stringify(metadata, null, 2));
        const html = await readFile(resolve("scripts\\ao-reference\\diligent-viewer.html"), "utf8");
        await writeFile(join(destination, "index.html"), html.replace("COMPARISON_JSON_URL", "comparison.json"));
        for (const frame of capture.frames) {
            const name = frame.index.toString().padStart(4, "0");
            const packet = gunzipSync(await readFile(tasks[frame.index + 1]!));
            const oldPacket = previousCapture ? gunzipSync(await readFile(join(previousCapture, `${name}.frame.gz`))) : packet;
            if (previousCapture && !packet.subarray(16, 1168 + pixels * 22).equals(oldPacket.subarray(16, 1168 + pixels * 22))) {
                throw new Error(`The earlier recording does not have identical camera/depth/normal/motion/spatial inputs at frame ${frame.index}.`);
            }
            const raw = new Uint8Array(pixels),
                prior = new Uint8Array(pixels);
            for (let p = 0; p < pixels; p++) {
                raw[p] = Math.round(halfToFloat(packet.readUInt16LE(1168 + pixels * 20 + p * 2)) * 255);
                prior[p] = Math.round(halfToFloat(oldPacket.readUInt16LE(1168 + pixels * 24 + p * 2)) * 255);
            }
            const images: Record<string, Uint8Array> = { "blite-raw": raw, "blite-final": prior };
            const oldTemporal = new Uint8Array(pixels);
            for (let p = 0; p < pixels; p++) {
                oldTemporal[p] = Math.round(halfToFloat(oldPacket.readUInt16LE(1168 + pixels * 22 + p * 2)) * 255);
            }
            images["blite-temporal"] = oldTemporal;
            for (const stage of ["temporal", "final"]) {
                images[`shared-${stage}`] = await readFile(join(run, "native", name, `shared-${stage}.u8`));
                images[`native-${stage}`] = await readFile(join(run, "native", name, `native-${stage}.u8`));
                images[`wgsl-${stage}`] = await readFile(join(run, "wgsl", name, `${stage}.u8`));
                if (capturedFinal) {
                    const bytes = new Uint8Array(pixels);
                    const offset = 1168 + pixels * (stage === "final" ? 24 : 22);
                    for (let p = 0; p < pixels; p++) {
                        bytes[p] = Math.round(halfToFloat(packet.readUInt16LE(offset + p * 2)) * 255);
                    }
                    images[`clipped-${stage}`] = bytes;
                } else {
                    images[`clipped-${stage}`] = await readFile(join(run, "transport", name, `${stage}.u8`));
                }
            }
            images["native-raw"] = await readFile(join(run, "native", name, "native-raw.u8"));
            images["wgsl-raw"] = raw;
            const mean = gunzipSync(await readFile(tasks[frame.index + 1]!.replace(".frame.gz", ".mean.gz")));
            const expected = new Uint8Array(pixels);
            for (let p = 0; p < pixels; p++) {
                expected[p] = Math.round(mean.readFloatLE(p * 4) * 255);
            }
            images.reference = expected;
            for (const [stage, bytes] of Object.entries(images)) {
                await writeFile(join(destination, "frames", `${name}-${stage}.png`), grayscale(bytes, width, height));
            }
        }
        console.log("Preview: /ao-temporal-reference/complete-port/index.html");
    }
}
void evaluate().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
