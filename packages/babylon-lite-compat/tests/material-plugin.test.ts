import { describe, expect, it } from "vitest";

import { MaterialPluginBase } from "../src/materials/material-plugin";
import { StandardMaterial } from "../src/materials/materials";
import { ShaderLanguage } from "../src/misc/engine-constants";

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
        const plugin = new DefaultPlugin(material, "Default");

        expect(plugin.isCompatible(ShaderLanguage.GLSL)).toBe(true);
        expect(plugin.isCompatible(ShaderLanguage.WGSL)).toBe(false);
        expect(material._lite.plugins?.[0]?.getCustomCode?.("fragment")).toBeNull();
    });
});
