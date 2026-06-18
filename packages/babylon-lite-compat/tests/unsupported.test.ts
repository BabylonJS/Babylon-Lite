import { describe, expect, it } from "vitest";

import { LiteCompatError, unsupported } from "../src/error";
import {
    MultiMaterial,
    ShaderMaterial,
    RectAreaLight,
    ClusteredLightContainer,
    ParticleSystem,
    GPUParticleSystem,
    SolidParticleSystem,
    HighlightLayer,
    GlowLayer,
    LinesMesh,
    GreasedLineMesh,
    EdgesRenderer,
    OutlineRenderer,
    MirrorTexture,
    Sound,
    SceneSerializer,
} from "../src/unsupported/unsupported-apis";
import { MeshBuilder } from "../src/meshes/meshes";
import { SceneLoader } from "../src/loading/scene-loader";

describe("LiteCompatError", () => {
    it("formats a message with the API name", () => {
        const err = new LiteCompatError("Foo.bar");
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe("LiteCompatError");
        expect(err.message).toContain("'Foo.bar'");
    });

    it("appends the detail when provided", () => {
        const err = new LiteCompatError("Foo.bar", "Use baz instead.");
        expect(err.message).toContain("Use baz instead.");
    });

    it("unsupported() throws a LiteCompatError and never returns", () => {
        expect(() => unsupported("X")).toThrow(LiteCompatError);
    });
});

describe("Unsupported API stubs throw on construction", () => {
    const cases: Array<[string, () => unknown]> = [
        ["MultiMaterial", () => new MultiMaterial()],
        ["ShaderMaterial", () => new ShaderMaterial()],
        ["RectAreaLight", () => new RectAreaLight()],
        ["ClusteredLightContainer", () => new ClusteredLightContainer()],
        ["ParticleSystem", () => new ParticleSystem()],
        ["GPUParticleSystem", () => new GPUParticleSystem()],
        ["SolidParticleSystem", () => new SolidParticleSystem()],
        ["HighlightLayer", () => new HighlightLayer()],
        ["GlowLayer", () => new GlowLayer()],
        ["LinesMesh", () => new LinesMesh()],
        ["GreasedLineMesh", () => new GreasedLineMesh()],
        ["EdgesRenderer", () => new EdgesRenderer()],
        ["OutlineRenderer", () => new OutlineRenderer()],
        ["MirrorTexture", () => new MirrorTexture()],
        ["Sound", () => new Sound()],
    ];

    it.each(cases)("%s throws LiteCompatError naming the API", (name, construct) => {
        expect(construct).toThrow(LiteCompatError);
        expect(construct).toThrow(new RegExp(name));
    });
});

describe("SceneSerializer", () => {
    it("throws on Serialize and SerializeMesh", () => {
        expect(() => SceneSerializer.Serialize()).toThrow(LiteCompatError);
        expect(() => SceneSerializer.SerializeMesh()).toThrow(LiteCompatError);
    });
});

describe("MeshBuilder unsupported primitives", () => {
    it.each(["CreateLines", "CreateLineSystem", "CreateDashedLines", "CreateDecal", "CreateText"] as const)("%s throws LiteCompatError", (method) => {
        const fn = MeshBuilder[method] as () => never;
        expect(fn).toThrow(LiteCompatError);
        expect(fn).toThrow(new RegExp(method));
    });
});

describe("SceneLoader.RegisterPlugin", () => {
    it("throws (out of scope, side-effectful registry)", () => {
        expect(() => SceneLoader.RegisterPlugin()).toThrow(LiteCompatError);
    });
});
