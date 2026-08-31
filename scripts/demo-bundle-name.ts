/** Return whether `slug` owns an emitted bundle file, preferring the longest matching slug.
 *
 *  `knownSlugs` must list every demo that emits into the shared output directory — configured demos
 *  *and* support bundles. Ownership then depends only on the file name, so exactly one demo claims a
 *  given file no matter which demo is being rebuilt. Omitting a slug lets a prefix-related demo claim,
 *  and therefore delete, chunks it does not own (e.g. `landing` claiming `landing-bg-<hash>.js`). */
export function demoOwnsBundleFile(fileName: string, slug: string, knownSlugs: readonly string[]): boolean {
    const owner = knownSlugs.filter((candidate) => fileName === `${candidate}.js` || fileName.startsWith(`${candidate}-`)).sort((first, second) => second.length - first.length)[0];
    return owner === slug;
}
