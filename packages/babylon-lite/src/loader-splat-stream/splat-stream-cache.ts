import type { EngineContext } from "../engine/engine.js";
import { retireGpuResources } from "../engine/gpu-resource-retirement.js";
import { createSplatStreamGpuLedger, type SplatStreamGpuLedger } from "./splat-stream-gpu-ledger.js";

/** @internal */
export interface SplatSourceGpuResources {
    readonly textures: readonly GPUTexture[];
    readonly metadataBuffer: GPUBuffer;
}

/** @internal */
export interface SplatSourceCacheEntry {
    readonly url: string;
    readonly generation: number;
    readonly width: number;
    readonly height: number;
    readonly count: number;
    readonly gpuBytes: number;
    readonly cpuBytes: number;
    readonly resources: SplatSourceGpuResources;
    /** True when transport reserved these bytes before creating the GPU resources. */
    readonly gpuReserved?: boolean;
    pinCount: number;
    displayedRefs: number;
    pendingRefs: number;
    activeRefs: number;
    lastUsedFrame: number;
}

/** @internal */
export interface SplatSourceCache {
    readonly maxGpuBytes: number;
    readonly maxCpuBytes: number;
    readonly entries: Map<string, SplatSourceCacheEntry>;
    readonly ledger: SplatStreamGpuLedger;
    residentGpuBytes: number;
    allocatedGpuBytes: number;
    retiringGpuBytes: number;
    residentCpuBytes: number;
    admissionVersion: number;
    disposed: boolean;
    readonly retire: (dispose: () => void) => void;
}

function destroyResources(resources: SplatSourceGpuResources): void {
    for (const texture of resources.textures) {
        texture.destroy();
    }
    resources.metadataBuffer.destroy();
}

/** @internal Creates a per-stream, allocation-free-at-import source cache. */
export function createSplatSourceCache(
    maxGpuBytes: number,
    maxCpuBytes: number,
    retire: (dispose: () => void) => void = (dispose) => dispose(),
    sharedLedger?: SplatStreamGpuLedger
): SplatSourceCache {
    if (!Number.isSafeInteger(maxGpuBytes) || maxGpuBytes <= 0 || !Number.isSafeInteger(maxCpuBytes) || maxCpuBytes <= 0) {
        throw new RangeError("[GaussianSplatStream] cache budgets must be positive safe integers");
    }
    return {
        maxGpuBytes,
        maxCpuBytes,
        entries: new Map(),
        ledger: sharedLedger ?? createSplatStreamGpuLedger(maxGpuBytes, retire),
        residentGpuBytes: 0,
        allocatedGpuBytes: 0,
        retiringGpuBytes: 0,
        residentCpuBytes: 0,
        admissionVersion: 0,
        disposed: false,
        retire,
    };
}

/** @internal Creates a retirement hook fenced behind the engine's next submitted frame. */
export function createSplatSourceRetirement(engine: EngineContext): (dispose: () => void) => void {
    return (dispose) => retireGpuResources(engine, dispose);
}

function isProtected(entry: SplatSourceCacheEntry): boolean {
    return entry.pinCount > 0 || entry.displayedRefs > 0 || entry.pendingRefs > 0 || entry.activeRefs > 0;
}

function retireEntry(cache: SplatSourceCache, entry: SplatSourceCacheEntry): void {
    cache.entries.delete(entry.url);
    cache.residentGpuBytes -= entry.gpuBytes;
    cache.residentCpuBytes -= entry.cpuBytes;
    cache.retiringGpuBytes += entry.gpuBytes;
    cache.admissionVersion++;
    cache.ledger.retire(entry.gpuBytes, () => {
        destroyResources(entry.resources);
        cache.allocatedGpuBytes -= entry.gpuBytes;
        cache.retiringGpuBytes -= entry.gpuBytes;
        cache.admissionVersion++;
    });
}

function additionalRetirementRequired(cache: SplatSourceCache, bytes: number): number {
    return Math.max(0, cache.ledger.allocatedBytes + cache.ledger.heldBytes + bytes - cache.ledger.maxBytes - cache.retiringGpuBytes);
}

/** @internal Returns whether an immediate reservation or enough newly eligible source retirement can satisfy the request. */
export function canReserveSplatSourceGpuBytes(cache: SplatSourceCache, bytes: number): boolean {
    if (cache.disposed || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > cache.maxGpuBytes) {
        return false;
    }
    if (cache.ledger.allocatedBytes + cache.ledger.heldBytes + bytes <= cache.ledger.maxBytes) {
        return true;
    }
    const required = additionalRetirementRequired(cache, bytes);
    if (required === 0) {
        return false;
    }
    let reclaimable = 0;
    for (const entry of cache.entries.values()) {
        if (!isProtected(entry)) {
            reclaimable += entry.gpuBytes;
            if (reclaimable >= required) {
                return true;
            }
        }
    }
    return false;
}

