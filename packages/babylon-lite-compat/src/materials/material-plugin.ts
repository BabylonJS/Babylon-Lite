import type { MaterialPlugin, MaterialPluginPoint } from "babylon-lite";

import type { Material } from "./materials.js";
import { ShaderLanguage } from "../misc/engine-constants.js";

export type MaterialPluginDefines = Record<string, boolean | number>;
export type MaterialPluginCustomCode = Partial<Record<MaterialPluginPoint, string>>;

/**
 * Babylon.js `MaterialPluginBase` adapter over Lite's opt-in material-plugin
 * bridge. Subclasses keep the Babylon.js override shape while Lite receives a
 * plain plugin descriptor.
 */
export class MaterialPluginBase {
    public readonly name: string;
    public readonly priority: number;
    protected readonly _material: Material;

    /** @internal Plain plugin descriptor attached to the backing Lite material. */
    private readonly _lite: MaterialPlugin;

    public constructor(material: Material, name: string, priority = 500, defines: MaterialPluginDefines = {}) {
        this._material = material;
        this.name = name;
        this.priority = priority;
        this._lite = {
            name,
            priority,
            defines,
            isEnabled: false,
            getCustomCode: (shaderType) => (this.isCompatible(ShaderLanguage.WGSL) ? this.getCustomCode(shaderType, ShaderLanguage.WGSL) : null),
        };

        if (this._attachToLite) {
            const liteMaterial = material._lite as typeof material._lite & { plugins?: MaterialPlugin[] };
            liteMaterial.plugins = [...(liteMaterial.plugins ?? []), this._lite];
            material._usesMaterialPlugins = true;
            material.getScene()?._requestMaterialPlugins();
        }
    }

    /** @internal Unsupported derived stubs override this to avoid mutating Lite state before throwing. */
    protected get _attachToLite(): boolean {
        return true;
    }

    protected _enable(enable: boolean): void {
        this._lite.isEnabled = enable;
    }

    public isCompatible(_shaderLanguage: ShaderLanguage): boolean {
        return _shaderLanguage === ShaderLanguage.GLSL;
    }

    public getCustomCode(_shaderType: string, _shaderLanguage = ShaderLanguage.GLSL): MaterialPluginCustomCode | null {
        return null;
    }

    public getClassName(): string {
        return "MaterialPluginBase";
    }

    public dispose(): void {
        const liteMaterial = this._material._lite as typeof this._material._lite & { plugins?: MaterialPlugin[] };
        if (liteMaterial.plugins) {
            liteMaterial.plugins = liteMaterial.plugins.filter((plugin) => plugin !== this._lite);
            this._material._usesMaterialPlugins = liteMaterial.plugins.length > 0;
        }
    }
}
