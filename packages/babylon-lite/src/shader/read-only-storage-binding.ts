import type { BindingDecl } from "./fragment-types.js";
import { installBindingExtension, type BindingExtension } from "./binding-extension.js";

const emitReadOnlyStorageBinding: BindingExtension = (binding, layout) => {
    if (binding._type._kind === "read-only-storage-buffer") {
        layout.buffer = { type: "read-only-storage" };
        return { _qualifier: "<storage, read>", _declarationType: `${binding._name}Uniforms` };
    }
};

/** @internal Construct typed storage metadata and install its WGSL/layout emitter together. */
export function createReadOnlyStorageBinding(name: string, visibility: GPUShaderStageFlags): BindingDecl {
    installBindingExtension(emitReadOnlyStorageBinding);
    return { _name: name, _type: { _kind: "read-only-storage-buffer" }, _visibility: visibility };
}
