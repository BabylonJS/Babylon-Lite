import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface AoSource {
    name: string;
    repository: string;
    commit: string;
    path: string;
    sha256: string;
}

const XE_COMMIT = "a5b1686c7ea37788eeb3576b5be47f7c03db532c";
const FILAMENT_COMMIT = "764fe6cac9bdb4ba24d3d852344dfa04a5f70f75";

export const AO_SOURCES: readonly AoSource[] = [
    {
        name: "XeGTAO.h",
        repository: "GameTechDev/XeGTAO",
        commit: XE_COMMIT,
        path: "Source/Rendering/Shaders/XeGTAO.h",
        sha256: "c3a9ee2bcbd71b5e54a5438e8a803dc8118483e455bc920c15c30cb30a49eee1",
    },
    {
        name: "XeGTAO.hlsli",
        repository: "GameTechDev/XeGTAO",
        commit: XE_COMMIT,
        path: "Source/Rendering/Shaders/XeGTAO.hlsli",
        sha256: "30faf4f5013916c14694db20fe9ec7f0c786f2edac7610968f9391987115064e",
    },
    { name: "XeGTAO-LICENSE", repository: "GameTechDev/XeGTAO", commit: XE_COMMIT, path: "LICENSE", sha256: "1f3bfd6b628535f0f0e779e70c260cfdc1bb45bc8644d7108e65f83e24a05cba" },
    {
        name: "gtaoImpl.fs",
        repository: "google/filament",
        commit: FILAMENT_COMMIT,
        path: "filament/src/materials/ssao/gtaoImpl.fs",
        sha256: "95f6842fea4519b63ec38e959149d66464528ab4c8bc04d3c456cd2718a822ce",
    },
    {
        name: "geometry.fs",
        repository: "google/filament",
        commit: FILAMENT_COMMIT,
        path: "filament/src/materials/utils/geometry.fs",
        sha256: "f540fa12ddb85da942f85ab690bdce3179a2ddcb6fdf348c5416262d94907d47",
    },
    {
        name: "common_math.glsl",
        repository: "google/filament",
        commit: FILAMENT_COMMIT,
        path: "shaders/src/common_math.glsl",
        sha256: "e8176399c00480350fd1a25a993c0cf7a4fefe388e55508945fc935474d66703",
    },
    {
        name: "Filament-LICENSE",
        repository: "google/filament",
        commit: FILAMENT_COMMIT,
        path: "LICENSE",
        sha256: "02d70b593dd8e9355dd8e1ca8d13c303bee5bcaf3065b66ff6e4f534e1e6a2c1",
    },
];

export function sha256(bytes: Uint8Array | string): string {
    return createHash("sha256").update(bytes).digest("hex");
}

export function verifyAoSource(source: AoSource, bytes: Uint8Array): void {
    if (!/^[a-f0-9]{40}$/.test(source.commit) || !/^[a-f0-9]{64}$/.test(source.sha256)) {
        throw new Error(`Invalid immutable source pin: ${source.name}`);
    }
    const actual = sha256(bytes);
    if (actual !== source.sha256) {
        throw new Error(`AO reference source hash mismatch for ${source.name}: expected ${source.sha256}, got ${actual}`);
    }
}

export async function fetchAoSources(directory: string): Promise<Map<string, string>> {
    await mkdir(directory, { recursive: true });
    const result = new Map<string, string>();
    await Promise.all(
        AO_SOURCES.map(async (source) => {
            const path = join(directory, source.name);
            let bytes: Buffer;
            try {
                bytes = await readFile(path);
            } catch (error) {
                if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
                    throw error;
                }
                const url = `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.path}`;
                const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
                if (!response.ok) {
                    throw new Error(`Cannot download ${source.name}: HTTP ${response.status}`);
                }
                bytes = Buffer.from(await response.arrayBuffer());
                verifyAoSource(source, bytes);
                await writeFile(path, bytes);
            }
            verifyAoSource(source, bytes);
            result.set(source.name, bytes.toString("utf8"));
        })
    );
    return result;
}

