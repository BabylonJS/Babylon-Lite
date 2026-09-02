/** Identity tag that marks a template literal as WGSL for build-time processing. */
export function wgsl(strings: TemplateStringsArray, ...values: readonly (string | number)[]): string {
    let source = strings[0]!;
    for (let i = 0; i < values.length; i++) {
        source += String(values[i]) + strings[i + 1]!;
    }
    return source;
}
