/** Null-by-default resolver hook used by optional A2C pipeline owners. */
export type AlphaToCoverageResolver = (target: object) => boolean;

let _resolver: AlphaToCoverageResolver | null = null;

/** @internal Install the resolver when the public A2C setter is first used. */
export function _registerAlphaToCoverageResolver(resolver: AlphaToCoverageResolver): void {
    _resolver = resolver;
}

/** @internal Return the optional resolver, or null when A2C is absent from the application. */
export function _getAlphaToCoverageResolver(): AlphaToCoverageResolver | null {
    return _resolver;
}
