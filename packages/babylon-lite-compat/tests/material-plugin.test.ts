import { describe, expect, it, vi } from "vitest";

const { reconcileMaterialPluginsMock } = vi.hoisted(() => ({
    reconcileMaterialPluginsMock: vi.fn<() => Promise<void>>(),
}));

vi.mock("babylon-lite", async (importActual) => {
    const actual = await importActual<typeof import("babylon-lite")>();
    return {
        ...actual,
        reconcileMaterialPlugins: reconcileMaterialPluginsMock,
    };
});

import { MaterialPluginBase } from "../src/materials/material-plugin";
import { StandardMaterial } from "../src/materials/materials";
import { ShaderLanguage } from "../src/misc/engine-constants";
import { Scene } from "../src/scene/scene";

class TestPlugin extends MaterialPluginBase {
    public constructor(material: StandardMaterial) {
        super(material, "TestPlugin", 200, { TEST_PLUGIN: true });
        this._enable(true);
    }

    public override getCustomCode(shaderType: string, shaderLanguage = ShaderLanguage.GLSL): { CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: string } | null {
        return shaderType === "fragment" && shaderLanguage === ShaderLanguage.WGSL ? { CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: "color.rgb = vec3f(0.5);" } : null;
    }

    public override isCompatible(shaderLanguage: ShaderLanguage): boolean {
        return shaderLanguage === ShaderLanguage.WGSL;
    }
}

describe("MaterialPluginBase", () => {
    it("adapts Babylon.js custom-code overrides to Lite's WGSL plugin bridge", () => {
        let requested = false;
        const scene = {
            _registerMaterial: () => undefined,
            _requestMaterialPlugins: () => {
                requested = true;
            },
        };
        const material = new StandardMaterial("material", scene as never);
        const plugin = new TestPlugin(material);
        const litePlugin = material._lite.plugins?.[0];

        expect(requested).toBe(true);
        expect(litePlugin).toMatchObject({ name: "TestPlugin", priority: 200, defines: { TEST_PLUGIN: true }, isEnabled: true });
        expect(litePlugin?.getCustomCode?.("fragment")).toEqual({ CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: "color.rgb = vec3f(0.5);" });
        expect(litePlugin?.getCustomCode?.("vertex")).toBeNull();

        plugin.dispose();
        expect(material._lite.plugins).toEqual([]);
    });

    it("requests the bridge when a plugin material adopts its scene later", () => {
        let requested = false;
        const material = new StandardMaterial("material");
        new TestPlugin(material);

        material._adoptScene({
            _registerMaterial: () => undefined,
            _requestMaterialPlugins: () => {
                requested = true;
            },
        } as never);

        expect(requested).toBe(true);
    });

    it("keeps the Babylon.js GLSL-only compatibility default", () => {
        class DefaultPlugin extends MaterialPluginBase {}

        const material = new StandardMaterial("material");
        const plugin = new DefaultPlugin(material, "Default", 500);

        expect(plugin.isCompatible(ShaderLanguage.GLSL)).toBe(true);
        expect(plugin.isCompatible(ShaderLanguage.WGSL)).toBe(false);
        expect(material._lite.plugins?.[0]?.getCustomCode?.("fragment")).toBeNull();
    });

    it("preserves constructor attachment, activation, and dirty-callback semantics", () => {
        let requests = 0;
        const scene = {
            _registerMaterial: () => undefined,
            _requestMaterialPlugins: () => {
                requests++;
            },
        };
        const material = new StandardMaterial("material", scene as never);

        const detached = new MaterialPluginBase(material, "Detached", 300, {}, false, true);
        expect(material._lite.plugins).toBeUndefined();
        expect(detached.resolveIncludes).toBe(false);

        const enabled = new MaterialPluginBase(material, "Enabled", 200, {}, true, true);
        expect(material._lite.plugins?.[0]).toMatchObject({ name: "Enabled", isEnabled: true });
        enabled.markAllDefinesAsDirty();

        expect(requests).toBe(2);
    });

    it("preserves the Babylon.js subclass hook shape and mutable identity fields", () => {
        interface Defines {
            CUSTOM: boolean;
        }
        class StructuralPlugin extends MaterialPluginBase {
            public override prepareDefines(_defines: Defines, _scene: Scene, _mesh: never): void {}
            public override getUniforms(_shaderLanguage = ShaderLanguage.GLSL): { ubo: Array<{ name: string; type: string }> } {
                return { ubo: [{ name: "value", type: "float" }] };
            }
        }

        const plugin = new StructuralPlugin(new StandardMaterial("material"), "Structural", 100);
        plugin.name = "Renamed";
        plugin.priority = 150;
        plugin.registerForExtraEvents = true;
        plugin.doNotSerialize = true;

        expect(plugin.serialize()).toMatchObject({ name: "Renamed", priority: 150, registerForExtraEvents: true, doNotSerialize: true });
    });

    it("rejects unsupported include, regex, and subclass-hook execution explicitly", () => {
        const material = new StandardMaterial("material");
        expect(() => new MaterialPluginBase(material, "Includes", 100, {}, true, true, true)).toThrow(/ShaderStore include registry/);

        class RegexPlugin extends MaterialPluginBase {
            public override isCompatible(): boolean {
                return true;
            }
            public override getCustomCode(): Record<string, string> {
                return { "!fragmentOutputs": "replacement" };
            }
        }
        const regex = new RegexPlugin(material, "Regex", 100, {}, true, true);
        expect(() => material._lite.plugins?.at(-1)?.getCustomCode?.("fragment")).toThrow(/composed host shader source/);
        regex.dispose();

        class UniformPlugin extends MaterialPluginBase {
            public override isCompatible(): boolean {
                return true;
            }
            public override getUniforms(): { ubo: Array<{ name: string; type: string }> } {
                return { ubo: [{ name: "value", type: "float" }] };
            }
        }
        new UniformPlugin(material, "Uniform", 100, {}, true, true);
        expect(() => material._lite.plugins?.at(-1)?.getCustomCode?.("fragment")).toThrow(/uniform-buffer/);
    });

    it("schedules Lite reconciliation when a live scene adopts a plugin material", async () => {
        let work: (() => Promise<void>) | undefined;
        const liteScene = {};
        const liteMaterial = {};
        const scene = Object.create(Scene.prototype) as Scene;
        Object.assign(scene, {
            _lite: liteScene,
            _engine: {
                _hasStarted: true,
                _registerLateWork: (callback: () => Promise<void>) => {
                    work = callback;
                },
            },
        });

        scene._requestMaterialPlugins(liteMaterial as never);
        expect(work).toBeTypeOf("function");
        await work!();

        expect(reconcileMaterialPluginsMock).toHaveBeenCalledWith(liteScene, liteMaterial);
    });

    it("reconciles a plugin request raised after startup registration but before the first frame completes", async () => {
        const liteScene = {};
        const liteMaterial = {};
        const scene = Object.create(Scene.prototype) as Scene;
        Object.assign(scene, {
            _lite: liteScene,
            _started: true,
            _materialPluginsRequested: false,
            _pendingMaterialPluginReconciliations: new Set(),
            _engine: { _hasStarted: false },
        });

        scene._requestMaterialPlugins(liteMaterial as never);
        await scene._reconcilePendingMaterialPlugins();

        expect(reconcileMaterialPluginsMock).toHaveBeenCalledWith(liteScene, liteMaterial);
    });
});
