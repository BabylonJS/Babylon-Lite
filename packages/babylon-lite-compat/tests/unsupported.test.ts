import { runInNewContext } from "node:vm";
import { transform } from "esbuild";
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
    FluidRenderingObject,
    FluidRenderingObjectParticleSystem,
    FluidRenderingObjectCustomParticles,
    FluidRenderingTargetRenderer,
    FluidRenderer,
    FluidRendererSceneComponent,
    RegisterFluidRenderer,
    RootMotionSource,
    RootMotionClip,
    RootMotionController,
    DitheredTileFadeMaterialPlugin,
    GaussianSplattingMaterial,
    GaussianSplattingDebugMaterialPlugin,
    GaussianSplattingGpuPickingMaterialPlugin,
    GaussianSplattingSolidColorMaterialPlugin,
    GaussianSplattingSizeMaterialPlugin,
    GaussianSplattingOverdrawMaterialPlugin,
    RegisterGaussianSplattingMaterial,
    RegisterGaussianSplattingSizeMaterialPlugin,
    GaussianSplattingMaxPartCount,
    GetGaussianSplattingMaxPartCount,
    GetPartIndexVaryingDeclaration,
    GaussianPointSplattingRenderer,
    GaussianPointSplattingBlitMaterial,
    GaussianPointSplattingDepthBlitMaterial,
} from "../src/unsupported/unsupported-apis";
import { AddGaussianSplattingStreamPart, AddGaussianSplattingStreamPartAsync, GaussianSplattingStream } from "../src/meshes/gaussian-splatting-stream";
import { GaussianSplattingMesh } from "../src/meshes/gaussian-splatting";
import {
    GLTF1,
    GLTF2,
    ImageProcessingConfiguration,
    RegisterAbstractEngineTextureLoaders,
    RegisterImageProcessingConfiguration,
    registerBuiltInLoaders,
    OpenPBRMaterialLoadingAdapter as RootOpenPBRMaterialLoadingAdapter,
    RegisterOpenpbrMaterial as RootRegisterOpenpbrMaterial,
} from "../src/index";
import {
    Mesh,
    MeshBuilder,
    CreateTiledBox,
    CreateTiledPlane,
    CreatePolygon,
    ExtrudePolygon,
    CreatePolygonVertexData,
    PolygonBuilder,
    RegisterPolygonBuilder,
    VertexData,
} from "../src/meshes/meshes";
import { SceneLoader } from "../src/loading/scene-loader";
import { Material, PushMaterial, StandardMaterial } from "../src/materials/materials";
import { NullEngine } from "../src/engine/engine";
import { Scene } from "../src/scene/scene";
import { ShaderLanguage } from "../src/misc/engine-constants";
import type { EffectWrapperCreationOptions } from "../src/unsupported/unsupported-extended";

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

describe("Effect callback types", () => {
    it("preserves callback-usable engine and compilation error return types", () => {
        const options: EffectWrapperCreationOptions = {
            onCompiled: (effect) => {
                effect.getEngine().getRenderingCanvas();
            },
            onError: (effect, errors) => {
                effect.getCompilationError().includes(errors);
            },
        };

        expect(options.onCompiled).toBeTypeOf("function");
        expect(options.onError).toBeTypeOf("function");
    });
});

describe("Unsupported polygon builder exports", () => {
    const options = { shape: [] };

    it("exposes every upstream polygon builder entry point with a structural failure", () => {
        const polygon = Object.create(Mesh.prototype) as Mesh;
        const cases: Array<[string, () => unknown]> = [
            ["MeshBuilder.CreatePolygon", () => MeshBuilder.CreatePolygon("polygon", options)],
            ["MeshBuilder.ExtrudePolygon", () => MeshBuilder.ExtrudePolygon("polygon", options)],
            ["MeshBuilder.CreatePolygon", () => CreatePolygon("polygon", options)],
            ["MeshBuilder.ExtrudePolygon", () => ExtrudePolygon("polygon", options)],
            ["CreatePolygonVertexData", () => CreatePolygonVertexData(polygon, 0)],
            ["CreatePolygonVertexData", () => VertexData.CreatePolygon(polygon, 0)],
            ["Mesh.CreatePolygon", () => Mesh.CreatePolygon("polygon", [], {} as Scene)],
            ["Mesh.ExtrudePolygon", () => Mesh.ExtrudePolygon("polygon", [], 1, {} as Scene)],
            ["MeshBuilder.CreatePolygon", () => PolygonBuilder.CreatePolygon("polygon", options)],
            ["MeshBuilder.ExtrudePolygon", () => PolygonBuilder.ExtrudePolygon("polygon", options)],
        ];

        for (const [errorApi, call] of cases) {
            expect(call).toThrow(LiteCompatError);
            expect(call).toThrow(new RegExp(errorApi.replace(".", "\\.")));
        }
    });

    it("keeps the registration shim side-effect free", () => {
        expect(RegisterPolygonBuilder()).toBeUndefined();
    });
});

