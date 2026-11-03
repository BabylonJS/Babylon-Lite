import type { BindingDecl } from "./fragment-types.js";

/** @internal Additional binding declarations are installed only by their resource producer. */
export type BindingExtension = (binding: BindingDecl, layout: GPUBindGroupLayoutEntry) => { readonly _qualifier: string; readonly _declarationType: string } | undefined;

/** @internal Ordinary shaders retain only the built-in binding kinds. */
export let bindingExtension: BindingExtension | null = null;

/** @internal */
export function installBindingExtension(extension: BindingExtension): void {
    bindingExtension = extension;
}
