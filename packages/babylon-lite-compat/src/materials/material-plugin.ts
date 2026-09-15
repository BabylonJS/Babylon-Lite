import type { MaterialPlugin, MaterialPluginPoint } from "babylon-lite";

import { unsupported } from "../error.js";
import { ShaderLanguage } from "../misc/engine-constants.js";
import type { AbstractMesh } from "../meshes/meshes.js";
import type { SmartArray } from "../misc/misc-utils.js";
import type { Scene } from "../scene/scene.js";
import type { BaseTexture, RenderTargetTexture } from "../textures/textures.js";
import type { Material } from "./materials.js";

export type MaterialPluginDefines = Record<string, unknown>;
export type MaterialPluginCustomCode = Record<string, string>;

const MATERIAL_PLUGIN_INCLUDES_UNSUPPORTED =
    "Babylon.js shader includes depend on its ShaderStore include registry and expansion pipeline. Lite has no compatible include registry, and introducing one is a loader/shader-subsystem design rather than adapter translation.";
const MATERIAL_PLUGIN_REGEX_UNSUPPORTED =
    "Regular-expression shader replacement requires access to the composed host shader source. Lite's plugin bridge exposes fixed injection slots only, so adding regex rewriting requires a new Lite shader-composition contract.";
const MATERIAL_PLUGIN_HOOKS_UNSUPPORTED =
    "This Babylon.js plugin overrides hooks outside fixed-slot custom shader code. Executing those hooks requires Babylon.js-compatible define, uniform-buffer, sampler, texture, mesh-attribute, or render-target bridge contracts that Lite does not expose.";

function toLiteCustomCode(code: MaterialPluginCustomCode | null): Partial<Record<MaterialPluginPoint, string>> | null {
    if (!code) {
        return null;
    }
    const translated: Partial<Record<MaterialPluginPoint, string>> = {};
    for (const [point, value] of Object.entries(code)) {
        if (point.startsWith("!")) {
            return unsupported("MaterialPluginBase.getCustomCode(regex)", MATERIAL_PLUGIN_REGEX_UNSUPPORTED);
        }
        switch (point) {
            case "CUSTOM_FRAGMENT_DEFINITIONS":
            case "CUSTOM_FRAGMENT_MAIN_BEGIN":
            case "CUSTOM_FRAGMENT_UPDATE_ALPHA":
            case "CUSTOM_FRAGMENT_UPDATE_DIFFUSE":
            case "CUSTOM_FRAGMENT_BEFORE_LIGHTS":
            case "CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION":
            case "CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR":
            case "CUSTOM_VERTEX_MAIN_BEGIN":
            case "CUSTOM_VERTEX_UPDATE_WORLDPOS":
            case "CUSTOM_VERTEX_MAIN_END":
                translated[point] = value;
                break;
            default:
                return unsupported(`MaterialPluginBase.getCustomCode(${point})`, "Lite's material-plugin bridge does not expose this Babylon.js shader injection point.");
        }
    }
    return translated;
}

function toLiteDefines(defines: MaterialPluginDefines): Record<string, boolean | number> {
    const translated: Record<string, boolean | number> = {};
    for (const [name, value] of Object.entries(defines)) {
        if (typeof value === "boolean" || typeof value === "number") {
            translated[name] = value;
        }
    }
    return translated;
}

/**
 * Babylon.js `MaterialPluginBase` adapter over Lite's opt-in material-plugin
 * bridge. Subclasses keep the Babylon.js override shape while Lite receives a
 * plain plugin descriptor.
 */
export class MaterialPluginBase {
    private _name: string;
    private _priority: number;
    private _resolveIncludes = false;
    public readonly markAllDefinesAsDirty: () => void;
    public registerForExtraEvents = false;
    public doNotSerialize = false;
    protected readonly _material: Material;
    protected readonly _pluginDefineNames?: MaterialPluginDefines;

    /** @internal Plain plugin descriptor attached to the backing Lite material. */
    private readonly _lite: MaterialPlugin;

