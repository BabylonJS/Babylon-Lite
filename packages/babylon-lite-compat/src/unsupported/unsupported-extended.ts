/**
 * Throwing stubs for additional Babylon.js core/loaders symbols that Babylon
 * Lite either does not implement, or exposes only through a different native API
 * that the compat layer does not wrap 1:1.
 *
 * Every stub throws {@link LiteCompatError} on use with a pointer to the native
 * Babylon Lite alternative where one exists. This keeps the completeness
 * invariant — every core/loaders symbol resolves to an import and fails loudly
 * rather than silently.
 */

import { unsupported } from "../error.js";
import type { AbstractMesh, TransformNode } from "../meshes/meshes.js";
import type { AbstractEngine } from "../engine/engine.js";
import type { Matrix } from "../math/matrix.js";
import type { Vector3 } from "../math/vector.js";
import type { ShaderLanguage } from "../misc/engine-constants.js";
import type { Node } from "../node/node.js";
import type { Scene } from "../scene/scene.js";
import type { BaseTexture } from "../textures/textures.js";

export { Skeleton, Bone } from "../bones/skeleton.js";

// ─── Probes / Layers / Rendering ─────────────────────────────────────
export type GeometryRenderingObjectIdProvider = (mesh: AbstractMesh) => number;

export class ReflectionProbe {
    public constructor() {
        unsupported("ReflectionProbe", "Dynamic reflection probes are not implemented in Babylon Lite.");
    }
}

export class Layer {
    public constructor() {
        unsupported("Layer", "2D background/foreground layers are not wrapped. Use the native effect-render-task APIs for fullscreen overlays.");
    }
}

export class EffectLayer {
    public constructor() {
        unsupported("EffectLayer", "Effect layers are not implemented in Babylon Lite.");
    }
}

export class DepthRenderer {
    public constructor() {
        unsupported("DepthRenderer", "Use the native linear-depth material / geometry-renderer task instead.");
    }
}

export class GeometryBufferRenderer {
    public constructor() {
        unsupported("GeometryBufferRenderer", "Use the native `createGeometryRendererTask` (G-buffer) API instead.");
    }
}

export class BoundingBoxRenderer {
    public constructor() {
        unsupported("BoundingBoxRenderer", "Bounding-box rendering is not implemented in Babylon Lite.");
    }
}

// ─── Post-processes ──────────────────────────────────────────────────
// The visual effects below exist in Babylon Lite as frame-graph post-process
// tasks (e.g. `createBloomPostProcessTask`), but the Babylon.js camera-attached
// `PostProcess` class model is not wrapped. Use the native task APIs.
export class PostProcess {
    public constructor() {
        unsupported(
            "PostProcess",
            "Babylon Lite uses frame-graph post-process tasks rather than camera-attached PostProcess objects. Use the native `create*PostProcessTask` APIs."
        );
    }
}

export class Effect {
    public constructor() {
        unsupported(
            "Effect",
            "Babylon.js Effect owns shader-store lookup, preprocessing, compilation, reflection, and binding; Lite exposes explicit typed WGSL material/render-shader APIs instead."
        );
    }

    public isReady(): never {
        return unsupported("Effect.isReady", "Lite has no Babylon.js Effect compilation lifecycle.");
    }

    public getEngine(): never {
        return unsupported("Effect.getEngine", "Lite has no Babylon.js Effect object associated with a compat engine.");
    }

    public getCompilationError(): never {
        return unsupported("Effect.getCompilationError", "Lite has no Babylon.js Effect compilation lifecycle or error store.");
    }

    public setTexture(_channel: string, _texture: BaseTexture): never {
        return unsupported("Effect.setTexture", "Lite binds textures through typed material/render-shader APIs, not an Effect binding table.");
    }

    public setFloat(_uniformName: string, _value: number): never {
        return unsupported("Effect.setFloat", "Lite binds uniforms through typed material/render-shader APIs, not an Effect binding table.");
    }
}

export type EffectWrapperCustomShaderCodeProcessing = {
    processCodeAfterIncludes?: (postProcessName: string, shaderType: string, code: string) => string;
    processFinalCode?: (postProcessName: string, shaderType: string, code: string) => string;
    defineCustomBindings?: (postProcessName: string, defines: string | null, uniforms: string[], samplers: string[]) => string | null;
    bindCustomBindings?: (postProcessName: string, effect: Effect) => void;
};

