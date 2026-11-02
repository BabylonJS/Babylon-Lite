import type { SsaoQuality } from "../../packages/babylon-lite/src/post-process/ssao-gpu.js";

export interface SsaoProfileOptions {
    samples: number;
    quality: SsaoQuality;
    comparePruning: boolean;
}

export function parseSsaoProfileOptions(args: readonly string[]): SsaoProfileOptions {
    const result: SsaoProfileOptions = { samples: 120, quality: "high", comparePruning: false };
    const seen = new Set<string>();
    for (const arg of args) {
        if (arg === "--compare-pruning") {
            if (seen.has(arg)) throw new Error(`Duplicate SSAO profile option: ${arg}`);
            seen.add(arg);
            result.comparePruning = true;
            continue;
        }
        const parts = arg.split("=");
        const [key, value] = parts;
        if (parts.length !== 2) {
            throw new Error(`Invalid SSAO profile option: ${arg}`);
        }
        if (!key || seen.has(key)) {
            throw new Error(`Duplicate SSAO profile option: ${arg}`);
        }
        seen.add(key);
        if (key === "--samples" && value && /^\d+$/.test(value)) {
            result.samples = Number(value);
        } else if (key === "--quality" && (value === "low" || value === "medium" || value === "high" || value === "ultra")) {
            result.quality = value;
        } else {
            throw new Error(`Invalid SSAO profile option: ${arg}`);
        }
    }
    if (!Number.isSafeInteger(result.samples) || result.samples < 16 || result.samples > 512) {
        throw new Error("SSAO profile samples must be an integer in [16, 512].");
    }
    return result;
}

export interface ProfileTexture {
    label: string;
    width: number;
    height: number;
    depthOrArrayLayers: number;
    mipLevelCount: number;
    sampleCount: number;
    dimension: GPUTextureDimension;
    format: GPUTextureFormat;
}

/** Nominal live texel payload; not allocation alignment or driver residency. */
export function ssaoTextureBytes(texture: ProfileTexture): number {
    const formats: Partial<Record<GPUTextureFormat, number>> = {
        r8unorm: 1,
        r16float: 2,
        rg16float: 4,
        r32float: 4,
        r32uint: 4,
        depth32float: 4,
        rg32uint: 8,
        rgba16float: 8,
        rgba32float: 16,
        rgba32uint: 16,
    };
    const stride = formats[texture.format];
    if (!stride || texture.dimension !== "2d") {
        throw new Error(`Unsupported SSAO profile texture: ${texture.dimension}/${texture.format}`);
    }
    const dimensions = [texture.width, texture.height, texture.depthOrArrayLayers, texture.mipLevelCount, texture.sampleCount];
    if (dimensions.some((value) => !Number.isSafeInteger(value) || value < 1)) {
        throw new Error("SSAO profile texture dimensions, mips and samples must be positive integers.");
    }
    let pixels = 0;
    for (let mip = 0; mip < texture.mipLevelCount; mip++) {
        pixels += Math.max(1, Math.floor(texture.width / 2 ** mip)) * Math.max(1, Math.floor(texture.height / 2 ** mip));
    }
    return pixels * stride * texture.depthOrArrayLayers * texture.sampleCount;
}

export function summarizeSsaoSamples(values: readonly number[]) {
    if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0)) {
        throw new Error("SSAO timing samples must be nonempty, finite and nonnegative.");
    }
    const sorted = [...values].sort((a, b) => a - b);
    return {
        samples: values.length,
        meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
        medianMs: (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2,
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
        zeroSamples: values.filter((value) => value === 0).length,
    };
}

/** Sum duplicate stages per frame, retaining execution order and quantized zeros. */
export function decodeSsaoPassTimes(names: readonly string[], timestamps: BigUint64Array): Record<string, number> {
    if (timestamps.length !== names.length * 2 || !names.length) {
        throw new Error("SSAO timestamp count does not match recorded passes.");
    }
    const result: Record<string, number> = {};
    for (let i = 0; i < names.length; i++) {
        const duration = timestamps[i * 2 + 1]! - timestamps[i * 2]!;
        if (!names[i] || duration < 0n) {
            throw new Error("Invalid SSAO pass label or reversed GPU timestamps.");
        }
        result[names[i]!] = (result[names[i]!] ?? 0) + Number(duration) / 1e6;
    }
    return result;
}

export interface SsaoFrameDigest {
    frame: number;
    aoSha256: string;
    countSha256: string;
    aoBytes: number;
    countBytes: number;
    maskDrawVertices?: number;
}

/** No tolerance: pruning is work selection, not a different reconstruction. */
export function verifySsaoPruningFrames(off: readonly SsaoFrameDigest[], on: readonly SsaoFrameDigest[]) {
    if (!off.length || off.length !== on.length) throw new Error("Pruning comparison frame counts differ or are empty.");
    let comparedBytes = 0;
    for (let i = 0; i < off.length; i++) {
        const a = off[i]!,
            b = on[i]!;
        if (
            a.frame !== i ||
            b.frame !== i ||
            !Number.isSafeInteger(a.aoBytes) ||
            !Number.isSafeInteger(a.countBytes) ||
            a.aoBytes < 1 ||
            a.countBytes < 1 ||
            a.aoBytes !== b.aoBytes ||
            a.countBytes !== b.countBytes
        ) {
            throw new Error(`Pruning comparison dimensions or frame indices differ at frame ${i}.`);
        }
        for (const field of ["aoSha256", "countSha256"] as const) {
            if (!/^[a-f0-9]{64}$/.test(a[field]) || a[field] !== b[field]) {
                throw new Error(`Pruning ${field === "aoSha256" ? "AO output" : "history count"} mismatch at frame ${i}: off=${a[field]}, on=${b[field]}.`);
            }
        }
        comparedBytes += a.aoBytes + a.countBytes;
    }
    return { equivalent: true, frames: off.length, comparedBytes };
}

/** Balanced block order; every variant gets exactly the requested sample count. */
export function ssaoPruningBlocks(samples: number) {
    if (!Number.isSafeInteger(samples) || samples < 16 || samples > 512) throw new Error("Invalid pruning comparison sample count.");
    return [false, true, true, false].map((first, i) => ({
        samples: Math.floor(samples / 4) + (i < samples % 4 ? 1 : 0),
        order: [first, !first],
    }));
}

/** Exact test-only source seams; never alter the production demo file. */
export function adaptSsaoProfileDemo(source: string): string {
    const replace = (before: string, after: string): void => {
        if (source.split(before).length !== 2) {
            throw new Error(`SSAO diagnostic source hook must occur exactly once: ${before}`);
        }
        source = source.replace(before, after);
    };
    replace(
        "    const scene = createSceneContext(engine, { defaultRenderTask: false });",
        `    const audit = observeSsaoProfile(engine);\n    const scene = createSceneContext(engine, { defaultRenderTask: false });`
    );
    replace(
        "    await startEngine(engine);",
        `    exposeSsaoProfile(audit, engine, ao, temporal, geometry.geometryViewNormalTexture!, geometry.geometryLinearVelocityTexture!, camera, () => { time = 0; sphere.position.x = 1.3; });`
    );
    return `import { observeSsaoProfile, exposeSsaoProfile } from "../../../../scripts/ao-reference/ssao-profile-client.js";\n${source}`;
}
