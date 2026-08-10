const CONTENT_HASH_SUFFIX = /-[A-Za-z0-9_-]{8}(?=\.js$)/;

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