    public constructor(material: Material, name: string, priority: number, defines: MaterialPluginDefines = {}, addToPluginList = true, enable = false, resolveIncludes = false) {
        this._material = material;
        this._name = name;
        this._priority = priority;
        this.resolveIncludes = resolveIncludes;
        this._pluginDefineNames = defines;
        this.markAllDefinesAsDirty = () => material._markPluginDefinesDirty();
        this._lite = {
            get name() {
                return name;
            },
            get priority() {
                return priority;
            },
            defines: toLiteDefines(defines),
            isEnabled: enable,
            getCustomCode: (shaderType) => {
                this._assertSupportedExecution();
                return this.isCompatible(ShaderLanguage.WGSL) ? toLiteCustomCode(this.getCustomCode(shaderType, ShaderLanguage.WGSL)) : null;
            },
        };

        if (addToPluginList && this._attachToLite) {
            const liteMaterial = material._lite as typeof material._lite & { plugins?: MaterialPlugin[] };
            liteMaterial.plugins = [...(liteMaterial.plugins ?? []), this._lite];
            material._usesMaterialPlugins = true;
            material.getScene()?._requestMaterialPlugins(material._lite);
        }
    }

    public get name(): string {
        return this._name;
    }

    public set name(value: string) {
        this._name = value;
        Object.defineProperty(this._lite, "name", { configurable: true, enumerable: true, get: () => this._name });
    }

    public get priority(): number {
        return this._priority;
    }

    public set priority(value: number) {
        this._priority = value;
        Object.defineProperty(this._lite, "priority", { configurable: true, enumerable: true, get: () => this._priority });
    }

    public get resolveIncludes(): boolean {
        return this._resolveIncludes;
    }

    public set resolveIncludes(value: boolean) {
        if (value) {
            unsupported("MaterialPluginBase.resolveIncludes", MATERIAL_PLUGIN_INCLUDES_UNSUPPORTED);
        }
        this._resolveIncludes = false;
    }

    /** @internal Unsupported derived stubs override this to avoid mutating Lite state before throwing. */
    protected get _attachToLite(): boolean {
        return true;
    }

    protected _enable(enable: boolean): void {
        this._lite.isEnabled = enable;
        this.markAllDefinesAsDirty();
    }

    private _assertSupportedExecution(): void {
        if (this.resolveIncludes) {
            unsupported("MaterialPluginBase.resolveIncludes", MATERIAL_PLUGIN_INCLUDES_UNSUPPORTED);
        }
        const base = MaterialPluginBase.prototype;
        const unsupportedHook =
            this.registerForExtraEvents ||
            this.collectDefines !== base.collectDefines ||
            this.prepareDefinesBeforeAttributes !== base.prepareDefinesBeforeAttributes ||
            this.prepareDefines !== base.prepareDefines ||
            this.isReadyForSubMesh !== base.isReadyForSubMesh ||
            this.hardBindForSubMesh !== base.hardBindForSubMesh ||
            this.bindForSubMesh !== base.bindForSubMesh ||
            this.hasTexture !== base.hasTexture ||
            this.hasRenderTargetTextures !== base.hasRenderTargetTextures ||
            this.fillRenderTargetTextures !== base.fillRenderTargetTextures ||
            this.getActiveTextures !== base.getActiveTextures ||
            this.getAnimatables !== base.getAnimatables ||
            this.addFallbacks !== base.addFallbacks ||
            this.getSamplers !== base.getSamplers ||
            this.getAttributes !== base.getAttributes ||
            this.getUniformBuffersNames !== base.getUniformBuffersNames ||
            this.getUniforms !== base.getUniforms;
        if (unsupportedHook) {
            unsupported("MaterialPluginBase hooks", MATERIAL_PLUGIN_HOOKS_UNSUPPORTED);
        }
    }

    public isCompatible(_shaderLanguage: ShaderLanguage): boolean {
        return _shaderLanguage === ShaderLanguage.GLSL;
    }

