import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { gzipSync } from "zlib";

export const IGNORED_BUNDLE_MODULE_PATTERN = "*-nme.ts";

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

function isIgnoredBundleModule(id: string): boolean {
    const clean = id.replace(/\\/g, "/").split("?")[0]!;
    return /(?:^|\/)[^/]+-nme\.ts$/.test(clean);
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
    const gzipBytes = dedupedPayloads.reduce((sum, payload) => sum + gzipSync(payload.body, { level: 9 }).length, 0);
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
