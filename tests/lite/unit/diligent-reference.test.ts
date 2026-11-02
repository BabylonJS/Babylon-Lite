import { describe, expect, it } from "vitest";
import {
    diligentFrame,
    diligentFrameBytes,
    diligentFrameCount,
    DILIGENT_CAMERA_BYTES,
    halfToFloat,
    decodeWorldNormalHalf,
    transposeCameraMatrix,
    validateDiligentConfig,
    unorm8ToHalf,
} from "../../../scripts/ao-reference/diligent-contract.js";
import { DILIGENT_COMMIT, DILIGENT_CORE_COMMIT, readDiligentLock, clipDiligentHistory } from "../../../scripts/ao-reference/diligent-sources.js";
import { diligentQualityProblems } from "../../../scripts/ao-reference/diligent-quality.js";

const config = { width: 668, height: 536, warmup: 32, travel: 32, hold: 16, step: 0.01 };

describe("native Diligent temporal reference contract", () => {
    it("preserves the AOF1 half-float scalar contract when capturing native AO bytes", () => {
        expect(unorm8ToHalf(0)).toBe(0);
        expect(unorm8ToHalf(1)).toBe(0x1c04);
        expect(unorm8ToHalf(255)).toBe(0x3c00);
        for (let value = 0; value < 256; value++) {
            expect(Math.round(halfToFloat(unorm8ToHalf(value)) * 255)).toBe(value);
        }
        expect(() => unorm8ToHalf(-1)).toThrow("AO byte");
        expect(() => unorm8ToHalf(256)).toThrow("AO byte");
    });
    it("rejects a low-ghosting candidate that brings shimmer back", () => {
        const baseline = { floorFlickerRms: 0.0068, floorResidualRms: 0.054, maximumExcessTrail: 0.067, pairs: 1000 };
        const good = { floorFlickerRms: 0.0073, floorResidualRms: 0.015, maximumExcessTrail: 0.005, pairs: 1000 };
        const quality = { blite: good, shared: baseline, clipped: good };
        const held = { blite: 0.0027, shared: 0.0032, clipped: 0.0023 };
        expect(diligentQualityProblems(quality, held)).toEqual([]);
        expect(diligentQualityProblems({ ...quality, clipped: { ...good, floorFlickerRms: 0.0147 } }, held)).toContain("History clipping reintroduced moving-floor shimmer.");
        expect(diligentQualityProblems({ ...quality, clipped: { ...good, maximumExcessTrail: 0.03 } }, held)).toContain("clipped retained too much stale occlusion.");
        expect(diligentQualityProblems({ ...quality, clipped: { ...good, pairs: 0 } }, held).join(" ")).toContain("insufficient");
    });
    it("adds an explicit history clamp without shortening or replacing upstream history", () => {
        const marker = "Reprojection.History = IsInsideRange ? Reprojection.History : max(1.0, MotionFactor * Reprojection.History);";
        const source = `before\n${marker}\nafter`;
        const derived = clipDiligentHistory(source);
        expect(derived).toBe(`before\n${marker}
        float ClipGamma = SSAO_TEMPORAL_MIN_VARIANCE_GAMMA;
        Reprojection.Occlusion = clamp(Reprojection.Occlusion, PixelStat.Mean - ClipGamma * PixelStat.StdDev, PixelStat.Mean + ClipGamma * PixelStat.StdDev);\nafter`);
        expect(() => clipDiligentHistory("changed upstream")).toThrow("exactly once");
        expect(() => clipDiligentHistory(source + source)).toThrow("exactly once");
    });
    it("pins the original shader graph and platform preamble, not a WGSL oracle", async () => {
        const lock = await readDiligentLock();
        expect(lock.commit).toBe(DILIGENT_COMMIT);
        expect(new Set(lock.sources.map((source) => source.name)).size).toBe(lock.sources.length);
        expect(lock.sources.find((source) => source.name === "HLSLDefinitions.fxh")?.commit).toBe(DILIGENT_CORE_COMMIT);
        for (const name of [
            "ComputeBlueNoiseTexture.fx",
            "ComputeReprojectedDepth.fx",
            "ComputeClosestMotion.fx",
            "SSAO_ComputeAmbientOcclusion.fx",
            "SSAO_ComputeTemporalAccumulation.fx",
            "SSAO_ComputeConvolutedDepthHistory.fx",
            "SSAO_ComputeResampledHistory.fx",
            "SSAO_ComputeSpatialReconstruction.fx",
        ]) {
            expect(lock.sources.some((source) => source.name === name)).toBe(true);
        }
        for (const source of lock.sources) {
            expect(source.commit).toMatch(/^[a-f0-9]{40}$/);
            expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
            expect(source.path).not.toContain(".wgsl");
        }
    });
    it("keeps an independent short guide and reuses depth-validated reprojection weights", () => {
        const markers = [
            "Texture2D<float>  g_TextureCurrOcclusion;",
            "float History   : SV_Target1;",
            "bool   IsSuccess;",
            "Desc.History   = 1.0;",
            "Desc.History = dot(History, Weights) / TotalWeight;",
            "PSOutput Output;",
            "PSOutput ComputeTemporalAccumulationPS(",
            "PixelStatistic PixelStat = ComputePixelStatistic(int2(Position.xy));",
            "Reprojection.History = IsInsideRange ? Reprojection.History : max(1.0, MotionFactor * Reprojection.History);",
        ];
        const derived = clipDiligentHistory(markers.join("\n"), "guide helper");
        expect(derived).toContain("float Guide : SV_Target2;");
        expect(derived).toContain("Desc.Guide = dot(Guides, Weights) / TotalWeight;");
        expect(derived).toContain("Output.Guide = lerp(Reprojection.Guide, Guide.x, 0.75);");
        expect(derived.match(/float2 Guide =/g)).toHaveLength(1);
    });

    it("records warmup, forward motion, a pause, reversal, and rest without position jumps", () => {
        expect(diligentFrameCount(config)).toBe(128);
        expect(diligentFrame(config, 31).stage).toBe("warmup");
        expect(diligentFrame(config, 32).sphereX).toBeCloseTo(-0.79);
        expect(diligentFrame(config, 63).sphereX).toBeCloseTo(-0.48);
        expect(diligentFrame(config, 64).stage).toBe("hold");
        expect(diligentFrame(config, 79).sphereX).toBeCloseTo(-0.48);
        expect(diligentFrame(config, 80).sphereX).toBeCloseTo(-0.49);
        expect(diligentFrame(config, 111).sphereX).toBeCloseTo(-0.8);
        expect(diligentFrame(config, 112).stage).toBe("rest");
        for (let frame = 1; frame < 128; frame++) {
            expect(Math.abs(diligentFrame(config, frame).sphereX - diligentFrame(config, frame - 1).sphereX)).toBeLessThanOrEqual(0.0100000001);
            expect(diligentFrame(config, frame).phase).toBe(frame % 64);
        }
    });

    it("rejects out-of-range frames and invalid capture sizes instead of generating empty references", () => {
        for (const index of [-1, 128, 1.5, NaN]) {
            expect(() => diligentFrame(config, index)).toThrow("frame index");
        }
        for (const invalid of [{ width: 0 }, { height: 4096 }, { warmup: 0 }, { travel: 1.5 }, { hold: -1 }, { step: NaN }, { step: 0 }]) {
            expect(() => validateDiligentConfig({ ...config, ...invalid })).toThrow("configuration");
        }
    });

    it("preserves the native two-camera layout and exact readback sizes", () => {
        expect(DILIGENT_CAMERA_BYTES).toBe(576);
        const pixels = config.width * config.height;
        expect(diligentFrameBytes(config, 1)).toBe(16 + 1152 + pixels * (4 + 8 + 8 + 2 + 2 + 2) + 1);
        expect(diligentFrameBytes(config, 0) - diligentFrameBytes(config, 1)).toBe(pixels * 16);
    });

    it("transposes GPU matrices for HLSL row-vector multiplication without changing surrounding fields", () => {
        const matrix = Float32Array.from({ length: 16 }, (_, i) => i + 1);
        const target = new Float32Array(64).fill(-123);
        transposeCameraMatrix(target, 28, matrix);
        expect(Array.from(target.subarray(28, 44))).toEqual([1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15, 4, 8, 12, 16]);
        expect(target[27]).toBe(-123);
        expect(target[44]).toBe(-123);
    });

    it("decodes normal, subnormal, signed, and non-finite half values explicitly", () => {
        expect(halfToFloat(0x3c00)).toBe(1);
        expect(halfToFloat(0x3800)).toBe(0.5);
        expect(halfToFloat(0xbc00)).toBe(-1);
        expect(halfToFloat(1)).toBe(2 ** -24);
        expect(Object.is(halfToFloat(0x8000), -0)).toBe(true);
        expect(halfToFloat(0x7c00)).toBe(Infinity);
        expect(halfToFloat(0x7e00)).toBeNaN();
    });

    it("decodes the world-normal attachment bias instead of treating it as signed view normals", () => {
        expect([0x3800, 0x3c00, 0x3800].map(decodeWorldNormalHalf)).toEqual([0, 1, 0]);
        expect([0, 0x3800, 0x3c00].map(decodeWorldNormalHalf)).toEqual([-1, 0, 1]);
        expect(() => decodeWorldNormalHalf(0x7e00)).toThrow("encoded");
        expect(() => decodeWorldNormalHalf(0xbc00)).toThrow("encoded");
        expect(decodeWorldNormalHalf(0x8001)).toBe(-1 - 2 ** -23);
        expect(() => decodeWorldNormalHalf(0x8003)).toThrow("encoded");
    });

    it("accepts the bounded Kitchen camera sequence without changing the legacy frame layout", () => {
        expect(() => validateDiligentConfig({ ...config, scene: "kitchen" })).not.toThrow();
        expect(diligentFrameBytes({ ...config, scene: "kitchen" }, 0)).toBe(diligentFrameBytes(config, 0));
        expect(() => validateDiligentConfig({ ...config, scene: "kitchen", withReferenceMean: true })).toThrow("configuration");
    });
});