export function extractShaderFunction(source: string, signature: string): string {
    const start = source.indexOf(signature);
    if (start < 0 || source.indexOf(signature, start + signature.length) >= 0) {
        throw new Error(`Expected exactly one upstream function: ${signature}`);
    }
    const opening = source.indexOf("{", start);
    let depth = 1;
    for (let i = opening + 1; opening >= 0 && i < source.length; i++) {
        if (source[i] === "{") depth++;
        if (source[i] === "}") depth--;
        if (depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`Unterminated upstream shader function: ${signature}`);
}

export function adaptXeIntegerSwizzles(source: string): string {
    // FXC rejects DXC's integer-literal swizzles; these are identical uint vectors.
    const replacements = [
        ["groupThreadID.xy % 2.xx", "groupThreadID.xy % uint2(2, 2)"],
        ["groupThreadID.xy % 4.xx", "groupThreadID.xy % uint2(4, 4)"],
        ["groupThreadID.xy % 8.xx", "groupThreadID.xy % uint2(8, 8)"],
        ["dot( edgesC_LRTB[side], 1.xxxx )", "dot( edgesC_LRTB[side], float4(1, 1, 1, 1) )"],
    ] as const;
    for (const [token, replacement] of replacements) {
        if (source.indexOf(token) < 0 || source.indexOf(token) !== source.lastIndexOf(token)) {
            throw new Error(`Unexpected upstream XeGTAO prefilter spelling: ${token}`);
        }
        source = source.replace(token, replacement);
    }
    return source;
}

export async function assembleAoShaders(sources: ReadonlyMap<string, string>, directory: string): Promise<void> {
    const required = (name: string): string => {
        const source = sources.get(name);
        if (!source) throw new Error(`Missing verified AO source ${name}`);
        return source;
    };
    const hlsl = adaptXeIntegerSwizzles(required("XeGTAO.hlsli")).replace('#include "XeGTAO.h"', "");
    const gtao = required("gtaoImpl.fs").replace('#include "../utils/geometry.fs"', "");
    const geometry = extractShaderFunction(required("geometry.fs"), "highp vec3 computeViewSpacePositionFromDepth(");
    const acos = extractShaderFunction(required("common_math.glsl"), "float acosFast(float x)");
    const xeAdapter = await readFile(new URL("./xegtao-adapter.hlsl", import.meta.url), "utf8");
    const vbAdapter = await readFile(new URL("./vbao-adapter.glsl", import.meta.url), "utf8");
    const slopeSafeSampling = await readFile(new URL("./vbao-slope-safe-sampling.glsl", import.meta.url), "utf8");
    const originalSampling = extractShaderFunction(vbAdapter, "highp float sampleDepthLinear(");
    const filamentShader = vbAdapter.replace("/* UPSTREAM */", `${geometry}\n${acos}\n${gtao}`);
    const slopeSafeShader = filamentShader.replace(originalSampling, slopeSafeSampling.trimEnd());
    const sampleProbe = slopeSafeShader.replace(
        "vec2 uv = gl_FragCoord.xy * materialParams.resolution.zw;",
        `vec2 uv = gl_FragCoord.xy * materialParams.resolution.zw;
    if (materialParams.stepsPerSlice == 3.0) {
        visibility = -sampleDepthLinear(materialParams_depth, uv + 0.25 * materialParams.resolution.zw, 0.0);
        return;
    }`
    );
    await mkdir(directory, { recursive: true });
    await Promise.all([
        writeFile(join(directory, "reference.hlsl"), xeAdapter.replace("/* UPSTREAM */", `${required("XeGTAO.h")}\n${hlsl}`)),
        writeFile(join(directory, "reference.frag"), filamentShader),
        writeFile(join(directory, "reference-slope-safe.frag"), slopeSafeShader),
        writeFile(join(directory, "reference-slope-safe-probe.frag"), sampleProbe),
    ]);
}
