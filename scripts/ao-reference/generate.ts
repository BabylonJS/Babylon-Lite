import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AO_FIXTURE_IDS, AO_RAY_COUNT, createAoFixture } from "./fixtures.js";
import type { AoFixtureId, AoFixtureSettings } from "./fixtures.js";
import { compareAoValues, decodeAoFloats, encodeAoFloats, encodeAoPreview } from "./compare.js";
import { AO_SOURCES, assembleAoShaders, fetchAoSources, sha256 } from "./sources.js";
import type { AoSource } from "./sources.js";

export interface AoFileRecord {
    bytes: number;
    sha256: string;
}
export interface AoFixtureRecord {
    id: AoFixtureId;
    settings: AoFixtureSettings;
    rayCount: number;
    receiverPixels: number;
    qualityError: { xegtao: ReturnType<typeof compareAoValues>; vbao: ReturnType<typeof compareAoValues>; vbaoSlopeSafe: ReturnType<typeof compareAoValues> };
    files: Record<string, AoFileRecord>;
}
export interface AoReferenceManifest {
    version: 1;
    algorithms: { xegtao: string; vbao: string; vbaoSlopeSafe: string; quality: string };
    sources: readonly AoSource[];
    generator: Record<string, string>;
    backend: string;
    fixtures: AoFixtureRecord[];
}

export interface AoPreservedGoldens {
    sources: readonly AoSource[];
    fixtures: Pick<AoFixtureRecord, "id" | "settings" | "files">[];
}

export const AO_REFERENCE_FILES = [
    "sources.ts",
    "fixtures.ts",
    "compare.ts",
    "generate.ts",
    "native.cs",
    "capture.ps1",
    "xegtao-adapter.hlsl",
    "vbao-adapter.glsl",
    "vbao-slope-safe-sampling.glsl",
] as const;

const root = fileURLToPath(new URL("../../", import.meta.url));
export const AO_GOLDEN_DIRECTORY = join(root, "reference", "lite", "ao-reference");

export async function aoGeneratorHashes(): Promise<Record<string, string>> {
    return Object.fromEntries(await Promise.all(AO_REFERENCE_FILES.map(async (name) => [name, sha256(await readFile(new URL(name, import.meta.url)))] as const)));
}

export function assertPreservedAoGoldens(original: AoPreservedGoldens, current: AoReferenceManifest): void {
    if (JSON.stringify(original.sources) !== JSON.stringify(current.sources)) throw new Error("Preserved upstream AO source pins changed");
    for (const fixture of original.fixtures) {
        const actual = current.fixtures.find((candidate) => candidate.id === fixture.id);
        if (!actual || JSON.stringify(actual.settings) !== JSON.stringify(fixture.settings)) throw new Error(`Preserved AO fixture settings changed: ${fixture.id}`);
        for (const [name, record] of Object.entries(fixture.files)) {
            if (actual.files[name]?.sha256 !== record.sha256 || actual.files[name]?.bytes !== record.bytes) {
                throw new Error(`Preserved upstream AO golden changed: ${fixture.id}/${name}`);
            }
        }
    }
}

function assertVisibility(values: Float32Array, mask: Uint8Array, name: string): void {
    if (values.length !== mask.length) throw new Error(`${name}: incorrect output dimensions`);
    for (let i = 0; i < values.length; i++) {
        const value = values[i]!;
        if (!Number.isFinite(value) || value < 0 || value > 1 || (mask[i] === 0 && value !== 1)) {
            throw new Error(`${name}: invalid visibility/background at pixel ${i}: ${value}`);
        }
    }
}