describe("Unsupported API stubs throw on construction", () => {
    const cases: Array<[string, () => unknown]> = [
        ["MultiMaterial", () => new MultiMaterial()],
        ["DitheredTileFadeMaterialPlugin", () => new DitheredTileFadeMaterialPlugin(new StandardMaterial("material"))],
        ["GaussianSplattingMaterial", () => new GaussianSplattingMaterial("material")],
        ["GaussianSplattingDebugMaterialPlugin", () => new GaussianSplattingDebugMaterialPlugin(Object.create(GaussianSplattingMaterial.prototype) as GaussianSplattingMaterial)],
        [
            "GaussianSplattingGpuPickingMaterialPlugin",
            () => new GaussianSplattingGpuPickingMaterialPlugin(Object.create(GaussianSplattingMaterial.prototype) as GaussianSplattingMaterial),
        ],
        [
            "GaussianSplattingSolidColorMaterialPlugin",
            () => new GaussianSplattingSolidColorMaterialPlugin(Object.create(GaussianSplattingMaterial.prototype) as GaussianSplattingMaterial, []),
        ],
        ["GaussianSplattingSizeMaterialPlugin", () => new GaussianSplattingSizeMaterialPlugin(Object.create(GaussianSplattingMaterial.prototype) as GaussianSplattingMaterial)],
        [
            "GaussianSplattingOverdrawMaterialPlugin",
            () => new GaussianSplattingOverdrawMaterialPlugin(Object.create(GaussianSplattingMaterial.prototype) as GaussianSplattingMaterial),
        ],
        ["GaussianPointSplattingRenderer", () => new GaussianPointSplattingRenderer({} as AbstractEngine)],
        ["GaussianPointSplattingBlitMaterial", () => new GaussianPointSplattingBlitMaterial("blit", {} as Scene)],
        ["GaussianPointSplattingDepthBlitMaterial", () => new GaussianPointSplattingDepthBlitMaterial("depth-blit", {} as Scene)],
        ["ShaderMaterial", () => new ShaderMaterial()],
        ["OpenPBRMaterial", () => new OpenPBRMaterial("openpbr", undefined, true)],
        ["OpenPBRMaterialDefines", () => new OpenPBRMaterialDefines({ CUSTOM: { type: "boolean", default: false } })],
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

    it("exposes the Gaussian Point Splatting blit and renderer member shapes", () => {
        expectTypeOf<GaussianPointSplattingRenderer["supportsWorkload"]>().toBeFunction();
        expectTypeOf<GaussianPointSplattingRenderer["_matchesPartData"]>().toBeFunction();
        expectTypeOf<GaussianPointSplattingBlitMaterial["setLogarithmicDepthConstant"]>().toBeFunction();
        expectTypeOf<GaussianPointSplattingDepthBlitMaterial["setDepthValues"]>().toBeFunction();
        expectTypeOf<GaussianPointSplattingDepthBlitMaterial["setReverseDepth"]>().toBeFunction();
    });

    it("preserves stable diagnostics in a minified consumer build", async () => {
        const source = `
            const capture = (construct) => {
                try {
                    construct();
                } catch (error) {
                    return error.message;
                }
                throw new Error("Expected construction to fail");
            };
            globalThis.messages = [
                capture(() => new (class ConsumerShaderMaterial extends ShaderMaterial {})()),
                capture(() => new (class ConsumerBlitMaterial extends GaussianPointSplattingBlitMaterial {})("blit", scene)),
                capture(() => new (class ConsumerDepthBlitMaterial extends GaussianPointSplattingDepthBlitMaterial {})("depth-blit", scene)),
            ];
        `;
        const { code } = await transform(source, { minify: true, format: "iife", target: "es2022" });
        const context = {
            ShaderMaterial,
            GaussianPointSplattingBlitMaterial,
            GaussianPointSplattingDepthBlitMaterial,
            scene: {} as Scene,
            messages: [] as string[],
        };

        runInNewContext(code, context);

        expect(context.messages[0]).toContain("'ShaderMaterial'");
        expect(context.messages[0]).toContain("shader preprocessing subsystem");
        expect(context.messages[1]).toContain("'GaussianPointSplattingBlitMaterial'");
        expect(context.messages[1]).toContain("scene-integrated high-level handle");
        expect(context.messages[2]).toContain("'GaussianPointSplattingDepthBlitMaterial'");
        expect(context.messages[2]).toContain("scene-integrated high-level handle");
    });

    describe("Gaussian splatting material stubs", () => {
        it("does not retain a failed plugin on the supplied material", () => {
            const material = Object.create(GaussianSplattingMaterial.prototype) as GaussianSplattingMaterial;

            expect(() => new GaussianSplattingSizeMaterialPlugin(material)).toThrow(LiteCompatError);
            expect(material.pluginManager).toBeUndefined();
        });

        it("does not register a failed material with the supplied scene", () => {
            const registered: Material[] = [];
            const scene = { _registerMaterial: (material: Material) => registered.push(material) } as unknown as Scene;

            expect(() => new GaussianSplattingMaterial("material", scene)).toThrow(LiteCompatError);
            expect(registered).toHaveLength(0);
        });

        it("exposes the mechanical constant, part-count query, picking encoder, and varying helper", () => {
            const engine = Object.create(AbstractEngine.prototype) as AbstractEngine;
            engine._lite = {
                _device: {
                    limits: { maxUniformBufferBindingSize: 500 },
                },
            } as AbstractEngine["_lite"];

            expect(GaussianSplattingMaxPartCount).toBe(128);
            expect(GetGaussianSplattingMaxPartCount(engine)).toBe(17);
            expectTypeOf(GetGaussianSplattingMaxPartCount).returns.toBeNumber();
            expect(GaussianSplattingGpuPickingMaterialPlugin.EncodeIdToColor(0x123456)).toEqual([0x12 / 255, 0x34 / 255, 0x56 / 255]);
            expectTypeOf(GaussianSplattingGpuPickingMaterialPlugin.EncodeIdToColor).returns.toEqualTypeOf<[number, number, number]>();
            expect(GetPartIndexVaryingDeclaration(ShaderLanguage.GLSL)).toContain("varying float vPartIndex;");
            expect(GetPartIndexVaryingDeclaration(ShaderLanguage.WGSL)).toContain("varying vPartIndex: f32;");
        });

        it("clamps the part-count query to the upstream bounds", () => {
            const engine = Object.create(AbstractEngine.prototype) as AbstractEngine;
            const limits = { maxUniformBufferBindingSize: 0 };
            engine._lite = { _device: { limits } } as AbstractEngine["_lite"];

            expect(GetGaussianSplattingMaxPartCount(engine)).toBe(1);
            limits.maxUniformBufferBindingSize = 65536;
            expect(GetGaussianSplattingMaxPartCount(engine)).toBe(256);
        });

        it("preserves the new visualization plugin property shapes", () => {
            expectTypeOf<GaussianSplattingSizeMaterialPlugin["isEnabled"]>().toEqualTypeOf<boolean>();
            expectTypeOf<GaussianSplattingSizeMaterialPlugin["sizeScale"]>().toEqualTypeOf<number>();
            expectTypeOf<GaussianSplattingOverdrawMaterialPlugin["isEnabled"]>().toEqualTypeOf<boolean>();
            expectTypeOf<GaussianSplattingOverdrawMaterialPlugin["intensity"]>().toEqualTypeOf<number>();
        });

        it("exposes registration functions with the material-lifecycle blocker", () => {
            expect(() => RegisterGaussianSplattingMaterial()).toThrow(LiteCompatError);
            expect(() => RegisterGaussianSplattingSizeMaterialPlugin()).toThrow(LiteCompatError);
        });
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
        expectTypeOf(IsHtmlInCanvasUploadSupported).returns.toEqualTypeOf<boolean>();
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

describe("Gaussian Splatting compound streaming stubs throw", () => {
    it("preserves the lod0SplatCount discriminated union on the stream accessor", () => {
        const getAvailableCount = (stream: GaussianSplattingStream): number | undefined => {
            const result = stream.lod0SplatCount;
            return result.status === "available" ? result.count : undefined;
        };

        expectTypeOf(getAvailableCount).returns.toEqualTypeOf<number | undefined>();
    });

    it("AddGaussianSplattingStreamPart names its structural blocker", () => {
        expect(() => AddGaussianSplattingStreamPart({} as never, "part", {} as never, "/")).toThrow(LiteCompatError);
        expect(() => AddGaussianSplattingStreamPart({} as never, "part", {} as never, "/")).toThrow(/compound-mesh atlas/);
    });

    it("AddGaussianSplattingStreamPartAsync names its structural blocker", async () => {
        await expect(AddGaussianSplattingStreamPartAsync({} as never, "part", {} as never, "/")).rejects.toThrow(LiteCompatError);
        await expect(AddGaussianSplattingStreamPartAsync({} as never, "part", {} as never, "/")).rejects.toThrow(/compound-mesh atlas/);
    });
});

describe("root motion stubs", () => {
    it("exports the BJS enum values and names the animation-system blocker", () => {
        expect(RootMotionSource.None).toBe(0);
        expect(RootMotionSource.Root).toBe(1);
        expect(RootMotionSource.FootContact).toBe(2);
        expect(() => new RootMotionClip({} as never)).toThrow(/mixer writes/);
        expect(() => new RootMotionController({} as never)).toThrow(/mixer writes/);
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

    it("treats compat's direct built-in loader dispatch as already registered", () => {
        expectTypeOf(registerBuiltInLoaders).returns.toEqualTypeOf<void>();
        expect(registerBuiltInLoaders()).toBeUndefined();
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
