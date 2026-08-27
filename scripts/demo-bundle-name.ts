/** Return the configured demo that owns an emitted bundle file, preferring the longest matching slug. */
export function demoSlugForBundleFile(fileName: string, slugs: readonly string[]): string | undefined {
    return slugs.filter((slug) => fileName === `${slug}.js` || fileName.startsWith(`${slug}-`)).sort((first, second) => second.length - first.length)[0];
}
