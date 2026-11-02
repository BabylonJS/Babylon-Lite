import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256, verifyAoSource } from "./sources.js";
import type { AoSource } from "./sources.js";

export const DILIGENT_COMMIT = "eaf6ab785968bdee2393210c5a67033a4d9140cc";
export const DILIGENT_CORE_COMMIT = "074060cfd1db73064d7a18cf40df86af6531520c";
const REPOSITORY = "DiligentGraphics/DiligentFX";
const LOCK = new URL("./diligent-source-lock.json", import.meta.url);
const ENTRIES = [
    "FullScreenTriangleVS.fx",
    "ComputeBlueNoiseTexture.fx",
    "ComputeReprojectedDepth.fx",
    "ComputeClosestMotion.fx",
    "SSAO_ComputePrefilteredDepthBuffer.fx",
    "SSAO_ComputeAmbientOcclusion.fx",
    "SSAO_ComputeTemporalAccumulation.fx",
    "SSAO_ComputeConvolutedDepthHistory.fx",
    "SSAO_ComputeResampledHistory.fx",
    "SSAO_ComputeSpatialReconstruction.fx",
];

export interface DiligentSourceLock {
    schema: "diligent-ao-source-v1";
    commit: string;
    sources: AoSource[];
}

export async function readDiligentLock(): Promise<DiligentSourceLock> {
    const lock = JSON.parse(await readFile(LOCK, "utf8")) as DiligentSourceLock;
    if (lock.schema !== "diligent-ao-source-v1" || lock.commit !== DILIGENT_COMMIT || !Array.isArray(lock.sources) || !lock.sources.length) {
        throw new Error("Invalid Diligent AO source lock.");
    }
    const names = new Set<string>();
    for (const source of lock.sources) {
        const pinned =
            (source.repository === REPOSITORY && source.commit === DILIGENT_COMMIT) ||
            (source.repository === "DiligentGraphics/DiligentCore" && source.commit === DILIGENT_CORE_COMMIT && source.name === "HLSLDefinitions.fxh");
        if (!pinned || basename(source.name) !== source.name || names.has(source.name)) {
            throw new Error(`Invalid/duplicate Diligent source: ${source.name}`);
        }
        names.add(source.name);
    }
    return lock;
}

export async function prepareDiligentSources(directory: string): Promise<DiligentSourceLock> {
    const lock = await readDiligentLock();
    await mkdir(directory, { recursive: true });
    await Promise.all(
        lock.sources.map(async (source) => {
            const path = join(directory, source.name);
            let bytes: Buffer;
            try {
                bytes = await readFile(path);
            } catch (error) {
                if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
                const response = await fetch(`https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.path}`, { signal: AbortSignal.timeout(60_000) });
                if (!response.ok) throw new Error(`Cannot download ${source.name}: HTTP ${response.status}`);
                bytes = Buffer.from(await response.arrayBuffer());
                verifyAoSource(source, bytes);
                await writeFile(path, bytes);
            }
            verifyAoSource(source, bytes);
        })
    );
    const temporal = await readFile(join(directory, "SSAO_ComputeTemporalAccumulation.fx"), "utf8");
    const guide = await readFile(new URL("./diligent-history-guide.hlsl", import.meta.url), "utf8");
    await writeFile(join(directory, "SSAO_ComputeTemporalAccumulation_Clipped.fx"), clipDiligentHistory(temporal, guide));
    return lock;
}

export function clipDiligentHistory(source: string, guide?: string): string {
    const marker = "Reprojection.History = IsInsideRange ? Reprojection.History : max(1.0, MotionFactor * Reprojection.History);";
    if (source.indexOf(marker) < 0 || source.indexOf(marker) !== source.lastIndexOf(marker)) {
        throw new Error("The pinned Diligent history-clipping insertion did not match exactly once.");
    }
    if (guide) {
        const replaceOnce = (token: string, replacement: string): void => {
            if (source.indexOf(token) < 0 || source.indexOf(token) !== source.lastIndexOf(token))
                throw new Error(`The Diligent guide-history insertion did not match exactly once: ${token}`);
            source = source.replace(token, replacement);
        };
        replaceOnce("Texture2D<float>  g_TextureCurrOcclusion;", "Texture2D<float> g_ClipPreviousGuide;\nTexture2D<float>  g_TextureCurrOcclusion;");
        replaceOnce("float History   : SV_Target1;", "float History   : SV_Target1;\n    float Guide : SV_Target2;");
        replaceOnce("bool   IsSuccess;", "float Guide;\n    bool   IsSuccess;");
        replaceOnce("Desc.History   = 1.0;", "Desc.History   = 1.0;\n    Desc.Guide = 1.0;");
        replaceOnce(
            "Desc.History = dot(History, Weights) / TotalWeight;",
            `Desc.History = dot(History, Weights) / TotalWeight;
        float4 Guides = float4(g_ClipPreviousGuide.Load(int3(FetchCoords.xy,0)), g_ClipPreviousGuide.Load(int3(FetchCoords.zy,0)),
                               g_ClipPreviousGuide.Load(int3(FetchCoords.xw,0)), g_ClipPreviousGuide.Load(int3(FetchCoords.zw,0)));
        Desc.Guide = dot(Guides, Weights) / TotalWeight;`
        );
        replaceOnce("PSOutput Output;", "float2 Guide = DiligentHistoryGuideStatistic(int2(Position.xy));\n    PSOutput Output;\n    Output.Guide = Guide.x;");
        const entry = "PSOutput ComputeTemporalAccumulationPS(";
        const statistics = "PixelStatistic PixelStat = ComputePixelStatistic(int2(Position.xy));";
        if (
            source.indexOf(entry) !== source.lastIndexOf(entry) ||
            source.indexOf(entry) < 0 ||
            source.indexOf(statistics) !== source.lastIndexOf(statistics) ||
            source.indexOf(statistics) < 0
        ) {
            throw new Error("The Diligent guide insertion did not match exactly once.");
        }
        source = source.replace(entry, `${guide}\n${entry}`).replace(
            statistics,
            `${statistics}
        Output.Guide = lerp(Reprojection.Guide, Guide.x, 0.75);
        PixelStat.Mean = Output.Guide;
        PixelStat.Variance = min(PixelStat.Variance, Guide.y);
        PixelStat.StdDev = sqrt(max(0.0, PixelStat.Variance));`
        );
    }
    return source.replace(
        marker,
        `${marker}
        float ClipGamma = SSAO_TEMPORAL_MIN_VARIANCE_GAMMA;
        Reprojection.Occlusion = clamp(Reprojection.Occlusion, PixelStat.Mean - ClipGamma * PixelStat.StdDev, PixelStat.Mean + ClipGamma * PixelStat.StdDev);`
    );
}