export interface EffectWrapperCreationOptions {
    engine?: AbstractEngine;
    fragmentShader?: string;
    useShaderStore?: boolean;
    vertexShader?: string;
    vertexUrl?: string;
    attributeNames?: string[];
    uniformNames?: string[];
    uniforms?: string[] | null;
    samplerNames?: string[];
    samplers?: string[] | null;
    uniformBuffers?: string[] | null;
    defines?: string | string[] | null;
    indexParameters?: any;
    blockCompilation?: boolean;
    onCompiled?: ((effect: Effect) => void) | null;
    onError?: (effect: Effect, errors: string) => void;
    name?: string;
    shaderLanguage?: ShaderLanguage;
    extraInitializations?: (useWebGPU: boolean, list: Promise<any>[]) => void;
    extraInitializationsAsync?: () => Promise<void>;
    useAsPostProcess?: boolean;
    allowEmptySourceTexture?: boolean;
}

export class EffectWrapper {
    public static ForceGLSL = false;

    public static RegisterShaderCodeProcessing(
        _effectWrapperName: string | null,
        _customShaderCodeProcessing?: EffectWrapperCustomShaderCodeProcessing
    ): never {
        return unsupported(
            "EffectWrapper.RegisterShaderCodeProcessing",
            "Lite has no Babylon.js Effect shader-store/preprocessor registry to receive custom code-processing hooks."
        );
    }

    public constructor(_options: EffectWrapperCreationOptions) {
        unsupported(
            "EffectWrapper",
            "Babylon.js EffectWrapper compiles GLSL/WGSL through the Effect shader-store and preprocessor lifecycle; Lite exposes only explicit WGSL render shaders and has no Effect object to adapt."
        );
    }
}

const FRAME_GRAPH_MODEL_BLOCKER =
    "Lite exposes standalone frame-graph task factories, but not Babylon.js's FrameGraph handles, task base classes, texture manager, or node-render-graph object model required by this API.";

/** Babylon.js 9.29 frame-graph min/max reduction task. */
export class FrameGraphMinMaxReducerTask {
    public constructor(..._args: unknown[]) {
        unsupported("FrameGraphMinMaxReducerTask", FRAME_GRAPH_MODEL_BLOCKER);
    }
}

/** Babylon.js 9.29 node-render-graph min/max reduction block. */
export class NodeRenderGraphMinMaxReducerBlock {
    public constructor(..._args: unknown[]) {
        unsupported("NodeRenderGraphMinMaxReducerBlock", FRAME_GRAPH_MODEL_BLOCKER);
    }
}

/** Babylon.js 9.29 node-render-graph registration function. */
export function RegisterMinMaxReducerBlock(): never {
    return unsupported("RegisterMinMaxReducerBlock", FRAME_GRAPH_MODEL_BLOCKER);
}

function postProcessStub(name: string, nativeTask: string): { new (): never } {
    return class {
        public constructor() {
            unsupported(name, `Use the native \`${nativeTask}\` frame-graph task instead of the Babylon.js PostProcess class.`);
        }
    } as unknown as { new (): never };
}

export const BlackAndWhitePostProcess = postProcessStub("BlackAndWhitePostProcess", "createBlackAndWhitePostProcessTask");
export const BlurPostProcess = postProcessStub("BlurPostProcess", "createBlurPostProcessTask");
export const BloomEffect = postProcessStub("BloomEffect", "createBloomPostProcessTask");
export const ChromaticAberrationPostProcess = postProcessStub("ChromaticAberrationPostProcess", "createChromaticAberrationPostProcessTask");
export const DepthOfFieldEffect = postProcessStub("DepthOfFieldEffect", "createDepthOfFieldPostProcessTask");

export class DefaultRenderingPipeline {
    public constructor() {
        unsupported(
            "DefaultRenderingPipeline",
            "Compose the native frame-graph post-process tasks (bloom, depth-of-field, chromatic aberration, image processing) instead of the Babylon.js DefaultRenderingPipeline."
        );
    }
}

export class FxaaPostProcess {
    public constructor() {
        unsupported("FxaaPostProcess", "FXAA is not implemented in Babylon Lite.");
    }
}

export class SSAO2RenderingPipeline {
    public constructor() {
        unsupported("SSAO2RenderingPipeline", "SSAO is not implemented in Babylon Lite.");
    }
}

// FSR 1 (AMD FidelityFX Super Resolution) upscale + sharpen. Babylon Lite has no
// PostProcessRenderPipeline subsystem and ships no FSR/EASU/RCAS post-process, so
// there is nothing to forward to — the same structural blocker as the other rendering
// pipelines above.
export class FSR1RenderingPipeline {
    public constructor() {
        unsupported("FSR1RenderingPipeline", "FSR 1 upscaling is not implemented in Babylon Lite; it has no PostProcessRenderPipeline subsystem.");
    }
}

export class ThinFSR1UpscalePostProcess {
    public constructor() {
        unsupported("ThinFSR1UpscalePostProcess", "FSR 1 (EASU) upscaling is not implemented in Babylon Lite.");
    }
}

export class ThinFSR1SharpenPostProcess {
    public constructor() {
        unsupported("ThinFSR1SharpenPostProcess", "FSR 1 (RCAS) sharpening is not implemented in Babylon Lite.");
    }
}

