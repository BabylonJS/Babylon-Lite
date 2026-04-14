/** Shared pipeline cache factory — used by Standard and PBR material pipelines.
 *
 *  Provides a generic, ref-counted cache keyed by string with automatic
 *  invalidation when the GPU device changes.  Zero module-level side effects. */

export interface PipelineCacheEntry {
    refCount: number;
}

export interface PipelineCache<V extends PipelineCacheEntry> {
    get(key: string): V | undefined;
    set(key: string, value: V): void;
    /** Return cached entry with refCount++, or undefined on miss. */
    getOrIncRef(key: string): V | undefined;
    clear(): void;
    /** Remove all entries whose refCount has reached 0. */
    evictUnused(): void;
    readonly device: GPUDevice | null;
    /** Returns true if device changed (cache was cleared). */
    ensureDevice(device: GPUDevice): boolean;
}

export function createPipelineCache<V extends PipelineCacheEntry>(): PipelineCache<V> {
    const map = new Map<string, V>();
    let _device: GPUDevice | null = null;

    return {
        get(key: string): V | undefined {
            return map.get(key);
        },
        set(key: string, value: V): void {
            map.set(key, value);
        },
        getOrIncRef(key: string): V | undefined {
            const entry = map.get(key);
            if (entry) {
                entry.refCount++;
            }
            return entry;
        },
        clear(): void {
            map.clear();
            _device = null;
        },
        evictUnused(): void {
            for (const [key, entry] of map) {
                if (entry.refCount <= 0) {
                    map.delete(key);
                }
            }
        },
        get device(): GPUDevice | null {
            return _device;
        },
        ensureDevice(device: GPUDevice): boolean {
            if (device === _device) {
                return false;
            }
            map.clear();
            _device = device;
            return true;
        },
    };
}

/** Decrement refCount on a variant. Does NOT evict from the cache —
 *  use PipelineCache.evictUnused() or the material-specific release helpers for that. */
export function releaseVariant<V extends PipelineCacheEntry>(variant: V): void {
    if (variant.refCount > 0) {
        variant.refCount--;
    }
}
