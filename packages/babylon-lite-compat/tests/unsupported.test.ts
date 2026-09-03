import { describe, expect, expectTypeOf, it } from "vitest";

import { AbstractEngine } from "../src/engine/engine";
import { LiteCompatError, unsupported } from "../src/error";
import { ParticleSystem } from "../src/particles/particle-system";
import {
    MultiMaterial,
    ShaderMaterial,
    OpenPBRMaterial,
    OpenPBRMaterialDefines,
    RegisterOpenpbrMaterial,
    OpenPBRMaterialLoadingAdapter,
    RectAreaLight,
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
    GaussianSplattingStream,
    AddGaussianSplattingStreamPart,
    AddGaussianSplattingStreamPartAsync,
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
    MinTemperatureKelvin,
    MaxTintMagnitude,
    TemperatureTintToXyz,
    GetWhiteBalanceMatrix,
    FluidRenderingObject,
    FluidRenderingObjectParticleSystem,
    FluidRenderingObjectCustomParticles,
    FluidRenderingTargetRenderer,
    FluidRenderer,
    FluidRendererSceneComponent,
    RegisterFluidRenderer,
} from "../src/unsupported/unsupported-apis";
import {
    GLTF1,
    GLTF2,
    ImageProcessingConfiguration,
    RegisterAbstractEngineTextureLoaders,
    RegisterImageProcessingConfiguration,
    OpenPBRMaterialLoadingAdapter as RootOpenPBRMaterialLoadingAdapter,
    RegisterOpenpbrMaterial as RootRegisterOpenpbrMaterial,
} from "../src/index";
import { MeshBuilder, CreateTiledBox, CreateTiledPlane } from "../src/meshes/meshes";
import { SceneLoader } from "../src/loading/scene-loader";
import { Material, PushMaterial } from "../src/materials/materials";
import { NullEngine } from "../src/engine/engine";
import { Scene } from "../src/scene/scene";

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
        ["OpenPBRMaterial", () => new OpenPBRMaterial("openpbr", undefined, true)],
        ["OpenPBRMaterialDefines", () => new OpenPBRMaterialDefines({ CUSTOM: { type: "boolean", default: false } })],
        ["RectAreaLight", () => new RectAreaLight()],
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

describe("OpenPBR unsupported exports", () => {
    it("exposes the registration function and loading adapter through the expected barrels", () => {
        expect(RootRegisterOpenpbrMaterial).toBe(RegisterOpenpbrMaterial);
        expect(GLTF2.OpenPBRMaterialLoadingAdapter).toBe(RootOpenPBRMaterialLoadingAdapter);
    });

    it("throws when OpenPBR registration is requested", () => {
        expect(() => RegisterOpenpbrMaterial()).toThrow(LiteCompatError);
        expect(() => RegisterOpenpbrMaterial()).toThrow(/RegisterOpenpbrMaterial/);
    });

    it("accepts an OpenPBRMaterial in the loading adapter", () => {
        expectTypeOf<OpenPBRMaterial>().toMatchTypeOf<Material>();
        expectTypeOf<OpenPBRMaterial>().toMatchTypeOf<PushMaterial>();
        const material: OpenPBRMaterial = Object.create(OpenPBRMaterial.prototype);

        expect(() => new OpenPBRMaterialLoadingAdapter(material)).toThrow(LiteCompatError);
        expect(() => new OpenPBRMaterialLoadingAdapter(material)).toThrow(/OpenPBRMaterialLoadingAdapter/);
    });

    it("exposes the upstream-shaped clone signature", () => {
        const material: OpenPBRMaterial = Object.create(OpenPBRMaterial.prototype);

        expect(() => material.clone("clone", false, "/textures/")).toThrow(LiteCompatError);
        expect(() => material.clone("clone", false, "/textures/")).toThrow(/OpenPBRMaterial\.clone/);
    });

    it("fails loudly when its unsupported Lite backing is accessed", () => {
        const material: OpenPBRMaterial = Object.create(OpenPBRMaterial.prototype);

        expect(() => material._lite).toThrow(LiteCompatError);
        expect(() => material._lite).toThrow(/OpenPBRMaterial\._lite/);
    });
});

