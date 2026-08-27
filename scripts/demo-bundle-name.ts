/** Return whether a demo owns an emitted bundle file, preferring the longest matching slug. */
export function demoOwnsBundleFile(fileName: string, slug: string, configuredSlugs: readonly string[]): boolean {
    const candidateSlugs = configuredSlugs.includes(slug) ? configuredSlugs : [slug, ...configuredSlugs];
    const owner = candidateSlugs
        .filter((candidate) => fileName === `${candidate}.js` || fileName.startsWith(`${candidate}-`))
        .sort((first, second) => second.length - first.length)[0];
    return owner === slug;
}
