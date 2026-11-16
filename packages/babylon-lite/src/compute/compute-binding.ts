import type { EngineContext } from "../engine/engine.js";

declare const computeBindingDeclBrand: unique symbol;

/** Opaque resource-binding declaration created by a resource-specific helper. */
export interface ComputeBindingDecl {
    readonly [computeBindingDeclBrand]: true;
    readonly name: string;
    readonly group: number;
    readonly binding: number;
    /** @internal Resource resolver slot installed by the helper module. */
    readonly _kind: number;
    /** @internal Layout contribution owned by the helper module. */
    readonly _layout: Omit<GPUBindGroupLayoutEntry, "binding" | "visibility">;
    /** @internal Resource-specific immutable declaration state. */
    readonly _data?: unknown;
}

/** @internal Dynamic-offset metadata returned by a resource resolver. */
export interface ComputeDynamicBindingInfo {
    /** @internal */
    readonly _alignment: number;
    /** @internal */
    readonly _maxOffset: number;
}

/** @internal Resource-specific state retained by an immutable binding set. */
export interface ComputeResolvedBinding {
    /** @internal */
    readonly _state: unknown;
    /** @internal */
    readonly _dynamic?: ComputeDynamicBindingInfo;
}

type ResolveBinding = (engine: EngineContext, decl: ComputeBindingDecl, resource: unknown) => ComputeResolvedBinding;
type GetBindingResource = (engine: EngineContext, state: unknown) => GPUBindingResource;
type ValidateBindingResource = (engine: EngineContext, state: unknown) => void;

/** @internal Installed resolver for one opt-in resource kind. */
export interface ComputeBindingResolver {
    /** @internal */
    readonly _resolve: ResolveBinding;
    /** @internal */
    readonly _get: GetBindingResource;
    /** @internal Slow-path resource validation required even while GPU handles are cached. */
    readonly _validate?: ValidateBindingResource;
}

let _resolvers: (ComputeBindingResolver | undefined)[] | null = null;

/** @internal Install one resource-kind resolver. Called only by its opt-in declaration helper. */
export function _installComputeBindingResolver(kind: number, resolve: ResolveBinding, get: GetBindingResource, validate?: ValidateBindingResource): void {
    const resolvers = (_resolvers ??= []);
    resolvers[kind] ??= { _resolve: resolve, _get: get, _validate: validate };
}

/** @internal Resolve a helper-installed resource implementation. */
export function _getComputeBindingResolver(kind: number): ComputeBindingResolver {
    const resolver = _resolvers?.[kind];
    if (!resolver) {
        throw new Error("Compute binding declaration was not created by a supported resource helper.");
    }
    return resolver;
}

/** @internal Create the common plain-data declaration shape. */
export function _createComputeBindingDecl(
    name: string,
    group: number,
    binding: number,
    kind: number,
    layout: Omit<GPUBindGroupLayoutEntry, "binding" | "visibility">,
    data?: unknown
): ComputeBindingDecl {
    const resourceLayout = layout.buffer ?? layout.sampler ?? layout.texture ?? layout.storageTexture ?? layout.externalTexture;
    if (resourceLayout) {
        Object.freeze(resourceLayout);
    }
    Object.freeze(layout);
    if (data && typeof data === "object") {
        Object.freeze(data);
    }
    return Object.freeze({ name, group, binding, _kind: kind, _layout: layout, _data: data }) as unknown as ComputeBindingDecl;
}
