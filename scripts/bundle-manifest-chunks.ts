const CONTENT_HASH_SUFFIX = /-[A-Za-z0-9_-]{8}(?=\.js$)/;
export const RAW_BYTE_DRIFT_TOLERANCE = 10;

/** Remove Vite's content hash while preserving the scene-prefixed logical chunk name. */
export function logicalRuntimeChunkName(file: string): string {
    return file.replace(CONTENT_HASH_SUFFIX, "");
}

/** Compare two chunk lists as order-independent logical-name sets. */
export function diffRuntimeChunks(committed: string[] | undefined, built: string[] | undefined): string | null {
    const committedSet = new Set((committed ?? []).map(logicalRuntimeChunkName));
    const builtSet = new Set((built ?? []).map(logicalRuntimeChunkName));
    const added = [...builtSet].filter((chunk) => !committedSet.has(chunk)).sort();
    const removed = [...committedSet].filter((chunk) => !builtSet.has(chunk)).sort();

    if (added.length === 0 && removed.length === 0) {
        return null;
    }

    const parts: string[] = [];
    if (removed.length > 0) {
        parts.push(`-${removed.join(", -")}`);
    }
    if (added.length > 0) {
        parts.push(`+${added.join(", +")}`);
    }
    return parts.join("  ");
}

/** Gzip output varies by zlib build; only movement beyond one rounded KB is actionable. */
export function diffGzipSize(committedKB: number | undefined, builtKB: number | undefined): string | null {
    const committed = Math.round(committedKB ?? 0);
    const built = Math.round(builtKB ?? 0);
    return Math.abs(built - committed) <= 1 ? null : `committed gzip=${committed}KB → rebuilt gzip=${built}KB`;
}

/** Ignore tiny minifier allocation shifts; absolute ceiling checks still use exact rebuilt bytes. */
export function rawByteDriftExceedsTolerance(committed: number, built: number): boolean {
    return Math.abs(built - committed) > RAW_BYTE_DRIFT_TOLERANCE;
}