    public getCustomCode(_shaderType: string, _shaderLanguage = ShaderLanguage.GLSL): MaterialPluginCustomCode | null {
        return null;
    }

    public isReadyForSubMesh(_defines: object, _scene: Scene, _engine: object, _subMesh: object): boolean {
        return true;
    }

    public hardBindForSubMesh(_uniformBuffer: object, _scene: Scene, _engine: object, _subMesh: object): void {}

    public bindForSubMesh(_uniformBuffer: object, _scene: Scene, _engine: object, _subMesh: object): void {}

    public collectDefines(defines: Record<string, { type: string; default: unknown }>): void {
        if (!this._pluginDefineNames) {
            return;
        }
        for (const [name, value] of Object.entries(this._pluginDefineNames)) {
            if (!name.startsWith("_")) {
                const valueType = typeof value;
                defines[name] = {
                    type: valueType === "number" || valueType === "string" || valueType === "boolean" ? valueType : "object",
                    default: value,
                };
            }
        }
    }

    public prepareDefinesBeforeAttributes(_defines: object, _scene: Scene, _mesh: AbstractMesh): void {}

    public prepareDefines(_defines: object, _scene: Scene, _mesh: AbstractMesh): void {}

    public hasTexture(_texture: BaseTexture): boolean {
        return false;
    }

    public hasRenderTargetTextures(): boolean {
        return false;
    }

    public fillRenderTargetTextures(_renderTargets: SmartArray<RenderTargetTexture>): void {}

    public getActiveTextures(_activeTextures: BaseTexture[]): void {}

    public getAnimatables(_animatables: object[]): void {}

    public addFallbacks(_defines: object, _fallbacks: object, currentRank: number): number {
        return currentRank;
    }

    public getSamplers(_samplers: string[]): void {}

    public getAttributes(_attributes: string[], _scene: Scene, _mesh: AbstractMesh): void {}

    public getUniformBuffersNames(_ubos: string[]): void {}

    public getUniforms(_shaderLanguage = ShaderLanguage.GLSL): {
        ubo?: Array<{ name: string; size?: number; type?: string; arraySize?: number }>;
        vertex?: string;
        fragment?: string;
        externalUniforms?: string[];
    } {
        return {};
    }

    public getClassName(): string {
        return "MaterialPluginBase";
    }

    public copyTo(plugin: MaterialPluginBase): void {
        plugin.name = this.name;
        plugin.priority = this.priority;
        plugin.resolveIncludes = this.resolveIncludes;
        plugin.registerForExtraEvents = this.registerForExtraEvents;
        plugin.doNotSerialize = this.doNotSerialize;
    }

    public serialize(): Record<string, unknown> {
        return {
            name: this.name,
            priority: this.priority,
            resolveIncludes: this.resolveIncludes,
            registerForExtraEvents: this.registerForExtraEvents,
            doNotSerialize: this.doNotSerialize,
        };
    }

    public parse(source: Record<string, unknown>, _scene: Scene, _rootUrl: string): void {
        if (typeof source.resolveIncludes === "boolean") {
            this.resolveIncludes = source.resolveIncludes;
        }
        if (typeof source.name === "string") {
            this.name = source.name;
        }
        if (typeof source.priority === "number") {
            this.priority = source.priority;
        }
        if (typeof source.registerForExtraEvents === "boolean") {
            this.registerForExtraEvents = source.registerForExtraEvents;
        }
        if (typeof source.doNotSerialize === "boolean") {
            this.doNotSerialize = source.doNotSerialize;
        }
    }

    public dispose(_forceDisposeTextures?: boolean): void {
        const liteMaterial = this._material._lite as typeof this._material._lite & { plugins?: MaterialPlugin[] };
        if (liteMaterial.plugins) {
            liteMaterial.plugins = liteMaterial.plugins.filter((plugin) => plugin !== this._lite);
            this._material._usesMaterialPlugins = liteMaterial.plugins.length > 0;
            this._material._markPluginDefinesDirty();
        }
    }
}
