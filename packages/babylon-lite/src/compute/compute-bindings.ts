import type { ComputeBindingDecl, ComputeBindingResolver } from "./compute-binding.js";
import { _getComputeBindingResolver } from "./compute-binding.js";
import type { ComputeShader } from "./compute-shader.js";
import { _assertComputeShaderLive, _getComputeGroupLayouts } from "./compute-shader.js";

/** Named resources consumed by resource-specific binding helpers. */
export type ComputeBindingResources = Readonly<Record<string, unknown>>;

interface ResolvedComputeBinding {
    readonly _decl: ComputeBindingDecl;
    readonly _resolver: ComputeBindingResolver;
    readonly _state: unknown;
}

/** @internal One dynamic-offset slot precomputed by binding name. */
export interface ComputeDynamicBindingSlot {
    /** @internal */
    readonly _group: number;
    /** @internal */
    readonly _index: number;
    /** @internal */
    readonly _alignment: number;
    /** @internal */
    readonly _maxOffset: number;
}

declare const computeBindingSetBrand: unique symbol;

/** Immutable reusable resources for one compute program. */
export interface ComputeBindingSet {
    readonly [computeBindingSetBrand]: true;
    readonly shader: ComputeShader;
    /** @internal */
    readonly _shader: ComputeShader;
    /** @internal */
    readonly _entries: readonly ResolvedComputeBinding[];
    /** @internal Entries requiring validation even while bind groups are cached. */
    readonly _volatileEntries: readonly ResolvedComputeBinding[] | null;
    /** @internal Allocated only when at least one declaration uses dynamic offsets. */
    readonly _dynamicSlots: Map<string, ComputeDynamicBindingSlot> | null;
    /** @internal Zero offsets with the exact count required by each group. */
    readonly _zeroDynamicOffsets: readonly number[][] | null;
    /** @internal */
    _device: GPUDevice | null;
    /** @internal */
    _groups: GPUBindGroup[] | null;
    /** @internal Managed-resource epoch used to invalidate cached bind groups. */
    _resourceEpoch: number;
    /** @internal */
    _destroyed: boolean;
}

/** Create an immutable, prevalidated resource combination for a compute shader. */
export function createComputeBindingSet(shader: ComputeShader, resources: ComputeBindingResources): ComputeBindingSet {
    _assertComputeShaderLive(shader);
    for (const name of Object.keys(resources)) {
        if (!shader._slots.has(name)) {
            throw new Error(`ComputeBindingSet: resource "${name}" was not declared by ComputeShader "${shader.name}".`);
        }
    }
    const entries: ResolvedComputeBinding[] = [];
    let dynamicSlots: Map<string, ComputeDynamicBindingSlot> | null = null;
    let volatileEntries: ResolvedComputeBinding[] | null = null;
    for (const decl of shader._decls) {
        if (!Object.hasOwn(resources, decl.name)) {
            throw new Error(`ComputeBindingSet: binding "${decl.name}" has no resource.`);
        }
        const input = resources[decl.name];
        const resolver = _getComputeBindingResolver(decl._kind);
        const resolved = resolver._resolve(shader._engine, decl, input);
        const entry = { _decl: decl, _resolver: resolver, _state: resolved._state };
        entries.push(entry);
        if (resolver._validate) {
            (volatileEntries ??= []).push(entry);
        }
        if (resolved._dynamic) {
            const slot = shader._slots.get(decl.name)!;
            (dynamicSlots ??= new Map()).set(decl.name, {
                _group: decl.group,
                _index: slot._dynamicIndex,
                _alignment: resolved._dynamic._alignment,
                _maxOffset: resolved._dynamic._maxOffset,
            });
        }
    }
    const bindings = {
        shader,
        _shader: shader,
        _entries: entries,
        _volatileEntries: volatileEntries,
        _dynamicSlots: dynamicSlots,
        _zeroDynamicOffsets: dynamicSlots ? shader._dynamicCounts.map((count) => new Array<number>(count).fill(0)) : null,
        _device: null,
        _groups: null,
        _resourceEpoch: -1,
        _destroyed: false,
    } as unknown as ComputeBindingSet;
    _ensureComputeBindingGroups(bindings);
    return bindings;
}

/** @internal Resolve current-device bind groups from retained resource wrappers. */
export function _ensureComputeBindingGroups(bindings: ComputeBindingSet, validateVolatile = true): readonly GPUBindGroup[] {
    if (bindings._destroyed) {
        throw new Error(`ComputeBindingSet for "${bindings.shader.name}" has been disposed.`);
    }
    const shader = bindings._shader;
    _assertComputeShaderLive(shader);
    let resourceEpoch = shader._engine._resourceEpoch ?? 0;
    if (bindings._device === shader._engine._device && bindings._groups && bindings._resourceEpoch === resourceEpoch) {
        const volatileEntries = validateVolatile ? bindings._volatileEntries : null;
        if (volatileEntries) {
            for (let i = 0; i < volatileEntries.length; i++) {
                const entry = volatileEntries[i]!;
                entry._resolver._validate!(shader._engine, entry._state);
            }
            resourceEpoch = shader._engine._resourceEpoch ?? 0;
        }
        if (bindings._resourceEpoch === resourceEpoch) {
            return bindings._groups;
        }
    }
    const layouts = _getComputeGroupLayouts(shader);
    const groups: GPUBindGroup[] = [];
    for (let group = 0; group < layouts.length; group++) {
        const entries: GPUBindGroupEntry[] = [];
        for (let i = 0; i < bindings._entries.length; i++) {
            const entry = bindings._entries[i]!;
            if (entry._decl.group === group) {
                entries.push({ binding: entry._decl.binding, resource: entry._resolver._get(shader._engine, entry._state) });
            }
        }
        groups.push(shader._engine._device.createBindGroup({ label: `${shader.name}-bindings${group}`, layout: layouts[group]!, entries }));
    }
    bindings._device = shader._engine._device;
    bindings._groups = groups;
    bindings._resourceEpoch = resourceEpoch;
    return groups;
}

/** Dispose device-relative bind groups. Bound resources remain caller-owned. */
export function disposeComputeBindingSet(bindings: ComputeBindingSet): void {
    if (bindings._destroyed) {
        return;
    }
    bindings._destroyed = true;
    bindings._groups = null;
    bindings._device = null;
}
