import type { DrawBinding, DrawUpdateContext } from "./renderable.js";

/** @internal Binding-generation ownership is independent of mesh ownership. */
export type DrawBindingLists = readonly (readonly DrawBinding[])[];

/** @internal Installed only by features that own pass-local binding resources. */
export interface DrawBindingLifecycle {
    /** @internal Retire only bindings absent from the retained generation. */
    _retire(lists: DrawBindingLists, retained?: DrawBindingLists): void;
    /** @internal Publish the exact aspect used to pack the consuming pass's scene UBO. */
    _setProjectionAspect(context: DrawUpdateContext, aspect: number): void;
}

/** @internal Ordinary passes retain no optional resource-lifetime implementation. */
export let drawBindingLifecycle: DrawBindingLifecycle | null = null;

/** @internal */
export function installDrawBindingLifecycle(lifecycle: DrawBindingLifecycle): void {
    drawBindingLifecycle = lifecycle;
}