// ─── Particles ───────────────────────────────────────────────────────
export class ParticleHelper {
    public constructor() {
        unsupported(
            "ParticleHelper",
            "The imperative particle-preset helper is not backed. Babylon Lite renders serialized Node Particle Editor graphs (`NodeParticleSystemSet.ParseFromSnippetAsync` → `buildAsync`), not preset-driven imperative `ParticleSystem`s."
        );
    }
}

export class PointsCloudSystem {
    public constructor() {
        unsupported("PointsCloudSystem", "Point-cloud systems are not implemented in Babylon Lite. For Gaussian splats use the native splat loaders.");
    }
}

export class CannonJSPlugin {
    public constructor() {
        unsupported("CannonJSPlugin", "Babylon Lite physics is Havok-V2 only.");
    }
}

export class AmmoJSPlugin {
    public constructor() {
        unsupported("AmmoJSPlugin", "Babylon Lite physics is Havok-V2 only.");
    }
}

// ─── Navigation ──────────────────────────────────────────────────────
export class RecastJSPlugin {
    public constructor() {
        unsupported("RecastJSPlugin", "Use the native Recast-V2 navigation API (`createNavigationPluginAsync`, `createNavMesh`, `createNavCrowd`).");
    }
}

// ─── Audio ───────────────────────────────────────────────────────────
export class AudioEngine {
    public constructor() {
        unsupported("AudioEngine", "Audio is not part of Babylon Lite. Use the Web Audio API directly.");
    }
}

export class WeightedSound {
    public constructor() {
        unsupported("WeightedSound", "Audio is not part of Babylon Lite.");
    }
}

// ─── Loaders (formats not present in Babylon Lite) ───────────────────
const FBX_LOADER_UNSUPPORTED =
    "FBX support requires a parser, DCC transform/material/animation mapping, geometry and skin materialization, and a scene-scheduled constraint solver. Those form a new loader subsystem with unresolved ownership and mapping policies.";

export class OBJFileLoader {
    public constructor() {
        unsupported("OBJFileLoader", "The OBJ format is not supported by Babylon Lite. Convert to glTF.");
    }
}

export class STLFileLoader {
    public constructor() {
        unsupported("STLFileLoader", "The STL format is not supported by Babylon Lite. Convert to glTF.");
    }
}

export type FBXNormalMapCoordinateSystem = "y-up" | "y-down";

export interface FBXLoaderWarning {
    source: "scene" | "model" | "geometry" | "skin" | "rig" | "animation" | "blendShape" | "camera" | "light";
    message: string;
    objectName?: string;
    details?: unknown;
}

export interface FBXFileLoaderOptions {
    preset?: "compatible" | "full";
    normalMapCoordinateSystem?: FBXNormalMapCoordinateSystem;
    materials?: "auto" | "standard" | "pbr";
    unitScale?: "preserve" | "meters" | number;
    shareGeometry?: boolean;
    onWarning?: (warning: FBXLoaderWarning) => void;
    nurbsSubdivision?: number;
    curves?: "lines" | "skip";
    constraints?: "apply" | "metadata";
    rebaseAnimations?: boolean;
    attachCamerasAndLights?: boolean;
}

export const FBXFileLoaderMetadata = {
    name: "fbx",
    extensions: {
        ".fbx": { isBinary: true },
    },
} as const;

export class FBXFileLoader {
    public constructor(_options: Partial<FBXFileLoaderOptions> = {}) {
        unsupported("FBXFileLoader", FBX_LOADER_UNSUPPORTED);
    }
}

export type FBXConstraintType = "aim" | "parent" | "position" | "rotation" | "scale" | "singleChainIK" | "unknown";
export type FBXConstraintVector3 = [number, number, number];
export type FBXConstraintBoolean3 = [boolean, boolean, boolean];

export interface FBXConstraintTarget {
    modelId: number;
    weight: number;
    offsetTranslation: FBXConstraintVector3;
    offsetRotation: FBXConstraintVector3;
    offsetScale: FBXConstraintVector3;
}

export interface FBXConstraintData {
    id: number;
    name: string;
    type: FBXConstraintType;
    typeName: string;
    nodeId?: number;
    targets: FBXConstraintTarget[];
    weight: number;
    active: boolean;
    affectTranslation: FBXConstraintBoolean3;
    affectRotation: FBXConstraintBoolean3;
    affectScale: FBXConstraintBoolean3;
    offsetTranslation: FBXConstraintVector3;
    offsetRotation: FBXConstraintVector3;
    offsetScale: FBXConstraintVector3;
    aimVector: FBXConstraintVector3;
    upVector: FBXConstraintVector3;
    worldUpVector: FBXConstraintVector3;
    worldUpType: number;
    worldUpNodeId?: number;
    ikFirstJointId?: number;
    ikEndJointId?: number;
    ikEffectorId?: number;
    ikPoleVector: FBXConstraintVector3;
}