/** @internal Reserves source bytes against the shared ledger after scheduling the minimum protected-aware LRU retirement. */
export function reserveSplatSourceGpuBytes(cache: SplatSourceCache, bytes: number, onEvict: (entry: SplatSourceCacheEntry) => void): boolean {
    if (cache.disposed || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > cache.maxGpuBytes) {
        return false;
    }
    if (cache.ledger.tryReserve(bytes)) {
        return true;
    }
    const required = additionalRetirementRequired(cache, bytes);
    if (required === 0) {
        return false;
    }
    const candidates = [...cache.entries.values()]
        .filter((entry) => !isProtected(entry))
        .sort((a, b) => a.lastUsedFrame - b.lastUsedFrame || b.gpuBytes - a.gpuBytes || a.url.localeCompare(b.url));
    const victims: SplatSourceCacheEntry[] = [];
    let reclaimable = 0;
    for (const candidate of candidates) {
        victims.push(candidate);
        reclaimable += candidate.gpuBytes;
        if (reclaimable >= required) {
            break;
        }
    }
    if (reclaimable < required) {
        return false;
    }
    for (const victim of victims) {
        onEvict(victim);
        retireEntry(cache, victim);
    }
    return cache.ledger.tryReserve(bytes);
}

/** @internal Returns true after admitting the entry, evicting only unprotected byte-aware LRU candidates. */
export function admitSplatSource(cache: SplatSourceCache, entry: SplatSourceCacheEntry): boolean {
    if (cache.disposed) {
        destroyResources(entry.resources);
        if (entry.gpuReserved) {
            cache.ledger.release(entry.gpuBytes);
        }
        return false;
    }
    const releaseRejected = (): void => {
        destroyResources(entry.resources);
        if (entry.gpuReserved) {
            cache.ledger.release(entry.gpuBytes);
        }
    };
    if (entry.gpuBytes > cache.maxGpuBytes || entry.cpuBytes > cache.maxCpuBytes) {
        releaseRejected();
        return false;
    }
    const existing = cache.entries.get(entry.url);
    if (existing && existing.generation === entry.generation) {
        releaseRejected();
        return true;
    }
    const excludedGpu = existing?.gpuBytes ?? 0;
    const excludedCpu = existing?.cpuBytes ?? 0;
    const candidates = [...cache.entries.values()]
        .filter((candidate) => candidate !== existing && !isProtected(candidate))
        .sort((a, b) => a.lastUsedFrame - b.lastUsedFrame || b.gpuBytes - a.gpuBytes || a.url.localeCompare(b.url));
    let gpu = cache.residentGpuBytes - excludedGpu + entry.gpuBytes;
    let cpu = cache.residentCpuBytes - excludedCpu + entry.cpuBytes;
    const victims: SplatSourceCacheEntry[] = [];
    for (const candidate of candidates) {
        if (gpu <= cache.maxGpuBytes && cpu <= cache.maxCpuBytes) {
            break;
        }
        victims.push(candidate);
        gpu -= candidate.gpuBytes;
        cpu -= candidate.cpuBytes;
    }
    const requiredReservation = entry.gpuReserved ? 0 : entry.gpuBytes;
    if (gpu > cache.maxGpuBytes || cpu > cache.maxCpuBytes || (existing && isProtected(existing)) || !cache.ledger.tryReserve(requiredReservation)) {
        releaseRejected();
        return false;
    }
    for (const victim of victims) {
        retireEntry(cache, victim);
    }
    if (existing) {
        retireEntry(cache, existing);
    }
    cache.entries.set(entry.url, entry);
    cache.residentGpuBytes += entry.gpuBytes;
    cache.allocatedGpuBytes += entry.gpuBytes;
    cache.residentCpuBytes += entry.cpuBytes;
    cache.admissionVersion++;
    return true;
}

/** @internal Updates reference protections without exposing cache-owned GPU handles publicly. */
export function setSplatSourceProtection(
    cache: SplatSourceCache,
    url: string,
    refs: Partial<Pick<SplatSourceCacheEntry, "pinCount" | "displayedRefs" | "pendingRefs" | "activeRefs" | "lastUsedFrame">>
): void {
    const entry = cache.entries.get(url);
    if (!entry) {
        return;
    }
    const protectedBefore = isProtected(entry);
    for (const key of ["pinCount", "displayedRefs", "pendingRefs", "activeRefs", "lastUsedFrame"] as const) {
        const value = refs[key];
        if (value !== undefined) {
            if (!Number.isSafeInteger(value) || value < 0) {
                throw new RangeError(`[GaussianSplatStream] cache ${key} must be a nonnegative safe integer`);
            }
            entry[key] = value;
        }
    }
    if (protectedBefore !== isProtected(entry)) {
        cache.admissionVersion++;
    }
}

/** @internal Evicts one resident source when it is no longer protected. */
export function evictSplatSource(cache: SplatSourceCache, url: string): boolean {
    const entry = cache.entries.get(url);
    if (!entry || isProtected(entry)) {
        return false;
    }
    retireEntry(cache, entry);
    return true;
}

/** @internal Idempotently retires every cache-owned source. */
export function disposeSplatSourceCache(cache: SplatSourceCache): void {
    if (cache.disposed) {
        return;
    }
    cache.disposed = true;
    for (const entry of [...cache.entries.values()]) {
        retireEntry(cache, entry);
    }
}
