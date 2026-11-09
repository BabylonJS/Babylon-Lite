import { describe, expect, it } from "vitest";

import { LiteCompatError } from "../src/error";
import {
    Skeleton,
    Bone,
    ReflectionProbe,
    Layer,
    EffectLayer,
    DepthRenderer,
    GeometryBufferRenderer,
    BoundingBoxRenderer,
    PostProcess,
    Effect,
    EffectWrapper,
    FrameGraphMinMaxReducerTask,
    NodeRenderGraphMinMaxReducerBlock,
    RegisterMinMaxReducerBlock,
    BlackAndWhitePostProcess,
    BlurPostProcess,
    BloomEffect,
    ChromaticAberrationPostProcess,
    DepthOfFieldEffect,
    DefaultRenderingPipeline,
    FxaaPostProcess,
    SSAO2RenderingPipeline,
    FSR1RenderingPipeline,
    ThinFSR1UpscalePostProcess,
    ThinFSR1SharpenPostProcess,
    ParticleHelper,
    PointsCloudSystem,
    KHR_materials_scatter,
    RegisterKHR_materials_scatter,
    CannonJSPlugin,
    AmmoJSPlugin,
    RecastJSPlugin,
    AudioEngine,
    WeightedSound,
    OBJFileLoader,
    STLFileLoader,
    FBXFileLoader,
    FBXFileLoaderMetadata,
    FBXConstraintBehavior,
    FBXConstraintSolver,
    BVHFileLoader,
    SpriteMap,
    SpritePackedManager,
    VirtualJoystick,
    SceneOptimizer,
} from "../src/unsupported/unsupported-extended";

describe("Extended unsupported stubs throw on construction", () => {
    const cases: Array<[string, () => unknown]> = [
        ["Skeleton", () => new Skeleton()],
        ["Bone", () => new Bone()],
        ["ReflectionProbe", () => new ReflectionProbe()],
        ["Layer", () => new Layer()],
        ["EffectLayer", () => new EffectLayer()],
        ["DepthRenderer", () => new DepthRenderer()],
        ["GeometryBufferRenderer", () => new GeometryBufferRenderer()],
        ["BoundingBoxRenderer", () => new BoundingBoxRenderer()],
        ["PostProcess", () => new PostProcess()],
        ["Effect", () => new Effect()],
        ["EffectWrapper", () => new EffectWrapper({ onError: () => undefined })],
        ["FrameGraphMinMaxReducerTask", () => new FrameGraphMinMaxReducerTask()],
        ["NodeRenderGraphMinMaxReducerBlock", () => new NodeRenderGraphMinMaxReducerBlock()],
        ["BlackAndWhitePostProcess", () => new BlackAndWhitePostProcess()],
        ["BlurPostProcess", () => new BlurPostProcess()],
        ["BloomEffect", () => new BloomEffect()],
        ["ChromaticAberrationPostProcess", () => new ChromaticAberrationPostProcess()],
        ["DepthOfFieldEffect", () => new DepthOfFieldEffect()],
        ["DefaultRenderingPipeline", () => new DefaultRenderingPipeline()],
        ["FxaaPostProcess", () => new FxaaPostProcess()],
        ["SSAO2RenderingPipeline", () => new SSAO2RenderingPipeline()],
        ["FSR1RenderingPipeline", () => new FSR1RenderingPipeline()],
        ["ThinFSR1UpscalePostProcess", () => new ThinFSR1UpscalePostProcess()],
        ["ThinFSR1SharpenPostProcess", () => new ThinFSR1SharpenPostProcess()],
        ["ParticleHelper", () => new ParticleHelper()],
        ["PointsCloudSystem", () => new PointsCloudSystem()],
        ["CannonJSPlugin", () => new CannonJSPlugin()],
        ["AmmoJSPlugin", () => new AmmoJSPlugin()],
        ["RecastJSPlugin", () => new RecastJSPlugin()],
        ["AudioEngine", () => new AudioEngine()],
        ["WeightedSound", () => new WeightedSound()],
        ["OBJFileLoader", () => new OBJFileLoader()],
        ["STLFileLoader", () => new STLFileLoader()],
        ["FBXFileLoader", () => new FBXFileLoader()],
        [
            "FBXConstraintBehavior",
            () =>
                new FBXConstraintBehavior(
                    {
                        id: 1,
                        name: "constraint",
                        type: "parent",
                        typeName: "Parent-Child",
                        targets: [],
                        weight: 1,
                        active: true,
                        affectTranslation: [true, true, true],
                        affectRotation: [true, true, true],
                        affectScale: [true, true, true],
                        offsetTranslation: [0, 0, 0],
                        offsetRotation: [0, 0, 0],
                        offsetScale: [1, 1, 1],
                        aimVector: [1, 0, 0],
                        upVector: [0, 1, 0],
                        worldUpVector: [0, 1, 0],
                        worldUpType: 0,
                        ikPoleVector: [0, 1, 0],
                    },
                    {} as never
                ),
        ],
        ["BVHFileLoader", () => new BVHFileLoader()],
        ["SpriteMap", () => new SpriteMap()],
        ["SpritePackedManager", () => new SpritePackedManager()],
        ["VirtualJoystick", () => new VirtualJoystick()],
        ["SceneOptimizer", () => new SceneOptimizer()],
    ];

    it.each(cases)("%s throws LiteCompatError naming the API", (name, construct) => {
        expect(construct).toThrow(LiteCompatError);
        expect(construct).toThrow(new RegExp(name));
    });

    it("exposes the FBX metadata and solver entry point", () => {
        expect(FBXFileLoaderMetadata).toEqual({ name: "fbx", extensions: { ".fbx": { isBinary: true } } });
        expect(() => FBXConstraintSolver.Get({} as never)).toThrow(LiteCompatError);
        expect(() => FBXConstraintSolver.Get({} as never)).toThrow(/FBXConstraintSolver\.Get/);
    });

    it("exports the min/max node registration stub with its structural blocker", () => {
        expect(() => RegisterMinMaxReducerBlock()).toThrow(LiteCompatError);
        expect(() => RegisterMinMaxReducerBlock()).toThrow(/FrameGraph handles/);
    });

    it("registers KHR_materials_scatter idempotently and defers failure until the extension is used", () => {
        expect(() => RegisterKHR_materials_scatter()).not.toThrow();
        const extension = new KHR_materials_scatter({ isExtensionUsed: () => true });
        expect(extension.name).toBe("KHR_materials_scatter");
        expect(extension.enabled).toBe(true);
        expect(extension.order).toBe(172);
        expect(extension.loadMaterialPropertiesAsync("/materials/0", {}, {})).toBeNull();
        expect(() => extension.loadMaterialPropertiesAsync("/materials/0", { extensions: { KHR_materials_scatter: {} } }, {})).toThrow(LiteCompatError);
        expect(() => extension.loadMaterialPropertiesAsync("/materials/0", { extensions: { KHR_materials_scatter: {} } }, {})).toThrow(
            /screen-space subsurface-scattering prepass/
        );
    });

    it("keeps Effect callbacks structurally usable before construction throws", () => {
        expect(() => new EffectWrapper({ onError: (effect) => effect.getCompilationError(), onCompiled: null })).toThrow(LiteCompatError);
    });
});
