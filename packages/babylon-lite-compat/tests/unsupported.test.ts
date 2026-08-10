import { describe, expect, it } from "vitest";

import { LiteCompatError, unsupported } from "../src/error";
import { ParticleSystem } from "../src/particles/particle-system";
import {
    MultiMaterial,
    ShaderMaterial,
    RectAreaLight,
    ClusteredLightContainer,
    GPUParticleSystem,
    SolidParticleSystem,
    HighlightLayer,
    GlowLayer,
    GreasedLineMesh,
    GreasedLineBaseMesh,
    GreasedLineRibbonMesh,
    GreasedLinePluginMaterial,
    MaterialGreasedLineDefines,
    GreasedLineMaterialDefaults,
    RegisterGreasedLinePluginMaterial,
    GreasedLineSimpleMaterial,
    GreasedLineTools,
    CreateGreasedLine,
    CreateGreasedLineMaterial,
    GetPointsCount,
    CompleteGreasedLineWidthTable,
    CompleteGreasedLineColorTable,
    GreasedLineMeshColorDistribution,
    GreasedLineRibbonAutoDirectionMode,
    EdgesRenderer,
    OutlineRenderer,
    MirrorTexture,
    HtmlTexture,
    HtmlInteractionManager,
    HtmlRaycastInteractionManager,
    IsHtmlInCanvasUploadSupported,
    UploadHtmlElementToTexture,
    ComputeOverlayCssTransform,
    GetElementPixelFromUv,
    IsHtmlInCanvasSupportedNatively,
    InstallHtmlInCanvasPolyfill,
    UninstallHtmlInCanvasPolyfill,
    Sound,
    PointerDragBehavior,
    BaseSixDofDragBehavior,
    SixDofDragBehavior,
    MultiPointerScaleBehavior,
    AttachToBoxBehavior,
    FadeInOutBehavior,
    SurfaceMagnetismBehavior,
    FollowBehavior,
    HandConstraintBehavior,
    InterpolatingBehavior,
    GeospatialClippingBehavior,
    SceneSerializer,
} from "../src/unsupported/unsupported-apis";
import { MeshBuilder, CreateTiledBox, CreateTiledPlane } from "../src/meshes/meshes";
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
        ["GreasedLineMesh", () => new GreasedLineMesh()],
        ["GreasedLineBaseMesh", () => new GreasedLineBaseMesh()],
        ["GreasedLineRibbonMesh", () => new GreasedLineRibbonMesh()],
        ["GreasedLinePluginMaterial", () => new GreasedLinePluginMaterial()],
        ["MaterialGreasedLineDefines", () => new MaterialGreasedLineDefines()],
        ["GreasedLineMaterialDefaults", () => new GreasedLineMaterialDefaults()],
        ["GreasedLineSimpleMaterial", () => new GreasedLineSimpleMaterial()],
        ["GreasedLineTools", () => new GreasedLineTools()],
        ["EdgesRenderer", () => new EdgesRenderer()],
        ["OutlineRenderer", () => new OutlineRenderer()],
        ["MirrorTexture", () => new MirrorTexture()],
        ["HtmlTexture", () => new HtmlTexture()],
        ["HtmlInteractionManager", () => new HtmlInteractionManager()],
        ["HtmlRaycastInteractionManager", () => new HtmlRaycastInteractionManager()],
        ["Sound", () => new Sound()],
        ["PointerDragBehavior", () => new PointerDragBehavior()],
        ["BaseSixDofDragBehavior", () => new BaseSixDofDragBehavior()],
        ["SixDofDragBehavior", () => new SixDofDragBehavior()],
        ["MultiPointerScaleBehavior", () => new MultiPointerScaleBehavior()],
        ["AttachToBoxBehavior", () => new AttachToBoxBehavior()],
        ["FadeInOutBehavior", () => new FadeInOutBehavior()],
        ["SurfaceMagnetismBehavior", () => new SurfaceMagnetismBehavior()],
        ["FollowBehavior", () => new FollowBehavior()],
        ["HandConstraintBehavior", () => new HandConstraintBehavior()],
        ["InterpolatingBehavior", () => new InterpolatingBehavior()],
        ["GeospatialClippingBehavior", () => new GeospatialClippingBehavior()],
    ];

    it.each(cases)("%s throws LiteCompatError naming the API", (name, construct) => {
        expect(construct).toThrow(LiteCompatError);
        expect(construct).toThrow(new RegExp(name));
    });
});

