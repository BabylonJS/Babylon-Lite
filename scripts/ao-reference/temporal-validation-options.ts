import type { LaunchOptions } from "@playwright/test";

export interface TemporalValidationOptions {
    suite: "production" | "legacy" | "half" | "moving";
    profile: "default" | "close-up" | "close-up-reversal";
    halfResolution: boolean;
    software: boolean;
}

/** Select one numerical suite before starting browser or server resources. */
export function parseTemporalValidationOptions(args: readonly string[]): TemporalValidationOptions {
    const allowed = ["--diligent", "--legacy", "--half", "--moving", "--close-up", "--close-up-reversal", "--software"];
    for (const arg of args) {
        if (!allowed.includes(arg)) {
            throw new Error(`Unknown temporal AO validation option: ${arg}`);
        }
    }
    const flags = new Set(args);
    if (flags.has("--close-up") && flags.has("--close-up-reversal")) {
        throw new Error("Select only one temporal AO moving-scene profile.");
    }
    const profile = flags.has("--close-up-reversal") ? "close-up-reversal" : flags.has("--close-up") ? "close-up" : "default";
    const moving = flags.has("--moving") || profile !== "default";
    const halfResolution = flags.has("--half");
    if (flags.has("--legacy") && (flags.has("--diligent") || moving || halfResolution)) {
        throw new Error("--legacy cannot be combined with production, reduced-resolution, or moving-scene selectors.");
    }
    if (flags.has("--diligent") && (moving || halfResolution)) {
        throw new Error("--diligent selects the default production suite; select reduced-resolution or moving checks separately.");
    }
    return {
        suite: flags.has("--legacy") ? "legacy" : moving ? "moving" : halfResolution ? "half" : "production",
        profile,
        halfResolution,
        software: flags.has("--software"),
    };
}

/** Software WebGPU is explicit and isolated to this browser, never an automatic fallback. */
export function temporalValidationLaunchOptions(software: boolean, platform: NodeJS.Platform = process.platform): LaunchOptions {
    return {
        channel: software || platform !== "win32" ? "chromium" : "msedge",
        headless: true,
        ...(software
            ? {
                  args: ["--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader"],
              }
            : {}),
    };
}
