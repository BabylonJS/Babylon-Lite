import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
    adaptSsaoProfileDemo,
    decodeSsaoPassTimes,
    parseSsaoProfileOptions,
    ssaoPruningBlocks,
    ssaoTextureBytes,
    summarizeSsaoSamples,
    verifySsaoPruningFrames,
} from "../../../scripts/ao-reference/ssao-profile-contract.js";
import type { ProfileTexture, SsaoFrameDigest } from "../../../scripts/ao-reference/ssao-profile-contract.js";
import { observeSsaoProfile } from "../../../scripts/ao-reference/ssao-profile-client.js";
import type { EngineContext } from "../../../packages/babylon-lite/src/engine/engine.js";

function texture(overrides: Partial<ProfileTexture> = {}): ProfileTexture {
    return { label: "ssao-history", width: 1920, height: 1080, format: "rgba32float", mipLevelCount: 1, sampleCount: 1, dimension: "2d", depthOrArrayLayers: 1, ...overrides };
}

describe("SSAO pass diagnostic contracts", () => {
    it("selects a bounded default and explicit quality without allocating resources", () => {
        expect(parseSsaoProfileOptions([])).toEqual({ samples: 120, quality: "high", comparePruning: false });
        expect(parseSsaoProfileOptions(["--samples=16", "--quality=ultra", "--compare-pruning"])).toEqual({ samples: 16, quality: "ultra", comparePruning: true });
    });
    it.each([
        "--samples=0",
        "--samples=513",
        "--samples=NaN",
        "--samples=16.5",
        "--samples=16=bad",
        "--samples",
        "--software",
        "--quarter",
        "--quality=invalid",
        "--compare-pruning=true",
    ])("rejects unsupported input %s", (arg) => expect(() => parseSsaoProfileOptions([arg])).toThrow());
    it("rejects duplicate options rather than silently choosing the last", () => {
        expect(() => parseSsaoProfileOptions(["--quality=high", "--quality=low"])).toThrow("Duplicate");
        expect(() => parseSsaoProfileOptions(["--compare-pruning", "--compare-pruning"])).toThrow("Duplicate");
    });
    it.each([16, 17, 119, 120, 121, 512])("balances off/on timing order and preserves exactly %s samples per variant", (samples) => {
        const blocks = ssaoPruningBlocks(samples);
        expect(blocks.map((block) => block.order)).toEqual([
            [false, true],
            [true, false],
            [true, false],
            [false, true],
        ]);
        expect(blocks.reduce((sum, block) => sum + block.samples, 0)).toBe(samples);
        expect(blocks.every((block) => block.samples >= 4)).toBe(true);
    });
    it("rejects invalid block sample counts", () => {
        expect(() => ssaoPruningBlocks(0)).toThrow();
        expect(() => ssaoPruningBlocks(513)).toThrow();
    });
    it("requires every sequential AO and history-count digest to match without tolerances", () => {
        const off: SsaoFrameDigest[] = [0, 1, 2].map((frame) => ({ frame, aoSha256: "a".repeat(64), countSha256: "b".repeat(64), aoBytes: 64, countBytes: 16 }));
        expect(verifySsaoPruningFrames(off, structuredClone(off))).toEqual({ equivalent: true, frames: 3, comparedBytes: 240 });
        for (const field of ["aoSha256", "countSha256"] as const) {
            const changed = structuredClone(off);
            changed[1]![field] = "c".repeat(64);
            expect(() => verifySsaoPruningFrames(off, changed)).toThrow("frame 1");
        }
        const order = structuredClone(off);
        order[1]!.frame = 2;
        expect(() => verifySsaoPruningFrames(off, order)).toThrow("indices");
        const size = structuredClone(off);
        size[0]!.aoBytes++;
        expect(() => verifySsaoPruningFrames(off, size)).toThrow("dimensions");
        expect(() => verifySsaoPruningFrames([], [])).toThrow("empty");
        expect(() => verifySsaoPruningFrames(off, off.slice(1))).toThrow("counts");
    });
    it("counts all odd mips, layers and multisamples explicitly", () => {
        expect(ssaoTextureBytes(texture())).toBe(1920 * 1080 * 16);
        expect(ssaoTextureBytes(texture({ width: 9, height: 7, mipLevelCount: 4, format: "r32float", sampleCount: 4, depthOrArrayLayers: 2 }))).toBe((63 + 12 + 2 + 1) * 4 * 4 * 2);
        expect(ssaoTextureBytes(texture({ width: 1, height: 1, format: "r8unorm" }))).toBe(1);
    });
    it("reproduces the existing full-resolution persistent-history accounting", () => {
        const geometry = ssaoTextureBytes(texture({ format: "rg32uint" }));
        const ao = ssaoTextureBytes(texture({ format: "r8unorm" })) * 2;
        const counts = ssaoTextureBytes(texture({ format: "r16float" })) * 2;
        expect(geometry + ao + counts).toBe(29030400);
    });
    it("rejects unsupported memory estimates rather than inventing a format size", () => {
        expect(() => ssaoTextureBytes(texture({ format: "depth24plus" }))).toThrow("Unsupported");
        expect(() => ssaoTextureBytes(texture({ dimension: "3d" }))).toThrow("Unsupported");
        expect(() => ssaoTextureBytes(texture({ width: 0 }))).toThrow("positive");
    });
    it("aggregates repeated passes within a frame before computing statistics", () => {
        const first = decodeSsaoPassTimes(["temporal", "reduce", "reduce"], new BigUint64Array([10n, 1000010n, 2000000n, 4000000n, 5000000n, 8000000n]));
        expect(first).toEqual({ temporal: 1, reduce: 5 });
        const frames = [
            { reduce: 1, repair: 9 },
            { reduce: 9, repair: 1 },
            { reduce: 1, repair: 1 },
        ];
        expect(summarizeSsaoSamples(frames.map((frame) => frame.reduce + frame.repair)).medianMs).toBe(10);
        expect(summarizeSsaoSamples(frames.map((frame) => frame.reduce)).medianMs + summarizeSsaoSamples(frames.map((frame) => frame.repair)).medianMs).toBe(2);
    });
    it("retains quantized zero samples and validates timestamps", () => {
        expect(decodeSsaoPassTimes(["empty"], new BigUint64Array([5n, 5n]))).toEqual({ empty: 0 });
        expect(() => decodeSsaoPassTimes(["bad"], new BigUint64Array([8n, 5n]))).toThrow("reversed");
        expect(() => decodeSsaoPassTimes(["missing"], new BigUint64Array())).toThrow("count");
        expect(summarizeSsaoSamples([0, 1, 2, 3])).toEqual({ samples: 4, meanMs: 1.5, medianMs: 1.5, p95Ms: 3, zeroSamples: 1 });
        expect(() => summarizeSsaoSamples([])).toThrow("nonempty");
        expect(() => summarizeSsaoSamples([NaN])).toThrow("finite");
    });
    it("adapts only unique source hooks in the real demo", async () => {
        const source = await readFile(resolve("lab/lite/src/demos/ambient-occlusion.ts"), "utf8");
        const adapted = adaptSsaoProfileDemo(source);
        expect(adapted).toContain('from "../../../../scripts/ao-reference/ssao-profile-client.js"');
        expect(adapted).toContain("const audit = observeSsaoProfile(engine);");
        expect(adapted).not.toContain("await startEngine(engine);");
        expect(() => adaptSsaoProfileDemo(source + "\n    await startEngine(engine);")).toThrow("exactly once");
        expect(() => adaptSsaoProfileDemo(source.replace("await startEngine(engine);", ""))).toThrow("exactly once");
    });
    it("tracks real texture identity and destruction, then restores device methods", () => {
        const destroy = vi.fn();
        const gpuTexture = { destroy } as unknown as GPUTexture;
        const createTexture = vi.fn(() => gpuTexture);
        const pipeline = {} as GPUComputePipeline;
        const createComputePipeline = vi.fn(() => pipeline);
        const engine = {
            _device: { features: new Set(["timestamp-query"]), adapterInfo: { isFallbackAdapter: false }, createTexture, createComputePipeline },
        } as unknown as EngineContext;
        const observation = observeSsaoProfile(engine);
        const created = engine._device.createTexture({ size: [1, 1], format: "r8unorm", usage: 0 });
        const aliases = [created, created];
        expect(new Set(aliases).size).toBe(1);
        expect(observation.textures.size).toBe(1);
        engine._device.createComputePipeline({ label: "ssao-xegtao", layout: "auto", compute: { module: {} as GPUShaderModule, constants: { SLICE_COUNT: 3 } } });
        expect(observation.pipelines.get(pipeline)).toBe("estimate");
        created.destroy();
        expect(destroy).toHaveBeenCalledOnce();
        expect(observation.textures.size).toBe(0);
        observation.restore();
        expect(engine._device.createTexture).toBe(createTexture);
        expect(engine._device.createComputePipeline).toBe(createComputePipeline);
    });
    it("fails explicitly when timestamp queries are unavailable", () => {
        const engine = { _device: { features: new Set() } } as unknown as EngineContext;
        expect(() => observeSsaoProfile(engine)).toThrow("no CPU/software fallback");
    });
    it("rejects a software fallback instead of presenting it as hardware performance", () => {
        const engine = { _device: { features: new Set(["timestamp-query"]), adapterInfo: { isFallbackAdapter: true } } } as unknown as EngineContext;
        expect(() => observeSsaoProfile(engine)).toThrow("non-fallback GPU");
    });
});
