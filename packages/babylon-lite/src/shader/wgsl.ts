/** @internal */
declare const wgslSourceBrand: unique symbol;

/** WGSL source explicitly marked for build-time processing. */
export type WgslSource = string & {
    /** @internal */
    readonly [wgslSourceBrand]: true;
};

/** Identity tag that marks a template literal as WGSL for build-time processing. */
export function wgsl(strings: TemplateStringsArray, ...values: readonly (string | number)[]): WgslSource {
    let source = strings[0]!;
    for (let i = 0; i < values.length; i++) {
        source += String(values[i]) + strings[i + 1]!;
    }
    return source as WgslSource;
}
