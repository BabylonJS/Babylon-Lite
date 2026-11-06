import type { EngineContext } from "../../engine/engine.js";
import type { DrawBinding } from "../../render/renderable.js";
import type { MaterialPlugin } from "../plugin/material-plugin.js";

/** @internal Optional resource-only decoration, installed by an explicit material feature. */
export type PbrBindingDecorator = (
    binding: DrawBinding,
    engine: EngineContext,
    plugins: readonly MaterialPlugin[] | undefined,
    fragmentKey: string,
    features: number,
    features2: number,
    makeGroup: () => GPUBindGroup,
    drawGroup: (pass: GPURenderPassEncoder | GPURenderBundleEncoder, group: GPUBindGroup) => number,
    disposers: (() => void)[],
    scope?: object
) => DrawBinding;

/** @internal Construction-only selection of scene-local plugin resources. */
export interface ScopedPbrBindingDecorator {
    (...args: Parameters<PbrBindingDecorator>): DrawBinding;
    /** @internal Select the consuming scope before collecting or binding resources. */
    _prepare(plugins: readonly MaterialPlugin[] | undefined, scope: object): void;
}

/** @internal The unused live binding is constant null after tree-shaking. */
export let pbrBindingDecorator: ScopedPbrBindingDecorator | null = null;

/** @internal Isolated from the lazy builder's namespace exports. */
export function installPbrBindingDecorator(decorator: ScopedPbrBindingDecorator): void {
    pbrBindingDecorator = decorator;
}