export async function generateAoReferences(operation: "--update" | "--check"): Promise<void> {
    if (process.platform !== "win32") throw new Error("Native AO generation requires Windows; offline fixture tests are cross-platform");
    const cache = join(root, ".ao-reference-cache");
    await mkdir(cache, { recursive: true });
    const sources = await fetchAoSources(join(cache, "sources"));
    const run = await mkdtemp(join(cache, "capture-"));
    try {
        const shaders = join(run, "shaders");
        await assembleAoShaders(sources, shaders);
        const tasks: string[] = [];
        const fixtures = AO_FIXTURE_IDS.map(createAoFixture);
        for (const fixture of fixtures) {
            const input = join(run, "inputs", fixture.id);
            const output = join(run, "outputs", fixture.id);
            await mkdir(input, { recursive: true });
            await Promise.all([
                writeFile(join(input, "depth.f32"), encodeAoFloats(fixture.depth)),
                writeFile(join(input, "normals.f32"), encodeAoFloats(fixture.normals)),
                writeFile(join(input, "mask.u8"), fixture.mask),
                writeFile(join(input, "raytraced.f32"), encodeAoFloats(fixture.raytraced)),
            ]);
            const s = fixture.settings;
            tasks.push([input, output, s.width, s.height, s.near, s.far, s.tanHalfFovY, s.radius, s.thickness, s.slices, s.steps, "ao-reference-v1"].join("\t"));
        }
        const tasksFile = join(run, "tasks.tsv");
        await writeFile(tasksFile, tasks.join("\n"));
        const capture = spawnSync(
            "pwsh",
            ["-NoProfile", "-NonInteractive", "-File", fileURLToPath(new URL("./capture.ps1", import.meta.url)), "-ShaderDirectory", shaders, "-TasksFile", tasksFile],
            { stdio: "inherit" }
        );
        if (capture.error) throw capture.error;
        if (capture.status !== 0) throw new Error(`Native AO reference capture failed (${capture.signal ?? capture.status})`);
        const records: AoFixtureRecord[] = [];
        const blobs = new Map<string, Buffer>();
        for (const fixture of fixtures) {
            const { width, height } = fixture.settings;
            const input = join(run, "inputs", fixture.id);
            const output = join(run, "outputs", fixture.id);
            const files: Record<string, AoFileRecord> = {};
            const store = (name: string, bytes: Buffer): void => {
                blobs.set(join(fixture.id, name), bytes);
                files[name] = { bytes: bytes.length, sha256: sha256(bytes) };
            };
            for (const name of ["depth.f32", "normals.f32", "mask.u8", "raytraced.f32"]) store(name, await readFile(join(input, name)));
            const xeBytes = await readFile(join(output, "xegtao.f32"));
            const vbBytes = await readFile(join(output, "vbao.f32"));
            const safeBytes = await readFile(join(output, "vbao-slope-safe.f32"));
            const xe = decodeAoFloats(xeBytes),
                vb = decodeAoFloats(vbBytes),
                safe = decodeAoFloats(safeBytes);
            assertVisibility(xe, fixture.mask, `${fixture.id}/XeGTAO`);
            assertVisibility(vb, fixture.mask, `${fixture.id}/VBAO`);
            assertVisibility(safe, fixture.mask, `${fixture.id}/VBAO slope-safe`);
            store("xegtao.f32", xeBytes);
            store("vbao.f32", vbBytes);
            store("vbao-slope-safe.f32", safeBytes);
            const sampleBytes = await readFile(join(output, "vbao-slope-safe-samples.f32"));
            const samples = decodeAoFloats(sampleBytes);
            if (samples.length !== width * height || samples.some((value) => !Number.isFinite(value) || value <= 0)) {
                throw new Error(`${fixture.id}: invalid slope-safe depth-sampling probe`);
            }
            store("vbao-slope-safe-samples.f32", sampleBytes);
            for (let mip = 0; mip < 5; mip++) {
                const name = `depth-mip${mip}.f32`,
                    bytes = await readFile(join(output, name));
                const values = decodeAoFloats(bytes);
                if (values.length !== (width >> mip) * (height >> mip) || values.some((value) => !Number.isFinite(value) || value <= 0 || value > fixture.settings.far * 1.001)) {
                    throw new Error(`${fixture.id}/${name}: invalid depth pyramid`);
                }
                store(name, bytes);
            }
            const packed = await readFile(join(output, "xegtao-raw.u32"));
            const edges = await readFile(join(output, "xegtao-edges.u8"));
            if (packed.length !== width * height * 4 || edges.length !== width * height) throw new Error("Incorrect XeGTAO working-buffer dimensions");
            for (let i = 0; i < width * height; i++) if (packed.readUInt32LE(i * 4) > 255) throw new Error(`Invalid packed XeGTAO value at ${fixture.id}/${i}`);
            store("xegtao-raw.u32", packed);
            store("xegtao-edges.u8", edges);
            store("xegtao-golden.png", encodeAoPreview(xe, width, height));
            store("vbao-golden.png", encodeAoPreview(vb, width, height));
            store("vbao-slope-safe-golden.png", encodeAoPreview(safe, width, height));
            store("raytraced-golden.png", encodeAoPreview(fixture.raytraced, width, height));
            records.push({
                id: fixture.id,
                settings: fixture.settings,
                rayCount: AO_RAY_COUNT,
                receiverPixels: fixture.mask.reduce((sum, value) => sum + value, 0),
                qualityError: {
                    xegtao: compareAoValues(xe, fixture.raytraced, fixture.mask),
                    vbao: compareAoValues(vb, fixture.raytraced, fixture.mask),
                    vbaoSlopeSafe: compareAoValues(safe, fixture.raytraced, fixture.mask),
                },
                files,
            });
        }
        const manifest: AoReferenceManifest = {
            version: 1,
            algorithms: {
                xegtao: "Upstream XeGTAO FP32, high (3 slices x 3 steps per side), one final upstream denoise pass, static Hilbert/R2 noise",
                vbao: "Upstream Filament 32-sector visibility-bitmask estimator, supplied normals, XeGTAO FP32 depth mips, no denoise, static upstream spatial noise; NOT stock Filament whole-frame parity",
                vbaoSlopeSafe:
                    "Adapted VBAO quality prototype: unchanged upstream estimator, plane-consistent reciprocal-depth interpolation at mip 0 with geometry/normal/tangent-plane guards; nearest sampling at discontinuities and coarser mips; NOT an independent upstream oracle",
                quality:
                    "Independent analytic-geometry cosine-weighted Hammersley AO, 256 rays/pixel, finite radius, single bounce; finite-sample quality reference, NOT an SSAO parity target",
            },
            sources: AO_SOURCES,
            generator: await aoGeneratorHashes(),
            backend: (await readFile(join(run, "outputs", fixtures[0]!.id, "backend.txt"), "utf8")).trim(),
            fixtures: records,
        };
        const upstreamLock = JSON.parse(await readFile(join(AO_GOLDEN_DIRECTORY, "upstream-lock.json"), "utf8")) as AoPreservedGoldens;
        assertPreservedAoGoldens(upstreamLock, manifest);
        if (operation === "--check") {
            const golden = JSON.parse(await readFile(join(AO_GOLDEN_DIRECTORY, "manifest.json"), "utf8")) as AoReferenceManifest;
            if (JSON.stringify(golden.sources) !== JSON.stringify(manifest.sources) || JSON.stringify(golden.generator) !== JSON.stringify(manifest.generator)) {
                throw new Error("AO source/generator provenance changed; goldens were not modified");
            }
            for (const record of records) {
                const expected = golden.fixtures.find((candidate) => candidate.id === record.id);
                if (!expected || JSON.stringify(expected.settings) !== JSON.stringify(record.settings)) throw new Error(`AO fixture settings changed: ${record.id}`);
                for (const [name, metadata] of Object.entries(record.files)) {
                    const bytes = await readFile(join(AO_GOLDEN_DIRECTORY, record.id, name));
                    if (sha256(bytes) !== metadata.sha256 || expected.files[name]?.sha256 !== metadata.sha256) {
                        throw new Error(`Native reference reproduction differs at ${record.id}/${name}; goldens were not modified`);
                    }
                }
            }
            console.log("Independent native AO references reproduce every checked-in fixture exactly.");
        } else {
            await mkdir(AO_GOLDEN_DIRECTORY, { recursive: true });
            for (const [name, bytes] of blobs) {
                const destination = join(AO_GOLDEN_DIRECTORY, name);
                await mkdir(resolve(destination, ".."), { recursive: true });
                await writeFile(destination, bytes);
            }
            await Promise.all(["XeGTAO-LICENSE", "Filament-LICENSE"].map((name) => copyFile(join(cache, "sources", name), join(AO_GOLDEN_DIRECTORY, name))));
            await writeFile(join(AO_GOLDEN_DIRECTORY, "manifest.json"), JSON.stringify(manifest, null, 4) + "\n");
            console.table(
                records.map((record) => ({
                    fixture: record.id,
                    receivers: record.receiverPixels,
                    XeGTAO_MAE: record.qualityError.xegtao.meanAbsolute.toFixed(5),
                    VBAO_MAE: record.qualityError.vbao.meanAbsolute.toFixed(5),
                    VBAO_slope_safe_MAE: record.qualityError.vbaoSlopeSafe.meanAbsolute.toFixed(5),
                }))
            );
            console.log(`Wrote independent AO goldens to ${AO_GOLDEN_DIRECTORY}`);
        }
    } finally {
        await rm(run, { recursive: true, force: true });
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const args = process.argv.slice(2);
    if (args.length !== 1 || (args[0] !== "--update" && args[0] !== "--check")) {
        console.error("Usage: pnpm reference:ao --update | --check (updates are always explicit)");
        process.exitCode = 1;
    } else {
        generateAoReferences(args[0]).catch((error: unknown) => {
            console.error(error);
            process.exitCode = 1;
        });
    }
}
