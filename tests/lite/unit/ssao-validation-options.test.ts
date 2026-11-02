import { describe, expect, it } from "vitest";
import { parseTemporalValidationOptions, temporalValidationLaunchOptions } from "../../../scripts/ao-reference/temporal-validation-options.js";

describe("temporal AO validation routing", () => {
    it("defaults to the shipped production pipeline, not the historical prototype", () => {
        expect(parseTemporalValidationOptions([])).toEqual({
            suite: "production",
            profile: "default",
            halfResolution: false,
            software: false,
        });
        expect(parseTemporalValidationOptions(["--diligent"])).toEqual(parseTemporalValidationOptions([]));
    });
    it.each([
        { args: ["--legacy"], suite: "legacy", profile: "default", halfResolution: false },
        { args: ["--half"], suite: "half", profile: "default", halfResolution: true },
        { args: ["--moving"], suite: "moving", profile: "default", halfResolution: false },
        { args: ["--close-up"], suite: "moving", profile: "close-up", halfResolution: false },
        { args: ["--half", "--close-up"], suite: "moving", profile: "close-up", halfResolution: true },
        { args: ["--moving", "--half", "--close-up-reversal"], suite: "moving", profile: "close-up-reversal", halfResolution: true },
    ])("selects $suite with $args", ({ args, ...expected }) => {
        expect(parseTemporalValidationOptions(args)).toEqual({ ...expected, software: false });
        expect(parseTemporalValidationOptions([...args, "--software"])).toEqual({ ...expected, software: true });
    });
    it("keeps explicit software rendering on the production suite by default", () => {
        expect(parseTemporalValidationOptions(["--software"])).toEqual({ ...parseTemporalValidationOptions([]), software: true });
    });
    it.each([
        ["--quarter"],
        ["--legacy", "--diligent"],
        ["--legacy", "--half"],
        ["--legacy", "--quarter"],
        ["--half", "--quarter"],
        ["--legacy", "--moving"],
        ["--legacy", "--close-up"],
        ["--diligent", "--half"],
        ["--diligent", "--quarter"],
        ["--diligent", "--moving"],
        ["--close-up", "--close-up-reversal"],
        ["--unknown"],
    ])("rejects ambiguous or unknown selectors %s", (...args) => {
        expect(() => parseTemporalValidationOptions(args)).toThrow();
    });
});

describe("temporal AO browser selection", () => {
    it("keeps installed Windows Edge and native GPU defaults", () => {
        expect(temporalValidationLaunchOptions(false, "win32")).toEqual({ channel: "msedge", headless: true });
    });
    it.each(["linux", "darwin"] as const)("uses Playwright Chromium on %s without forcing software rendering", (platform) => {
        expect(temporalValidationLaunchOptions(false, platform)).toEqual({ channel: "chromium", headless: true });
    });
    it("opts into isolated software WebGPU for CI without a fallback or timestamp override", () => {
        const options = temporalValidationLaunchOptions(true, "linux");
        expect(options.channel).toBe("chromium");
        expect(options.headless).toBe(true);
        expect(options.args).toEqual(["--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader"]);
        expect(options.args?.some((arg) => arg.includes("timestamp_quantization"))).toBe(false);
    });
});
