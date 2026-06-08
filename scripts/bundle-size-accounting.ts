import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { gzipSync } from "zlib";

/** Human-readable label for the ignored-module set used in test/log output. */
export const IGNORED_BUNDLE_MODULE_PATTERN = "*-nme.ts + text-shaper";

export interface RuntimeJsPayload {
    file: string;
    body: Buffer;
}

export interface IgnoredBundleModule {
    chunk: string;
    id: string;
    bytes: number;
}

interface BundleInfoModule {
    id: string;
    bytes: number;
}

interface BundleInfoChunk {
    file: string;
    modules: BundleInfoModule[];
}

interface BundleInfo {
    chunks: BundleInfoChunk[];
}

export interface RuntimeBundleSummary {
    rawBytes: number;
    gzipBytes: number;
    fetchedRawBytes: number;
    ignoredRawBytes: number;
    ignoredModules: IgnoredBundleModule[];
}

/** A module is excluded from the runtime-code measurement when it is either:
 *    1. A scene-specific NME data payload (`*-nme.ts`) — checked-in scene data,
 *       not engine code, so ceiling drift should not track it.
 *    2. The `text-shaper` third-party shaping library — only loaded by the
 *       default-layout text path (`createDefaultTextData` and friends). Callers
 *       using `GlyphStorage` + `TextData` with their own layout pay zero for it,
 *       so it should not count against engine-size ceilings. */
function isIgnoredBundleModule(id: string): boolean {
    const clean = id.replace(/\\/g, "/").split("?")[0]!;
    return /(?:^|\/)[^/]+-nme\.ts$/.test(clean) || /(?:^|\/)text-shaper\//.test(clean);
}

export function findIgnoredBundleModules(bundleInfoDir: string, scene: string, runtimeChunks: Iterable<string>): IgnoredBundleModule[] {
    const infoPath = resolve(bundleInfoDir, `${scene}.json`);
    if (!existsSync(infoPath)) {
        return [];
    }

    const loadedChunks = new Set(Array.from(runtimeChunks, (chunk) => chunk.replace(/\\/g, "/").split("?")[0]!));
    const info = JSON.parse(readFileSync(infoPath, "utf-8")) as BundleInfo;
    const ignored: IgnoredBundleModule[] = [];

    for (const chunk of info.chunks ?? []) {
        if (!loadedChunks.has(chunk.file)) {
            continue;
        }
        for (const module of chunk.modules ?? []) {
            if (isIgnoredBundleModule(module.id) && module.bytes > 0) {
                ignored.push({ chunk: chunk.file, id: module.id, bytes: module.bytes });
            }
        }
    }

    return ignored;
}

/** Return the set of fetched chunk file names whose content is entirely from ignored
 *  modules. Such chunks contribute zero useful bytes to the runtime measurement, so
 *  both their raw AND gzipped sizes can be subtracted from the totals. Mixed chunks
 *  (with some ignored + some kept modules) stay in the totals and only their ignored
 *  modules' raw bytes are netted out — there's no way to compute gzip subset sizes
 *  inside a single chunk because gzip is not compositional. */
function findFullyIgnoredChunks(bundleInfoDir: string, scene: string, runtimeChunks: Iterable<string>): Set<string> {
    const infoPath = resolve(bundleInfoDir, `${scene}.json`);
    if (!existsSync(infoPath)) {
        return new Set();
    }
    const loaded = new Set(Array.from(runtimeChunks, (chunk) => chunk.replace(/\\/g, "/").split("?")[0]!));
    const info = JSON.parse(readFileSync(infoPath, "utf-8")) as BundleInfo;
    const out = new Set<string>();
    for (const chunk of info.chunks ?? []) {
        if (!loaded.has(chunk.file) || !chunk.modules || chunk.modules.length === 0) {
            continue;
        }
        const allIgnored = chunk.modules.every((module) => isIgnoredBundleModule(module.id));
        if (allIgnored) {
            out.add(chunk.file);
        }
    }
    return out;
}

export function summarizeRuntimeBundle(payloads: RuntimeJsPayload[], bundleInfoDir: string, scene: string): RuntimeBundleSummary {
    // A single chunk can be fetched more than once during a page load (e.g. requested
    // by multiple importers). Deduplicate by file so the raw/gzip sums reflect the
    // distinct chunk bytes — matching the deduplicated chunk list — instead of
    // double-counting re-fetched chunks.
    const uniquePayloads = new Map<string, RuntimeJsPayload>();
    for (const payload of payloads) {
        if (!uniquePayloads.has(payload.file)) {
            uniquePayloads.set(payload.file, payload);
        }
    }
    const dedupedPayloads = Array.from(uniquePayloads.values());
    const fetchedRawBytes = dedupedPayloads.reduce((sum, payload) => sum + payload.body.length, 0);
    const fullyIgnoredChunks = findFullyIgnoredChunks(
        bundleInfoDir,
        scene,
        dedupedPayloads.map((payload) => payload.file)
    );
    // gzip is not compositional, so we can only subtract whole-chunk contributions:
    // a chunk whose every module is ignored is dropped from gzipBytes entirely.
    // Mixed chunks stay whole — their ignored modules' raw bytes still net out of
    // rawBytes but their gzip contribution is left intact (and counted as overhead).
    const gzipBytes = dedupedPayloads.reduce((sum, payload) => {
        if (fullyIgnoredChunks.has(payload.file)) {
            return sum;
        }
        return sum + gzipSync(payload.body, { level: 9 }).length;
    }, 0);
    const ignoredModules = findIgnoredBundleModules(
        bundleInfoDir,
        scene,
        dedupedPayloads.map((payload) => payload.file)
    );
    const ignoredRawBytes = ignoredModules.reduce((sum, module) => sum + module.bytes, 0);
    return {
        rawBytes: Math.max(0, fetchedRawBytes - ignoredRawBytes),
        gzipBytes,
        fetchedRawBytes,
        ignoredRawBytes,
        ignoredModules,
    };
}

export function bytesToRoundedKB(bytes: number): number {
    return Math.round((bytes / 1024) * 10) / 10;
}
