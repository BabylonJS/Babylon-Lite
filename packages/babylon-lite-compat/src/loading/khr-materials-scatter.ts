import { enableUnsupportedGltfMaterialExtension } from "babylon-lite";

import { unsupported } from "../error.js";

const NAME = "KHR_materials_scatter";
const BLOCKER =
    "KHR_materials_scatter requires OpenPBR scattering texture processing plus a screen-space subsurface-scattering prepass. Babylon Lite reserves scattering material state but does not implement that render subsystem.";

let registered = false;

export class KHR_materials_scatter {
    public readonly name = NAME;
    public enabled: boolean;
    public order = 172;

    public constructor(loader?: { isExtensionUsed?(name: string): boolean }) {
        this.enabled = loader?.isExtensionUsed?.(this.name) ?? false;
    }

    public dispose(): void {}

    public loadMaterialPropertiesAsync(_context: string, material: { extensions?: Record<string, unknown> }, _babylonMaterial: unknown): Promise<void> | null {
        if (!material.extensions?.[this.name]) {
            return null;
        }
        return unsupported("KHR_materials_scatter.loadMaterialPropertiesAsync", BLOCKER);
    }
}

export function RegisterKHR_materials_scatter(): void {
    if (!registered) {
        registered = true;
        enableUnsupportedGltfMaterialExtension(NAME, () => unsupported("KHR_materials_scatter.loadMaterialPropertiesAsync", BLOCKER));
    }
}
