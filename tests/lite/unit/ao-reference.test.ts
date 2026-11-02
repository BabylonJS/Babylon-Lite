import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import { AO_FIXTURE_IDS, AO_RAY_COUNT, createAoFixture, decodeAoDepth, encodeAoDepth, intersectAoShape } from "../../../scripts/ao-reference/fixtures.js";
import { compareAoValues, decodeAoFloats, encodeAoFloats, encodeAoPreview } from "../../../scripts/ao-reference/compare.js";
import { AO_SOURCES, adaptXeIntegerSwizzles, extractShaderFunction, sha256, verifyAoSource } from "../../../scripts/ao-reference/sources.js";
import { AO_GOLDEN_DIRECTORY, aoGeneratorHashes, assertPreservedAoGoldens } from "../../../scripts/ao-reference/generate.js";
import type { AoPreservedGoldens, AoReferenceManifest } from "../../../scripts/ao-reference/generate.js";

describe("independent AO reference contract", () => {
    it("round-trips reverse-Z depth and uses little-endian floats", () => {
        for (const z of [0.1, 0.5, 3, 19, 20]) expect(decodeAoDepth(encodeAoDepth(z, 0.1, 20), 0.1, 20)).toBeCloseTo(z, 10);
        expect(encodeAoDepth(0.1, 0.1, 20)).toBeCloseTo(1);
        expect(encodeAoDepth(20, 0.1, 20)).toBe(0);
        const values = new Float32Array([1, -2, 0.25]);
        expect(encodeAoFloats(values).subarray(0, 4)).toEqual(Buffer.from([0, 0, 128, 63]));
        expect(decodeAoFloats(encodeAoFloats(values))).toEqual(values);
        expect(() => decodeAoFloats(Buffer.alloc(3))).toThrow("divisible");
    });
    it("intersects independent geometry, including parallel and inside-box rays", () => {
        const box = { kind: "box" as const, center: [0, 0, 3] as const, half: [1, 1, 1] as const };
        expect(intersectAoShape([0, 0, 0], [0, 0, 1], box, 10)).toEqual({ distance: 2, normal: [0, 0, -1] });
        expect(intersectAoShape([0, 0, 3], [1, 0, 0], box, 10)).toEqual({ distance: 1, normal: [1, 0, 0] });
        expect(intersectAoShape([2, 0, 0], [0, 0, 1], box, 10)).toBeNull();
        expect(intersectAoShape([0, 0, 0], [0, 0, 1], { kind: "sphere", center: [0, 0, 3], radius: 1 }, 10)).toEqual({ distance: 2, normal: [0, 0, -1] });
        expect(intersectAoShape([0, 0, 0], [1, 0, 0], { kind: "plane", normal: [0, 1, 0], offset: -1 }, 10)).toBeNull();
    });
    it("rejects source corruption and mutable revisions", () => {
        const bytes = Buffer.from("fixture");
        const source = { ...AO_SOURCES[0]!, sha256: sha256(bytes) };
        expect(() => verifyAoSource(source, bytes)).not.toThrow();
        expect(() => verifyAoSource(source, Buffer.from("changed"))).toThrow("hash mismatch");
        expect(() => verifyAoSource({ ...source, commit: "master" }, bytes)).toThrow("immutable");
        for (const pin of AO_SOURCES) {
            expect(pin.commit).toMatch(/^[a-f0-9]{40}$/);
            expect(pin.sha256).toMatch(/^[a-f0-9]{64}$/);
        }
    });
    it("extracts upstream helper bodies unchanged and fails on ambiguous functions", () => {
        const source = "// header\nfloat helper(float x) { if (x > 0.0) { return x; } return 0.0; }\n// next";
        expect(extractShaderFunction(source, "float helper(")).toBe("float helper(float x) { if (x > 0.0) { return x; } return 0.0; }");
        expect(() => extractShaderFunction(source + source, "float helper(")).toThrow("exactly one");
        expect(() => extractShaderFunction("float helper(float x)", "float helper(")).toThrow("Unterminated");
    });
    it("only expands the four known DXC integer swizzles for the system HLSL compiler", () => {
        const source = "0.5.xx; groupThreadID.xy % 2.xx; groupThreadID.xy % 4.xx; groupThreadID.xy % 8.xx; dot( edgesC_LRTB[side], 1.xxxx );";
        expect(adaptXeIntegerSwizzles(source)).toBe(
            "0.5.xx; groupThreadID.xy % uint2(2, 2); groupThreadID.xy % uint2(4, 4); groupThreadID.xy % uint2(8, 8); dot( edgesC_LRTB[side], float4(1, 1, 1, 1) );"
        );
        expect(() => adaptXeIntegerSwizzles("changed upstream")).toThrow("Unexpected upstream");
    });
    it("never compares cropped buffers or accepts NaN, invalid masks, or empty masks", () => {
        const a = new Float32Array([0, 0.5, 1]),
            b = new Float32Array([0.25, 0.5, 0.75]);
        expect(compareAoValues(a, b, new Uint8Array([1, 0, 1]))).toEqual({ meanAbsolute: 0.25, maximumAbsolute: 0.25, pixels: 2 });
        expect(() => compareAoValues(a, b.subarray(0, 2))).toThrow("identical dimensions");
        expect(() => compareAoValues(a, new Float32Array([NaN, 0, 0]))).toThrow("Non-finite");
        expect(() => compareAoValues(a, b, new Uint8Array(3))).toThrow("empty");
        expect(() => compareAoValues(a, b, new Uint8Array([2, 1, 1]))).toThrow("Invalid receiver");
    });
    it("encodes an exact, untonemapped grayscale AO preview", () => {
        const png = PNG.sync.read(encodeAoPreview(new Float32Array([0, 0.5, 1]), 3, 1));
        expect([...png.data]).toEqual([0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
        expect(() => encodeAoPreview(new Float32Array([NaN]), 1, 1)).toThrow("Invalid AO");
        expect(() => encodeAoPreview(new Float32Array([1]), 2, 1)).toThrow("exact");
    });
    it("generates deterministic plane inputs and unoccluded ray-traced AO", () => {
        const a = createAoFixture("plane"),
            b = createAoFixture("plane");
        expect(a.depth).toEqual(b.depth);
        expect(a.normals).toEqual(b.normals);
        expect(a.raytraced.every((value) => value === 1)).toBe(true);
        expect(a.mask.every((value) => value === 1)).toBe(true);
    }, 30_000);
});

describe("checked-in independent AO goldens", () => {
    it("validates provenance, exact shapes, all artifact hashes, and meaningful occlusion", async () => {
        const manifest = JSON.parse(await readFile(join(AO_GOLDEN_DIRECTORY, "manifest.json"), "utf8")) as AoReferenceManifest;
        expect(manifest.version).toBe(1);
        expect(manifest.sources).toEqual(AO_SOURCES);
        expect(manifest.generator).toEqual(await aoGeneratorHashes());
        expect(manifest.algorithms.vbao).toContain("NOT stock Filament");
        expect(manifest.algorithms.vbaoSlopeSafe).toContain("NOT an independent upstream oracle");
        expect(manifest.backend).toContain("D3D11 hardware");
        expect(manifest.fixtures.map((fixture) => fixture.id)).toEqual([...AO_FIXTURE_IDS]);
        const upstreamLock = JSON.parse(await readFile(join(AO_GOLDEN_DIRECTORY, "upstream-lock.json"), "utf8")) as AoPreservedGoldens;
        expect(() => assertPreservedAoGoldens(upstreamLock, manifest)).not.toThrow();
        const corrupted = structuredClone(manifest);
        corrupted.fixtures[0]!.files["vbao.f32"]!.sha256 = "0".repeat(64);
        expect(() => assertPreservedAoGoldens(upstreamLock, corrupted)).toThrow("Preserved upstream AO golden changed");
        for (const name of ["XeGTAO-LICENSE", "Filament-LICENSE"]) {
            expect(sha256(await readFile(join(AO_GOLDEN_DIRECTORY, name)))).toBe(AO_SOURCES.find((source) => source.name === name)!.sha256);
        }
        for (const fixture of manifest.fixtures) {
            const directory = join(AO_GOLDEN_DIRECTORY, fixture.id);
            const count = fixture.settings.width * fixture.settings.height;
            expect(fixture.rayCount).toBe(AO_RAY_COUNT);
            for (const [name, entry] of Object.entries(fixture.files)) {
                const bytes = await readFile(join(directory, name));
                expect(bytes.length, `${fixture.id}/${name} size`).toBe(entry.bytes);
                expect(sha256(bytes), `${fixture.id}/${name} hash`).toBe(entry.sha256);
            }
            const depth = decodeAoFloats(await readFile(join(directory, "depth.f32")));
            const normals = decodeAoFloats(await readFile(join(directory, "normals.f32")));
            const mask = await readFile(join(directory, "mask.u8"));
            expect(depth.length).toBe(count);
            expect(normals.length).toBe(count * 4);
            expect(mask.length).toBe(count);
            expect(mask.reduce((sum, value) => sum + value, 0)).toBe(fixture.receiverPixels);
            for (let i = 0; i < count; i++) {
                expect(mask[i]).toBe(depth[i]! > 0 ? 1 : 0);
                if (mask[i]) expect(Math.hypot(normals[i * 4]!, normals[i * 4 + 1]!, normals[i * 4 + 2]!)).toBeCloseTo(1, 5);
            }
            for (const name of ["xegtao", "vbao", "vbao-slope-safe", "raytraced"] as const) {
                const values = decodeAoFloats(await readFile(join(directory, `${name}.f32`)));
                expect(values.length).toBe(count);
                expect(values.every((value, i) => Number.isFinite(value) && value >= 0 && value <= 1 && (mask[i] !== 0 || value === 1))).toBe(true);
                const png = PNG.sync.read(await readFile(join(directory, `${name}-golden.png`)));
                expect([png.width, png.height]).toEqual([fixture.settings.width, fixture.settings.height]);
                expect(png.data.every((value, i) => value === (i % 4 === 3 ? 255 : Math.round(values[Math.floor(i / 4)]! * 255)))).toBe(true);
                if (fixture.id === "plane") {
                    if (name === "raytraced") {
                        expect(values.every((value) => value === 1)).toBe(true);
                    } else {
                        const quality = fixture.qualityError[name === "vbao-slope-safe" ? "vbaoSlopeSafe" : name];
                        expect(quality.meanAbsolute).toBeLessThan(0.05);
                    }
                }
                if (fixture.id === "corner") expect(Math.min(...values)).toBeLessThan(0.8);
                if (name !== "raytraced") {
                    const raytraced = decodeAoFloats(await readFile(join(directory, "raytraced.f32")));
                    expect(compareAoValues(values, raytraced, mask)).toEqual(fixture.qualityError[name === "vbao-slope-safe" ? "vbaoSlopeSafe" : name]);
                }
            }
            for (let mip = 0; mip < 5; mip++) expect(fixture.files[`depth-mip${mip}.f32`]!.bytes).toBe((fixture.settings.width >> mip) * (fixture.settings.height >> mip) * 4);
        }
    }, 30_000);
    it("limits isolated tilted-plane self-occlusion and retains true corner occlusion", async () => {
        for (const id of ["tilted-plane-x", "tilted-plane-y"] as const) {
            const directory = join(AO_GOLDEN_DIRECTORY, id);
            const safe = decodeAoFloats(await readFile(join(directory, "vbao-slope-safe.f32")));
            const original = decodeAoFloats(await readFile(join(directory, "vbao.f32")));
            const ground = decodeAoFloats(await readFile(join(directory, "raytraced.f32")));
            const mask = await readFile(join(directory, "mask.u8"));
            expect(ground.every((value) => value === 1)).toBe(true);
            const corrected = compareAoValues(safe, ground, mask);
            const baseline = compareAoValues(original, ground, mask);
            expect(corrected.meanAbsolute).toBeLessThan(0.04);
            expect(corrected.maximumAbsolute).toBeLessThan(0.07);
            expect(corrected.meanAbsolute).toBeLessThan(baseline.meanAbsolute * 0.7);
        }
        const corner = decodeAoFloats(await readFile(join(AO_GOLDEN_DIRECTORY, "corner", "vbao-slope-safe.f32")));
        expect(Math.min(...corner)).toBeLessThan(0.7);
    });
    it("samples the actual tilted plane ray, without inventing depths at a parallel depth step", async () => {
        for (const id of ["tilted-plane-x", "tilted-plane-y"] as const) {
            const settings = createAoFixture(id).settings;
            const sample = decodeAoFloats(await readFile(join(AO_GOLDEN_DIRECTORY, id, "vbao-slope-safe-samples.f32")));
            expect(sample.length).toBe(settings.width * settings.height);
            for (let y = 0; y < settings.height; y++) {
                for (let x = 0; x < settings.width; x++) {
                    const rayX = ((((x + 0.75) / settings.width) * 2 - 1) * settings.tanHalfFovY * settings.width) / settings.height;
                    // OpenGL's positive Y probe offset moves upward in canonical top-down storage.
                    const rayY = (1 - ((y + 0.25) / settings.height) * 2) * settings.tanHalfFovY;
                    const expected = 3 / (1 - (id === "tilted-plane-x" ? rayX : rayY));
                    expect(Math.abs(sample[y * settings.width + x]! - expected)).toBeLessThan(expected * 2e-6);
                }
            }
        }
        const directory = join(AO_GOLDEN_DIRECTORY, "depth-step");
        const probe = decodeAoFloats(await readFile(join(directory, "vbao-slope-safe-samples.f32")));
        const depth = decodeAoFloats(await readFile(join(directory, "depth.f32")));
        const normals = decodeAoFloats(await readFile(join(directory, "normals.f32")));
        for (let y = 0; y < 96; y++) {
            const left = y * 128 + 63,
                right = left + 1;
            expect(normals.subarray(left * 4, left * 4 + 3)).toEqual(normals.subarray(right * 4, right * 4 + 3));
            expect(decodeAoDepth(depth[left]!, 0.1, 20) - decodeAoDepth(depth[right]!, 0.1, 20)).toBeGreaterThan(2);
            expect(probe[left]).toBeCloseTo(decodeAoDepth(depth[left]!, 0.1, 20), 5);
            expect(probe[right]).toBeCloseTo(decodeAoDepth(depth[right]!, 0.1, 20), 5);
        }
    });
});