async function download(path: string): Promise<Buffer> {
    const response = await fetch(`https://raw.githubusercontent.com/${REPOSITORY}/${DILIGENT_COMMIT}/${path}`, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
        throw new Error(`Cannot download pinned Diligent source ${path}: HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

/** Create provenance once; subsequent generation cannot silently redefine the oracle. */
async function pinDiligentSources(): Promise<void> {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/git/trees/${DILIGENT_COMMIT}?recursive=1`, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
        throw new Error(`Cannot resolve the pinned Diligent source tree: HTTP ${response.status}`);
    }
    const tree = (await response.json()) as { tree: { path: string; type: string }[]; truncated?: boolean };
    if (!Array.isArray(tree.tree) || tree.truncated) {
        throw new Error("Diligent source tree was incomplete.");
    }
    const index = new Map<string, string>();
    for (const file of tree.tree) {
        if (file.type !== "blob" || !file.path.startsWith("Shaders/")) {
            continue;
        }
        const name = basename(file.path);
        if (index.has(name)) {
            throw new Error(`Ambiguous Diligent shader include ${name}.`);
        }
        index.set(name, file.path);
    }
    const pending = [
        ...ENTRIES.map((name) => {
            const path = index.get(name);
            if (!path) {
                throw new Error(`Missing Diligent entry shader ${name}.`);
            }
            return path;
        }),
        "PostProcess/ScreenSpaceAmbientOcclusion/src/ScreenSpaceAmbientOcclusion.cpp",
        "PostProcess/ScreenSpaceAmbientOcclusion/interface/ScreenSpaceAmbientOcclusion.hpp",
        "PostProcess/Common/src/PostFXContext.cpp",
        "License.txt",
    ];
    const sources: AoSource[] = [];
    const seen = new Set<string>();
    while (pending.length) {
        const path = pending.shift()!;
        if (seen.has(path)) {
            continue;
        }
        seen.add(path);
        const bytes = await download(path);
        const text = bytes.toString("utf8");
        sources.push({ name: basename(path), repository: REPOSITORY, commit: DILIGENT_COMMIT, path, sha256: sha256(bytes) });
        if (/\.(fx|fxh)$/.test(path)) {
            for (const match of text.matchAll(/^\s*#\s*include\s+"([^"]+\.(?:fx|fxh))"/gm)) {
                const dependency = index.get(match[1]!);
                if (!dependency) {
                    throw new Error(`Unresolved upstream shader include ${match[1]} in ${path}.`);
                }
                pending.push(dependency);
            }
        }
    }
    sources.sort((a, b) => a.path.localeCompare(b.path));
    const platform = {
        name: "HLSLDefinitions.fxh",
        repository: "DiligentGraphics/DiligentCore",
        commit: DILIGENT_CORE_COMMIT,
        path: "Graphics/ShaderTools/include/HLSLDefinitions.fxh",
        sha256: "499f185241af665e1d9d695d1f80e245b1287ea759d3a1abaa758a023ad4e44c",
    };
    sources.push(platform);
    const lock: DiligentSourceLock = { schema: "diligent-ao-source-v1", commit: DILIGENT_COMMIT, sources };
    await writeFile(LOCK, JSON.stringify(lock, null, 4) + "\n", { flag: "wx" });
    console.log(`Pinned ${sources.length} original DiligentFX sources at ${DILIGENT_COMMIT}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (!process.argv.includes("--pin")) {
        throw new Error("Use --pin only when creating the initial Diligent source lock.");
    }
    void pinDiligentSources().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