describe("HTML-texture function stubs throw on call", () => {
    const engine = Object.create(AbstractEngine.prototype) as AbstractEngine;
    const cases: Array<[string, () => unknown]> = [
        ["IsHtmlInCanvasUploadSupported", () => IsHtmlInCanvasUploadSupported(engine)],
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

    it("exposes the upstream engine parameter", () => {
        expectTypeOf(IsHtmlInCanvasUploadSupported).parameter(0).toEqualTypeOf<AbstractEngine>();
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

describe("Gaussian Splatting LOD streaming stubs throw", () => {
    it("GaussianSplattingStream throws on construction", () => {
        expect(() => new GaussianSplattingStream()).toThrow(LiteCompatError);
        expect(() => new GaussianSplattingStream()).toThrow(/GaussianSplattingStream/);
    });

    it.each([
        ["AddGaussianSplattingStreamPart", () => AddGaussianSplattingStreamPart()],
        ["AddGaussianSplattingStreamPartAsync", () => AddGaussianSplattingStreamPartAsync()],
    ] as Array<[string, () => unknown]>)("%s throws LiteCompatError naming the API", (name, call) => {
        expect(call).toThrow(LiteCompatError);
        expect(call).toThrow(new RegExp(name));
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

describe("image-processing additions", () => {
    it("forwards supported properties through the Scene facade", () => {
        const scene = new Scene(new NullEngine());
        const config = scene.imageProcessingConfiguration;

        config.exposure = 1.5;
        config.contrast = 1.25;
        config.toneMappingEnabled = true;

        expect(scene.imageProcessingConfiguration).toBe(config);
        expect(scene._lite.imageProcessing.exposure).toBe(1.5);
        expect(scene._lite.imageProcessing.contrast).toBe(1.25);
        expect(scene._lite.imageProcessing.toneMappingEnabled).toBe(true);
        expect(config.exposure).toBe(1.5);
        expect(config.contrast).toBe(1.25);
        expect(config.toneMappingEnabled).toBe(true);
    });

    it("exposes constants and fails loudly for the unsupported white-balance subsystem", () => {
        const config = new ImageProcessingConfiguration();
        expect(MinTemperatureKelvin).toBe(1e6 / 600);
        expect(MaxTintMagnitude).toBe(150);
        expect(() => TemperatureTintToXyz(6500, 0)).toThrow(LiteCompatError);
        expect(() => GetWhiteBalanceMatrix(6500, 0)).toThrow(LiteCompatError);
        expect(config.whiteBalanceEnabled).toBe(false);
        expect(config.temperature).toBe(6500);
        expect(config.tint).toBe(0);
        expect(() => {
            config.whiteBalanceEnabled = false;
            config.temperature = 6500;
            config.tint = 0;
        }).not.toThrow();
        expect(() => {
            config.whiteBalanceEnabled = true;
        }).toThrow(LiteCompatError);
        expect(() => {
            config.temperature = 5000;
        }).toThrow(LiteCompatError);
        expect(() => {
            config.tint = 1;
        }).toThrow(LiteCompatError);
        expect(() => RegisterImageProcessingConfiguration()).toThrow(LiteCompatError);
    });

    it("treats Lite's direct texture loader dispatch as already registered", () => {
        expectTypeOf(RegisterAbstractEngineTextureLoaders).returns.toEqualTypeOf<void>();
        expect(RegisterAbstractEngineTextureLoaders()).toBeUndefined();
    });
});

describe("fluid-rendering additions", () => {
    it("preserves the static flag and exposes fail-fast classes", () => {
        expect(FluidRenderingObject.UsePerParticleSizeAttribute).toBe(false);
        expect(() => new FluidRenderer({} as Scene)).toThrow(LiteCompatError);
        expect(() => new FluidRendererSceneComponent({} as Scene)).toThrow(LiteCompatError);
        expect(() => new FluidRenderingObjectParticleSystem({} as Scene, {})).toThrow(LiteCompatError);
        expect(() => new FluidRenderingObjectCustomParticles({} as Scene, {}, 0)).toThrow(LiteCompatError);
        expect(() => new FluidRenderingTargetRenderer({} as Scene)).toThrow(LiteCompatError);
        expect(() => RegisterFluidRenderer()).toThrow(LiteCompatError);
    });

    it("adds fail-fast Scene augmentation methods", () => {
        const scene = new Scene(new NullEngine());
        expect(scene.fluidRenderer).toBeNull();
        expect(() => scene.enableFluidRenderer()).toThrow(LiteCompatError);
        expect(scene.disableFluidRenderer()).toBeUndefined();
        expect(() => {
            scene.fluidRenderer = null;
        }).not.toThrow();
    });
});

describe("GLTF1 pure registration exports", () => {
    it.each([
        ["RegisterGLTF1Loader", GLTF1.RegisterGLTF1Loader],
        ["RegisterGLTFBinaryExtension", GLTF1.RegisterGLTFBinaryExtension],
        ["RegisterGLTFMaterialsCommonExtension", GLTF1.RegisterGLTFMaterialsCommonExtension],
    ])("%s throws a named LiteCompatError", (name, register) => {
        expect(register).toThrow(LiteCompatError);
        expect(register).toThrow(new RegExp(name));
    });

    it("exposes fail-fast legacy loader classes", () => {
        expect(() => new GLTF1.GLTFLoader()).toThrow(LiteCompatError);
        expect(() => new GLTF1.GLTFBinaryExtension()).toThrow(LiteCompatError);
        expect(() => new GLTF1.GLTFMaterialsCommonExtension()).toThrow(LiteCompatError);
    });
});