describe("HTML-texture function stubs throw on call", () => {
    const cases: Array<[string, () => unknown]> = [
        ["IsHtmlInCanvasUploadSupported", () => IsHtmlInCanvasUploadSupported()],
        ["UploadHtmlElementToTexture", () => UploadHtmlElementToTexture()],
        ["ComputeOverlayCssTransform", () => ComputeOverlayCssTransform()],
        ["GetElementPixelFromUv", () => GetElementPixelFromUv()],
        ["IsHtmlInCanvasSupportedNatively", () => IsHtmlInCanvasSupportedNatively()],
        ["InstallHtmlInCanvasPolyfill", () => InstallHtmlInCanvasPolyfill()],
        ["UninstallHtmlInCanvasPolyfill", () => UninstallHtmlInCanvasPolyfill()],
    ];

    it.each(cases)("%s throws LiteCompatError naming the API", (name, call) => {
        expect(call).toThrow(LiteCompatError);
        expect(call).toThrow(new RegExp(name));
    });
});

describe("GreasedLine builder/tool function stubs throw on call", () => {
    const cases: Array<[string, () => unknown]> = [
        ["CreateGreasedLine", () => CreateGreasedLine()],
        ["CreateGreasedLineMaterial", () => CreateGreasedLineMaterial()],
        ["GetPointsCount", () => GetPointsCount()],
        ["CompleteGreasedLineWidthTable", () => CompleteGreasedLineWidthTable()],
        ["CompleteGreasedLineColorTable", () => CompleteGreasedLineColorTable()],
        ["RegisterGreasedLinePluginMaterial", () => RegisterGreasedLinePluginMaterial()],
    ];

    it.each(cases)("%s throws LiteCompatError naming the API", (name, call) => {
        expect(call).toThrow(LiteCompatError);
        expect(call).toThrow(new RegExp(name));
    });

    it("mirrors BJS GreasedLine enum values for shape parity", () => {
        expect(GreasedLineMeshColorDistribution.COLOR_DISTRIBUTION_REPEAT).toBe(1);
        expect(GreasedLineMeshColorDistribution.COLOR_DISTRIBUTION_START_END).toBe(5);
        expect(GreasedLineRibbonAutoDirectionMode.AUTO_DIRECTIONS_NONE).toBe(99);
    });

    it("throws LiteCompatError from static GreasedLine utility surfaces", () => {
        expect(() => GreasedLineTools.MeshesToLines([])).toThrow(LiteCompatError);
        expect(() => GreasedLineTools.MeshesToLines([])).toThrow(/GreasedLineTools\.MeshesToLines/);
        expect(() => GreasedLineMaterialDefaults.DEFAULT_WIDTH).toThrow(LiteCompatError);
        expect(() => GreasedLineMaterialDefaults.DEFAULT_WIDTH).toThrow(/GreasedLineMaterialDefaults\.DEFAULT_WIDTH/);
    });

    it("accepts BJS-shaped GreasedLine arguments before throwing", () => {
        expect(() => new GreasedLineMesh("line", {}, {})).toThrow(LiteCompatError);
        expect(() => CreateGreasedLine("line", {}, {}, {})).toThrow(LiteCompatError);
        expect(() => CreateGreasedLineMaterial("material", {}, {})).toThrow(LiteCompatError);
        expect(() => GetPointsCount([])).toThrow(LiteCompatError);
    });
});

describe("SceneSerializer", () => {
    it("throws on Serialize and SerializeMesh", () => {
        expect(() => SceneSerializer.Serialize()).toThrow(LiteCompatError);
        expect(() => SceneSerializer.SerializeMesh()).toThrow(LiteCompatError);
    });
});

describe("MeshBuilder unsupported primitives", () => {
    it.each(["CreateDecal", "CreateText", "CreateTiledBox", "CreateTiledPlane"] as const)("%s throws LiteCompatError", (method) => {
        const fn = MeshBuilder[method] as () => never;
        expect(fn).toThrow(LiteCompatError);
        expect(fn).toThrow(new RegExp(method));
    });

    it("standalone CreateTiledBox / CreateTiledPlane exports throw LiteCompatError", () => {
        expect(() => CreateTiledBox()).toThrow(LiteCompatError);
        expect(() => CreateTiledPlane()).toThrow(LiteCompatError);
    });
});

describe("SceneLoader.RegisterPlugin", () => {
    it("throws (out of scope, side-effectful registry)", () => {
        expect(() => SceneLoader.RegisterPlugin()).toThrow(LiteCompatError);
    });
});