export interface FBXConstraintBehaviorTarget {
    node: TransformNode;
    weight: number;
    offset: Matrix;
}

export interface FBXConstraintBehaviorOptions {
    root: TransformNode;
    targets: FBXConstraintBehaviorTarget[];
    upNode: TransformNode | null;
    sceneUp: Vector3;
}

export class FBXConstraintSolver {
    private constructor() {
        unsupported("FBXConstraintSolver", FBX_LOADER_UNSUPPORTED);
    }

    public static Get(_scene: Scene): FBXConstraintSolver | undefined {
        return unsupported("FBXConstraintSolver.Get", FBX_LOADER_UNSUPPORTED);
    }

    public static GetOrCreate(_scene: Scene): FBXConstraintSolver {
        return unsupported("FBXConstraintSolver.GetOrCreate", FBX_LOADER_UNSUPPORTED);
    }

    public get constraints(): readonly FBXConstraintBehavior[] {
        return unsupported("FBXConstraintSolver.constraints", FBX_LOADER_UNSUPPORTED);
    }

    public get cyclicConstraints(): readonly FBXConstraintBehavior[] {
        return unsupported("FBXConstraintSolver.cyclicConstraints", FBX_LOADER_UNSUPPORTED);
    }

    public register(_behavior: FBXConstraintBehavior): void {
        unsupported("FBXConstraintSolver.register", FBX_LOADER_UNSUPPORTED);
    }

    public unregister(_behavior: FBXConstraintBehavior): void {
        unsupported("FBXConstraintSolver.unregister", FBX_LOADER_UNSUPPORTED);
    }

    public invalidateOrder(): void {
        unsupported("FBXConstraintSolver.invalidateOrder", FBX_LOADER_UNSUPPORTED);
    }

    public beginFrame(): void {
        unsupported("FBXConstraintSolver.beginFrame", FBX_LOADER_UNSUPPORTED);
    }

    public solve(): void {
        unsupported("FBXConstraintSolver.solve", FBX_LOADER_UNSUPPORTED);
    }
}

export class FBXConstraintBehavior {
    public readonly name: string;
    public attachedNode: TransformNode | null = null;
    public enabled = true;

    public constructor(
        public readonly constraint: FBXConstraintData,
        _options: FBXConstraintBehaviorOptions
    ) {
        this.name = `fbxConstraint:${constraint.name}`;
        unsupported("FBXConstraintBehavior", FBX_LOADER_UNSUPPORTED);
    }

    public init(): void {
        unsupported("FBXConstraintBehavior.init", FBX_LOADER_UNSUPPORTED);
    }

    public attach(_target: TransformNode): void {
        unsupported("FBXConstraintBehavior.attach", FBX_LOADER_UNSUPPORTED);
    }

    public detach(): void {
        unsupported("FBXConstraintBehavior.detach", FBX_LOADER_UNSUPPORTED);
    }

    public captureBase(): void {
        unsupported("FBXConstraintBehavior.captureBase", FBX_LOADER_UNSUPPORTED);
    }

    public restoreBase(): void {
        unsupported("FBXConstraintBehavior.restoreBase", FBX_LOADER_UNSUPPORTED);
    }

    public dependencyNodes(): Array<Node | null> {
        return unsupported("FBXConstraintBehavior.dependencyNodes", FBX_LOADER_UNSUPPORTED);
    }

    public evaluate(): void {
        unsupported("FBXConstraintBehavior.evaluate", FBX_LOADER_UNSUPPORTED);
    }
}

export class BVHFileLoader {
    public constructor() {
        unsupported("BVHFileLoader", "The BVH format is not supported by Babylon Lite.");
    }
}

// ─── Sprites ─────────────────────────────────────────────────────────
// `SpriteManager` / `Sprite` are wrapped over Lite's facing-billboard system
// (see ../sprites/sprites.ts). `SpriteMap` / `SpritePackedManager` remain
// unsupported (tile-map / packed-atlas variants are not wrapped).
export class SpriteMap {
    public constructor() {
        unsupported("SpriteMap", "Tile-map sprites are not wrapped; use the native sprite APIs.");
    }
}

export class SpritePackedManager {
    public constructor() {
        unsupported("SpritePackedManager", "Use the native Babylon Lite sprite APIs.");
    }
}

// ─── Misc (device / optimisation surfaces not wrapped) ───────────────
export class VirtualJoystick {
    public constructor() {
        unsupported("VirtualJoystick", "The virtual joystick UI is not part of Babylon Lite.");
    }
}

export class SceneOptimizer {
    public constructor() {
        unsupported("SceneOptimizer", "Automatic scene optimisation is not implemented in the compat layer.");
    }
}
