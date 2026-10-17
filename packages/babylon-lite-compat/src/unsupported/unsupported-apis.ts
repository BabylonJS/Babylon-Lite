/**
 * Stubs for Babylon.js core/loader APIs that are **known but not supported** by
 * Babylon Lite.
 *
 * Every entry here throws {@link LiteCompatError} on use (construction or call),
 * so a ported scene fails loudly with a clear pointer instead of either a
 * confusing "X is not exported from the compat package" error or, worse, a
 * silently-wrong render. These mirror the `❌ Not supported` /
 * `⛔ Out of scope` rows in `COMPAT-STATUS.md`.
 *
 * As Babylon Lite gains a capability, the corresponding stub here should be
 * replaced by a real wrapper (and its `COMPAT-STATUS.md` row upgraded).
 */

import { unsupported } from "../error.js";
import { GAUSSIAN_SPLATTING_MAX_PART_COUNT, encodeIdToColor, getGaussianSplattingMaxPartCount, getGaussianSplattingPartIndexVaryingDeclaration } from "babylon-lite";
import type { AbstractEngine } from "../engine/engine.js";
import { PushMaterial } from "../materials/materials.js";
import type { Material } from "../materials/materials.js";
import type { Scene } from "../scene/scene.js";
import type { Camera } from "../cameras/cameras.js";
import { ShaderLanguage } from "../misc/engine-constants.js";
import type { StandardMaterial, PBRMaterial } from "../materials/materials.js";
import type { Mesh, InstancedMesh } from "../meshes/meshes.js";
import { MaterialPluginBase } from "../materials/material-plugin.js";
import type { AnimationGroup } from "../animations/animation.js";
import type { Bone } from "../bones/skeleton.js";
import type { TransformNode } from "../meshes/meshes.js";
import type { Vector3 } from "../math/vector.js";
import type { Color3 } from "../math/color.js";
import type { Observable } from "../misc/observable.js";
import type { Matrix } from "../math/matrix.js";
import type { StorageBuffer } from "../buffers/storage-buffer.js";

const FLUID_RENDERER_UNSUPPORTED =
    "Fluid rendering requires dedicated depth, thickness, and diffuse passes plus render-target lifecycle and composition policies that Babylon Lite does not define.";
const DITHERED_TILE_FADE_UNSUPPORTED =
    "Lite's material-plugin bridge supports shared shader injection, but not Babylon.js per-draw mesh uniforms, hardware-instance bounds, or custom thin-instance attributes/varyings. Adding those requires an opt-in per-renderable plugin-data design.";
const GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED =
    "Lite's Gaussian-splat renderable fixes shader fragments and render state at load time and exposes no post-load material replacement or pipeline-rebuild lifecycle. Supporting Babylon.js GaussianSplattingMaterial plugins requires an opt-in Lite splat-material lifecycle design.";
const GAUSSIAN_POINT_SPLATTING_UNSUPPORTED =
    "Babylon.js Gaussian Point Splatting is a separate stochastic WebGPU compute-renderer subsystem with accumulation, Hi-Z culling, depth-pass integration, and fullscreen compositing lifecycles. Lite's sorted-splat renderer has no equivalent compute or pass-ownership model, and adding one requires broad engine design rather than a small mechanical export.";
// ─── Flow graph validation ───────────────────────────────────────────
const FLOW_GRAPH_UNSUPPORTED =
    "Babylon Lite's flow-graph runtime does not expose Babylon.js FlowGraph blocks, connections, or contexts. Validation requires a stable cross-model graph adapter and block registry design.";

export enum FlowGraphValidationSeverity {
    Error = 0,
    Warning = 1,
}

export interface IFlowGraphValidationIssue {
    severity: FlowGraphValidationSeverity;
    message: string;
    block?: unknown;
    connectionName?: string;
}

export interface IFlowGraphValidationResult {
    isValid: boolean;
    issues: IFlowGraphValidationIssue[];
    errorCount: number;
    warningCount: number;
    issuesByBlock: Map<string, IFlowGraphValidationIssue[]>;
}

export function ValidateFlowGraph(_flowGraph: unknown): IFlowGraphValidationResult {
    return unsupported("ValidateFlowGraph", FLOW_GRAPH_UNSUPPORTED);
}

export function ValidateFlowGraphWithBlockList(_flowGraph: unknown, _allKnownBlocks: unknown[]): IFlowGraphValidationResult {
    return unsupported("ValidateFlowGraphWithBlockList", FLOW_GRAPH_UNSUPPORTED);
}

// ─── Fluid rendering ─────────────────────────────────────────────────
export abstract class FluidRenderingObject {
    public static UsePerParticleSizeAttribute = false;

    protected constructor(_scene: Scene, _shaderLanguage?: ShaderLanguage) {
        unsupported("FluidRenderingObject", FLUID_RENDERER_UNSUPPORTED);
    }
}

export class FluidRenderingObjectParticleSystem extends FluidRenderingObject {
    public constructor(scene: Scene, _particleSystem: unknown, shaderLanguage?: ShaderLanguage) {
        super(scene, shaderLanguage);
    }
}

export class FluidRenderingObjectCustomParticles extends FluidRenderingObject {
    public constructor(scene: Scene, _buffers: Record<string, ArrayLike<number>>, _numParticles: number, shaderLanguage?: ShaderLanguage) {
        super(scene, shaderLanguage);
    }
}

export class FluidRenderingTargetRenderer {
    public constructor(_scene: Scene, _camera?: Camera, _shaderLanguage?: ShaderLanguage) {
        unsupported("FluidRenderingTargetRenderer", FLUID_RENDERER_UNSUPPORTED);
    }
}

export class FluidRenderer {
    public constructor(_scene: Scene) {
        unsupported("FluidRenderer", FLUID_RENDERER_UNSUPPORTED);
    }
}

export class FluidRendererSceneComponent {
    public constructor(_scene: Scene) {
        unsupported("FluidRendererSceneComponent", FLUID_RENDERER_UNSUPPORTED);
    }
}

export function RegisterFluidRenderer(): void {
    unsupported("RegisterFluidRenderer", FLUID_RENDERER_UNSUPPORTED);
}

// ─── Root motion ─────────────────────────────────────────────────────
const ROOT_MOTION_UNSUPPORTED =
    "Babylon.js root motion analyzes animation hierarchies, rewrites in-place clips, journals mixer writes, and applies blended per-frame travel. Lite exposes animation playback but not that analysis and mixer-journal subsystem; its lifecycle and ownership require a Lite-level design.";

export enum RootMotionSource {
    None = 0,
    Root = 1,
    FootContact = 2,
}

export interface IRootMotionClipOptions {
    rootNode?: TransformNode | Bone;
    characterNode?: TransformNode;
    contactNodes?: Array<TransformNode | Bone>;
    source?: RootMotionSource;
    extractRotation?: boolean;
    samplesPerSecond?: number;
    minimumTravel?: number;
    minimumTurn?: number;
    directionSnapAngle?: number;
    extractLateralMotion?: boolean;
    upAxis?: Vector3;
    name?: string;
    cloneAnimations?: boolean;
}

export class RootMotionClip {
    public constructor(_animationGroup: AnimationGroup, _options: IRootMotionClipOptions = {}) {
        unsupported("RootMotionClip", ROOT_MOTION_UNSUPPORTED);
    }

    public get sourceAnimationGroup(): AnimationGroup {
        return unsupported("RootMotionClip.sourceAnimationGroup", ROOT_MOTION_UNSUPPORTED);
    }
    public get animationGroup(): AnimationGroup {
        return unsupported("RootMotionClip.animationGroup", ROOT_MOTION_UNSUPPORTED);
    }
    public get controller(): RootMotionController | null {
        return unsupported("RootMotionClip.controller", ROOT_MOTION_UNSUPPORTED);
    }
    public get source(): RootMotionSource {
        return unsupported("RootMotionClip.source", ROOT_MOTION_UNSUPPORTED);
    }
    public get rootNode(): TransformNode | null {
        return unsupported("RootMotionClip.rootNode", ROOT_MOTION_UNSUPPORTED);
    }
    public get characterNode(): TransformNode {
        return unsupported("RootMotionClip.characterNode", ROOT_MOTION_UNSUPPORTED);
    }
    public get contactNodes(): ReadonlyArray<TransformNode> {
        return unsupported("RootMotionClip.contactNodes", ROOT_MOTION_UNSUPPORTED);
    }
    public get upAxis(): Vector3 {
        return unsupported("RootMotionClip.upAxis", ROOT_MOTION_UNSUPPORTED);
    }
    public get fromFrame(): number {
        return unsupported("RootMotionClip.fromFrame", ROOT_MOTION_UNSUPPORTED);
    }
    public get toFrame(): number {
        return unsupported("RootMotionClip.toFrame", ROOT_MOTION_UNSUPPORTED);
    }
    public get travelDirection(): Vector3 {
        return unsupported("RootMotionClip.travelDirection", ROOT_MOTION_UNSUPPORTED);
    }
    public get cycleOffset(): Vector3 {
        return unsupported("RootMotionClip.cycleOffset", ROOT_MOTION_UNSUPPORTED);
    }
    public get cycleDistance(): number {
        return unsupported("RootMotionClip.cycleDistance", ROOT_MOTION_UNSUPPORTED);
    }
    public get cycleRotation(): number {
        return unsupported("RootMotionClip.cycleRotation", ROOT_MOTION_UNSUPPORTED);
    }
    public get extractsRotation(): boolean {
        return unsupported("RootMotionClip.extractsRotation", ROOT_MOTION_UNSUPPORTED);
    }
    public get duration(): number {
        return unsupported("RootMotionClip.duration", ROOT_MOTION_UNSUPPORTED);
    }
    public get averageSpeed(): number {
        return unsupported("RootMotionClip.averageSpeed", ROOT_MOTION_UNSUPPORTED);
    }
    public get characterHeight(): number {
        return unsupported("RootMotionClip.characterHeight", ROOT_MOTION_UNSUPPORTED);
    }
    public getOffsetAtFrame(_frame: number, _result: Vector3): Vector3 {
        return unsupported("RootMotionClip.getOffsetAtFrame", ROOT_MOTION_UNSUPPORTED);
    }
    public getRotationAtFrame(_frame: number): number {
        return unsupported("RootMotionClip.getRotationAtFrame", ROOT_MOTION_UNSUPPORTED);
    }
    public dispose(): void {
        unsupported("RootMotionClip.dispose", ROOT_MOTION_UNSUPPORTED);
    }
}

export class RootMotionController {
    public applyToCharacter = true;
    public readonly onRootMotionObservable!: Observable<RootMotionController>;

    public constructor(_characterNode: TransformNode, _clips: RootMotionClip[] = []) {
        unsupported("RootMotionController", ROOT_MOTION_UNSUPPORTED);
    }

    public get characterNode(): TransformNode {
        return unsupported("RootMotionController.characterNode", ROOT_MOTION_UNSUPPORTED);
    }
    public get clips(): ReadonlyArray<RootMotionClip> {
        return unsupported("RootMotionController.clips", ROOT_MOTION_UNSUPPORTED);
    }
    public get deltaPosition(): Vector3 {
        return unsupported("RootMotionController.deltaPosition", ROOT_MOTION_UNSUPPORTED);
    }
    public get deltaRotation(): number {
        return unsupported("RootMotionController.deltaRotation", ROOT_MOTION_UNSUPPORTED);
    }
    public addClip(_clip: RootMotionClip): void {
        unsupported("RootMotionController.addClip", ROOT_MOTION_UNSUPPORTED);
    }
    public removeClip(_clip: RootMotionClip): void {
        unsupported("RootMotionController.removeClip", ROOT_MOTION_UNSUPPORTED);
    }
    public reset(): void {
        unsupported("RootMotionController.reset", ROOT_MOTION_UNSUPPORTED);
    }
    public dispose(): void {
        unsupported("RootMotionController.dispose", ROOT_MOTION_UNSUPPORTED);
    }
}

// ─── Materials ───────────────────────────────────────────────────────
export class MultiMaterial {
    public constructor() {
        unsupported("MultiMaterial", "Babylon Lite uses one material per renderable. Split the mesh geometry by material into separate meshes instead.");
    }
}

export type DitheredTileFadeSupportedMaterial = StandardMaterial | PBRMaterial;
export type DitheredTileFadeMesh = Mesh | InstancedMesh;

export interface IDitheredTileFadeBounds {
    lowerBound: number;
    upperBound: number;
}

export interface IGaussianSplattingDebugOptions {
    clippingBox: { min: Vector3; max: Vector3 } | null;
    opacityCulling: { min: number; max: number } | null;
    sizeCulling: { min: number; max: number } | null;
    opacityScale: number;
    opacitySaturate: boolean;
    shDc: boolean;
    shOrder1: boolean;
    shOrder2: boolean;
    shOrder3: boolean;
    shOrder4: boolean;
}

export const GaussianSplattingMaxPartCount = GAUSSIAN_SPLATTING_MAX_PART_COUNT;

export function GetGaussianSplattingMaxPartCount(engine: AbstractEngine): number {
    return getGaussianSplattingMaxPartCount(engine._lite);
}

export function GetPartIndexVaryingDeclaration(shaderLanguage: ShaderLanguage): string {
    return getGaussianSplattingPartIndexVaryingDeclaration(shaderLanguage === ShaderLanguage.WGSL);
}

export class GaussianSplattingMaterial extends PushMaterial {
    /** @internal The unsupported material has no Lite backing. */
    public get _lite(): never {
        return unsupported("GaussianSplattingMaterial._lite", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
    }

    public constructor(name: string, scene?: Scene) {
        super(name);
        void scene;
        unsupported("GaussianSplattingMaterial", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
    }

    public override clone(_name: string): GaussianSplattingMaterial {
        return unsupported("GaussianSplattingMaterial.clone", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
    }
}

export class GaussianSplattingDebugMaterialPlugin extends MaterialPluginBase {
    /** @internal An unsupported plugin must not attach to a Lite material. */
    protected override get _attachToLite(): boolean {
        return false;
    }

    public constructor(material: GaussianSplattingMaterial) {
        super(material, "GaussianSplattingDebug", 200, {}, false);
        unsupported("GaussianSplattingDebugMaterialPlugin", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
    }
}

export class GaussianSplattingGpuPickingMaterialPlugin extends MaterialPluginBase {
    public static EncodeIdToColor(id: number): [number, number, number] {
        return encodeIdToColor(id);
    }

    /** @internal An unsupported plugin must not attach to a Lite material. */
    protected override get _attachToLite(): boolean {
        return false;
    }

    public constructor(material: GaussianSplattingMaterial, _maxPartCount?: number) {
        super(material, "GaussianSplatGpuPicking", 230, {}, false);
        unsupported("GaussianSplattingGpuPickingMaterialPlugin", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
    }
}

export class GaussianSplattingSolidColorMaterialPlugin extends MaterialPluginBase {
    /** @internal An unsupported plugin must not attach to a Lite material. */
    protected override get _attachToLite(): boolean {
        return false;
    }

    public constructor(material: GaussianSplattingMaterial, _partColors: Color3[], _maxPartCount?: number) {
        super(material, "GaussianSplatSolidColor", 200, {}, false);
        unsupported("GaussianSplattingSolidColorMaterialPlugin", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
    }
}

export class GaussianSplattingSizeMaterialPlugin extends MaterialPluginBase {
    /** @internal An unsupported plugin must not attach to a Lite material. */
    protected override get _attachToLite(): boolean {
        return false;
    }

    public constructor(material: GaussianSplattingMaterial) {
        super(material, "GaussianSplattingSize", 210, {}, false);
        unsupported("GaussianSplattingSizeMaterialPlugin", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
    }

    public get isEnabled(): boolean {
        return unsupported("GaussianSplattingSizeMaterialPlugin.isEnabled", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
    }

    public set isEnabled(_value: boolean) {
        unsupported("GaussianSplattingSizeMaterialPlugin.isEnabled", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
    }

    public get sizeScale(): number {
        return unsupported("GaussianSplattingSizeMaterialPlugin.sizeScale", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
    }

    public set sizeScale(_value: number) {
        unsupported("GaussianSplattingSizeMaterialPlugin.sizeScale", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
    }
}

export class GaussianSplattingOverdrawMaterialPlugin extends MaterialPluginBase {
    /** @internal An unsupported plugin must not attach to a Lite material. */
    protected override get _attachToLite(): boolean {
        return false;
    }

    public constructor(material: GaussianSplattingMaterial) {
        super(material, "GaussianSplattingOverdraw", 220, {}, false);
        unsupported("GaussianSplattingOverdrawMaterialPlugin", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
    }

    public get isEnabled(): boolean {
        return unsupported("GaussianSplattingOverdrawMaterialPlugin.isEnabled", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
    }

    public set isEnabled(_value: boolean) {
        unsupported("GaussianSplattingOverdrawMaterialPlugin.isEnabled", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
    }

    public get intensity(): number {
        return unsupported("GaussianSplattingOverdrawMaterialPlugin.intensity", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
    }

    public set intensity(_value: number) {
        unsupported("GaussianSplattingOverdrawMaterialPlugin.intensity", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
    }
}

export function RegisterGaussianSplattingDebugMaterialPlugin(): void {
    unsupported("RegisterGaussianSplattingDebugMaterialPlugin", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
}

export function RegisterGaussianSplattingGpuPickingMaterialPlugin(): void {
    unsupported("RegisterGaussianSplattingGpuPickingMaterialPlugin", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
}

export function RegisterGaussianSplattingSolidColorMaterialPlugin(): void {
    unsupported("RegisterGaussianSplattingSolidColorMaterialPlugin", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
}

export function RegisterGaussianSplattingSizeMaterialPlugin(): void {
    unsupported("RegisterGaussianSplattingSizeMaterialPlugin", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
}

export function RegisterGaussianSplattingOverdrawMaterialPlugin(): void {
    unsupported("RegisterGaussianSplattingOverdrawMaterialPlugin", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
}

export function RegisterGaussianSplattingMaterial(): void {
    unsupported("RegisterGaussianSplattingMaterial", GAUSSIAN_SPLATTING_MATERIAL_UNSUPPORTED);
}

export class GaussianPointSplattingRenderer {
    public pointScale = 1;
    public kernelSize = 0.3;
    public minPixelSize = 0;
    public rightHandedSystem = false;
    public debugActive = 0;
    public isOrthographic = false;
    public compensation = false;
    public occlusionCulling = false;
    public maxAccumFrames = 255;

    public constructor(_engine: AbstractEngine) {
        unsupported("GaussianPointSplattingRenderer", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public supportsWorkload(_gaussianCount: number, _shDegree: number, _outWidth: number, _outHeight: number): boolean {
        return unsupported("GaussianPointSplattingRenderer.supportsWorkload", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public get accumBuffer(): StorageBuffer | null {
        return unsupported("GaussianPointSplattingRenderer.accumBuffer", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public get accumDepthBuffer(): StorageBuffer | null {
        return unsupported("GaussianPointSplattingRenderer.accumDepthBuffer", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public get renderedFrameCount(): number {
        return unsupported("GaussianPointSplattingRenderer.renderedFrameCount", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public get accumulationVersion(): number {
        return unsupported("GaussianPointSplattingRenderer.accumulationVersion", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public get pixelCycleLength(): number {
        return unsupported("GaussianPointSplattingRenderer.pixelCycleLength", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public async readPointCountAsync(): Promise<number> {
        return unsupported("GaussianPointSplattingRenderer.readPointCountAsync", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public get width(): number {
        return unsupported("GaussianPointSplattingRenderer.width", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public get height(): number {
        return unsupported("GaussianPointSplattingRenderer.height", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public get outputWidth(): number {
        return unsupported("GaussianPointSplattingRenderer.outputWidth", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public get outputHeight(): number {
        return unsupported("GaussianPointSplattingRenderer.outputHeight", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public get gaussianCount(): number {
        return unsupported("GaussianPointSplattingRenderer.gaussianCount", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public isReady(): boolean {
        return unsupported("GaussianPointSplattingRenderer.isReady", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public updateSplats(
        _means: Float32Array,
        _cov3d: Uint32Array,
        _colorOpacity: Uint32Array,
        _sh: Uint32Array | null,
        _shDegree: number,
        _count: number
    ): void {
        unsupported("GaussianPointSplattingRenderer.updateSplats", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public resetAccumulation(): void {
        unsupported("GaussianPointSplattingRenderer.resetAccumulation", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public setCamera(
        _view: Matrix,
        _viewProjection: Matrix,
        _near: number,
        _far: number,
        _focalX: number,
        _focalY: number,
        _camX: number,
        _camY: number,
        _camZ: number,
        _viewZMin: number,
        _viewZMax: number
    ): void {
        unsupported("GaussianPointSplattingRenderer.setCamera", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public setProjectionZ(_m10: number, _m11: number, _m14: number, _m15: number): void {
        unsupported("GaussianPointSplattingRenderer.setProjectionZ", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public setProjectionMatrix(_projection: Matrix, _inverseProjection: Matrix, _reverseDepth = false): void {
        unsupported("GaussianPointSplattingRenderer.setProjectionMatrix", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public setPartData(_packed: Float32Array, _count: number): void {
        unsupported("GaussianPointSplattingRenderer.setPartData", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    /** @internal */
    public _matchesPartData(_packed: Float32Array, _count: number): boolean {
        return unsupported("GaussianPointSplattingRenderer._matchesPartData", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public renderToBuffer(_width: number, _height: number, _outWidth = _width, _outHeight = _height, _upsampleN = 1, _jitterX = 0, _jitterY = 0): boolean {
        return unsupported("GaussianPointSplattingRenderer.renderToBuffer", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public dispose(): void {
        unsupported("GaussianPointSplattingRenderer.dispose", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }
}

export class DitheredTileFadeMaterialPlugin extends MaterialPluginBase {
    public static readonly Name = "DitheredTileFade";

    /** @internal The unsupported constructor must not alter the material or scene. */
    protected override get _attachToLite(): boolean {
        return false;
    }

    public constructor(material: DitheredTileFadeSupportedMaterial) {
        super(material, DitheredTileFadeMaterialPlugin.Name, 190, {}, false);
        unsupported("DitheredTileFadeMaterialPlugin", DITHERED_TILE_FADE_UNSUPPORTED);
    }

    public static GetOrCreate(_material: DitheredTileFadeSupportedMaterial): DitheredTileFadeMaterialPlugin {
        return unsupported("DitheredTileFadeMaterialPlugin.GetOrCreate", DITHERED_TILE_FADE_UNSUPPORTED);
    }

    public get isEnabled(): boolean {
        return unsupported("DitheredTileFadeMaterialPlugin.isEnabled", DITHERED_TILE_FADE_UNSUPPORTED);
    }

    public set isEnabled(_value: boolean) {
        unsupported("DitheredTileFadeMaterialPlugin.isEnabled", DITHERED_TILE_FADE_UNSUPPORTED);
    }

    public setFadeBounds(_mesh: DitheredTileFadeMesh, _lowerBound: number, _upperBound: number): void {
        unsupported("DitheredTileFadeMaterialPlugin.setFadeBounds", DITHERED_TILE_FADE_UNSUPPORTED);
    }

    public setFadeLowerBound(_mesh: DitheredTileFadeMesh, _lowerBound: number): void {
        unsupported("DitheredTileFadeMaterialPlugin.setFadeLowerBound", DITHERED_TILE_FADE_UNSUPPORTED);
    }

    public setFadeUpperBound(_mesh: DitheredTileFadeMesh, _upperBound: number): void {
        unsupported("DitheredTileFadeMaterialPlugin.setFadeUpperBound", DITHERED_TILE_FADE_UNSUPPORTED);
    }

    public getFadeBoundsToRef(_mesh: DitheredTileFadeMesh, _result: IDitheredTileFadeBounds): boolean {
        return unsupported("DitheredTileFadeMaterialPlugin.getFadeBoundsToRef", DITHERED_TILE_FADE_UNSUPPORTED);
    }

    public resetFade(_mesh: DitheredTileFadeMesh): void {
        unsupported("DitheredTileFadeMaterialPlugin.resetFade", DITHERED_TILE_FADE_UNSUPPORTED);
    }

    public setThinInstanceFadeBounds(_mesh: Mesh, _index: number, _lowerBound: number, _upperBound: number, _refresh = true): void {
        unsupported("DitheredTileFadeMaterialPlugin.setThinInstanceFadeBounds", DITHERED_TILE_FADE_UNSUPPORTED);
    }

    public setThinInstanceFadeBoundsBuffer(_mesh: Mesh, _bounds: Float32Array): void {
        unsupported("DitheredTileFadeMaterialPlugin.setThinInstanceFadeBoundsBuffer", DITHERED_TILE_FADE_UNSUPPORTED);
    }

    public commitThinInstanceFadeBounds(_mesh: Mesh): void {
        unsupported("DitheredTileFadeMaterialPlugin.commitThinInstanceFadeBounds", DITHERED_TILE_FADE_UNSUPPORTED);
    }

    public resetThinInstanceFade(_mesh: Mesh, _index: number, _refresh = true): void {
        unsupported("DitheredTileFadeMaterialPlugin.resetThinInstanceFade", DITHERED_TILE_FADE_UNSUPPORTED);
    }

    public reset(): void {
        unsupported("DitheredTileFadeMaterialPlugin.reset", DITHERED_TILE_FADE_UNSUPPORTED);
    }

    public copyToMaterial(_material: DitheredTileFadeSupportedMaterial): DitheredTileFadeMaterialPlugin {
        return unsupported("DitheredTileFadeMaterialPlugin.copyToMaterial", DITHERED_TILE_FADE_UNSUPPORTED);
    }

    public getClassName(): string {
        return "DitheredTileFadeMaterialPlugin";
    }
}

export class ShaderMaterial {
    public constructor() {
        unsupported(
            new.target.name || "ShaderMaterial",
            new.target === GaussianPointSplattingBlitMaterial || new.target === GaussianPointSplattingDepthBlitMaterial
                ? GAUSSIAN_POINT_SPLATTING_UNSUPPORTED
                : "Lite accepts standalone WGSL, but Babylon.js ShaderMaterial sources rely on the Effect shader-store/preprocessor dialect (attribute/varying declarations and injected VertexInputs/FragmentInputs); adapting it requires a shader preprocessing subsystem."
        );
    }
}

export class GaussianPointSplattingBlitMaterial extends ShaderMaterial {
    public constructor(_name: string, _scene: Scene) {
        super();
    }

    public setAccumBuffer(_buffer: StorageBuffer): void {
        unsupported("GaussianPointSplattingBlitMaterial.setAccumBuffer", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public setAccumDepthBuffer(_buffer: StorageBuffer): void {
        unsupported("GaussianPointSplattingBlitMaterial.setAccumDepthBuffer", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public setResolution(_width: number, _height: number): void {
        unsupported("GaussianPointSplattingBlitMaterial.setResolution", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public setProjectionZ(_m10: number, _m11: number, _m14: number, _m15: number): void {
        unsupported("GaussianPointSplattingBlitMaterial.setProjectionZ", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public setInverseProjection(_inverseProjection: Matrix): void {
        unsupported("GaussianPointSplattingBlitMaterial.setInverseProjection", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public setLogarithmicDepthConstant(_constant: number): void {
        unsupported("GaussianPointSplattingBlitMaterial.setLogarithmicDepthConstant", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }
}

export class GaussianPointSplattingDepthBlitMaterial extends ShaderMaterial {
    public constructor(_name: string, _scene: Scene) {
        super();
    }

    public setAccumBuffer(_buffer: StorageBuffer): void {
        unsupported("GaussianPointSplattingDepthBlitMaterial.setAccumBuffer", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public setAccumDepthBuffer(_buffer: StorageBuffer): void {
        unsupported("GaussianPointSplattingDepthBlitMaterial.setAccumDepthBuffer", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public setResolution(_width: number, _height: number): void {
        unsupported("GaussianPointSplattingDepthBlitMaterial.setResolution", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public setProjectionZ(_m10: number, _m11: number, _m14: number, _m15: number): void {
        unsupported("GaussianPointSplattingDepthBlitMaterial.setProjectionZ", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public setInverseProjection(_inverseProjection: Matrix): void {
        unsupported("GaussianPointSplattingDepthBlitMaterial.setInverseProjection", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public setDepthValues(_minZ: number, _minZPlusMaxZ: number): void {
        unsupported("GaussianPointSplattingDepthBlitMaterial.setDepthValues", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }

    public setReverseDepth(_reverse: boolean): void {
        unsupported("GaussianPointSplattingDepthBlitMaterial.setReverseDepth", GAUSSIAN_POINT_SPLATTING_UNSUPPORTED);
    }
}

export class BackgroundMaterial {
    public constructor() {
        unsupported("BackgroundMaterial", "Standalone BackgroundMaterial is not wrapped. Use the compat `Scene` environment helpers / native `loadEnvironment` instead.");
    }
}

export class OpenPBRMaterial extends PushMaterial {
    /** @internal Unsupported stubs never expose a backing Lite material. */
    public override get _lite(): never {
        return unsupported(
            "OpenPBRMaterial._lite",
            "OpenPBR requires a distinct shader/material model and parameter mapping that Babylon Lite does not define; adding that subsystem needs Lite maintainer design."
        );
    }

    public constructor(_name: string, _scene?: Scene, _forceGLSL = false) {
        super(_name);
        unsupported(
            "OpenPBRMaterial",
            "OpenPBR requires a distinct shader/material model and parameter mapping that Babylon Lite does not define; adding that subsystem needs Lite maintainer design."
        );
    }

    public clone(_name: string, _cloneTexturesOnlyOnce = true, _rootUrl = ""): OpenPBRMaterial {
        return unsupported(
            "OpenPBRMaterial.clone",
            "OpenPBR requires a distinct shader/material model and parameter mapping that Babylon Lite does not define; adding that subsystem needs Lite maintainer design."
        );
    }
}

export class OpenPBRMaterialDefines {
    public constructor(_externalProperties?: Record<string, { type: string; default: unknown }>) {
        unsupported(
            "OpenPBRMaterialDefines",
            "OpenPBR requires a distinct shader/material model and parameter mapping that Babylon Lite does not define; adding that subsystem needs Lite maintainer design."
        );
    }
}

export function RegisterOpenpbrMaterial(): void {
    unsupported(
        "RegisterOpenpbrMaterial",
        "OpenPBR registration would install a material parser and shader subsystem that Babylon Lite does not define; adding that subsystem needs Lite maintainer design."
    );
}

export class OpenPBRMaterialLoadingAdapter {
    public constructor(_material: Material) {
        unsupported(
            "OpenPBRMaterialLoadingAdapter",
            "The adapter translates glTF material data into OpenPBRMaterial, whose shader/material subsystem requires Lite maintainer design."
        );
    }
}

// ─── Lights ──────────────────────────────────────────────────────────
export class RectAreaLight {
    public constructor() {
        unsupported("RectAreaLight", "Area lights are not implemented in Babylon Lite. Use Point/Spot/Directional/Hemispheric lights.");
    }
}

// ─── Particles ───────────────────────────────────────────────────────
export class GPUParticleSystem {
    public constructor() {
        unsupported(
            "GPUParticleSystem",
            "Babylon Lite has no GPU-compute particle path. Its node-particle runtime (`NodeParticleSystemSet`) is a CPU struct-of-arrays simulation; use `NodeParticleSystemSet.ParseFromSnippetAsync` → `buildAsync` instead."
        );
    }
}

export class SolidParticleSystem {
    public constructor() {
        unsupported(
            "SolidParticleSystem",
            "Solid particle systems (per-particle mesh copies) are not backed by Babylon Lite. Consider native thin instances for many-copies use cases; node-particle billboards are available via `NodeParticleSystemSet`."
        );
    }
}

// ─── Effect layers ───────────────────────────────────────────────────
export class HighlightLayer {
    public constructor() {
        unsupported("HighlightLayer", "Effect layers are not implemented in Babylon Lite.");
    }
}

export class GlowLayer {
    public constructor() {
        unsupported("GlowLayer", "Effect layers are not implemented in Babylon Lite. For a bloom-style glow, use the native bloom post-process task.");
    }
}

// ─── Mesh-attached renderers / projectors ────────────────────────────
// ─── GreasedLine (thick-line ribbon subsystem) ───────────────────────
// Greased lines render polylines as camera-facing ribbons/tubes driven by a
// dedicated plugin material (per-point widths, color/width distribution tables,
// dashing, ribbon face/direction modes). Babylon Lite renders only 1px hardware
// line-lists (see `MeshBuilder.CreateLines` / `CreateDashedLines`) and has no
// thick-line ribbon geometry generator or plugin-material subsystem to back it,
// so the whole family is a `❌ Not supported` throwing stub.
const GREASED_LINE_REASON =
    "Greased (thick) lines are a ribbon/tube geometry + dedicated plugin-material subsystem (per-point widths, color/width distribution tables, dashing, camera-facing ribbon modes). Babylon Lite renders only 1px hardware line-lists (MeshBuilder.CreateLines / CreateDashedLines) and has no thick-line ribbon pipeline or plugin material to back it.";

export class GreasedLineBaseMesh {
    public constructor(..._args: unknown[]) {
        unsupported("GreasedLineBaseMesh", GREASED_LINE_REASON);
    }
}

export class GreasedLineMesh {
    public constructor(..._args: unknown[]) {
        unsupported("GreasedLineMesh", GREASED_LINE_REASON);
    }
}

export class GreasedLineRibbonMesh {
    public constructor(..._args: unknown[]) {
        unsupported("GreasedLineRibbonMesh", GREASED_LINE_REASON);
    }
}

export class GreasedLinePluginMaterial {
    public constructor(..._args: unknown[]) {
        unsupported("GreasedLinePluginMaterial", GREASED_LINE_REASON);
    }
}

export class MaterialGreasedLineDefines {
    public constructor(..._args: unknown[]) {
        unsupported("MaterialGreasedLineDefines", GREASED_LINE_REASON);
    }
}

export class GreasedLineMaterialDefaults {
    public constructor(..._args: unknown[]) {
        unsupported("GreasedLineMaterialDefaults", GREASED_LINE_REASON);
    }

    public static get DEFAULT_COLOR(): never {
        return unsupported("GreasedLineMaterialDefaults.DEFAULT_COLOR", GREASED_LINE_REASON);
    }

    public static get DEFAULT_WIDTH_ATTENUATED(): never {
        return unsupported("GreasedLineMaterialDefaults.DEFAULT_WIDTH_ATTENUATED", GREASED_LINE_REASON);
    }

    public static get DEFAULT_WIDTH(): never {
        return unsupported("GreasedLineMaterialDefaults.DEFAULT_WIDTH", GREASED_LINE_REASON);
    }

    public static get EmptyColorsTexture(): never {
        return unsupported("GreasedLineMaterialDefaults.EmptyColorsTexture", GREASED_LINE_REASON);
    }
}

export function RegisterGreasedLinePluginMaterial(..._args: unknown[]): never {
    return unsupported("RegisterGreasedLinePluginMaterial", GREASED_LINE_REASON);
}

export class GreasedLineSimpleMaterial {
    public constructor(..._args: unknown[]) {
        unsupported("GreasedLineSimpleMaterial", GREASED_LINE_REASON);
    }
}

export class GreasedLineTools {
    public constructor(..._args: unknown[]) {
        unsupported("GreasedLineTools", GREASED_LINE_REASON);
    }

    public static ConvertPoints(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.ConvertPoints", GREASED_LINE_REASON);
    }

    public static OmitZeroLengthPredicate(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.OmitZeroLengthPredicate", GREASED_LINE_REASON);
    }

    public static OmitDuplicatesPredicate(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.OmitDuplicatesPredicate", GREASED_LINE_REASON);
    }

    public static MeshesToLines(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.MeshesToLines", GREASED_LINE_REASON);
    }

    public static ToVector3Array(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.ToVector3Array", GREASED_LINE_REASON);
    }

    public static ToNumberArray(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.ToNumberArray", GREASED_LINE_REASON);
    }

    public static GetPointsCountInfo(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.GetPointsCountInfo", GREASED_LINE_REASON);
    }

    public static GetLineLength(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.GetLineLength", GREASED_LINE_REASON);
    }

    public static GetLineLengthArray(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.GetLineLengthArray", GREASED_LINE_REASON);
    }

    public static SegmentizeSegmentByCount(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.SegmentizeSegmentByCount", GREASED_LINE_REASON);
    }

    public static SegmentizeLineBySegmentLength(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.SegmentizeLineBySegmentLength", GREASED_LINE_REASON);
    }

    public static SegmentizeLineBySegmentCount(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.SegmentizeLineBySegmentCount", GREASED_LINE_REASON);
    }

    public static GetLineSegments(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.GetLineSegments", GREASED_LINE_REASON);
    }

    public static GetMinMaxSegmentLength(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.GetMinMaxSegmentLength", GREASED_LINE_REASON);
    }

    public static GetPositionOnLineByVisibility(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.GetPositionOnLineByVisibility", GREASED_LINE_REASON);
    }

    public static GetCircleLinePoints(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.GetCircleLinePoints", GREASED_LINE_REASON);
    }

    public static GetBezierLinePoints(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.GetBezierLinePoints", GREASED_LINE_REASON);
    }

    public static GetArrowCap(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.GetArrowCap", GREASED_LINE_REASON);
    }

    public static GetPointsFromText(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.GetPointsFromText", GREASED_LINE_REASON);
    }

    public static Color3toRGBAUint8(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.Color3toRGBAUint8", GREASED_LINE_REASON);
    }

    public static CreateColorsTexture(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.CreateColorsTexture", GREASED_LINE_REASON);
    }

    public static PrepareEmptyColorsTexture(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.PrepareEmptyColorsTexture", GREASED_LINE_REASON);
    }

    public static DisposeEmptyColorsTexture(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.DisposeEmptyColorsTexture", GREASED_LINE_REASON);
    }

    public static BooleanToNumber(..._args: unknown[]): never {
        return unsupported("GreasedLineTools.BooleanToNumber", GREASED_LINE_REASON);
    }
}

export function CreateGreasedLine(..._args: unknown[]): never {
    return unsupported("CreateGreasedLine", GREASED_LINE_REASON);
}

export function CreateGreasedLineMaterial(..._args: unknown[]): never {
    return unsupported("CreateGreasedLineMaterial", GREASED_LINE_REASON);
}

export function GetPointsCount(..._args: unknown[]): never {
    return unsupported("GetPointsCount", GREASED_LINE_REASON);
}

export function CompleteGreasedLineWidthTable(..._args: unknown[]): never {
    return unsupported("CompleteGreasedLineWidthTable", GREASED_LINE_REASON);
}

export function CompleteGreasedLineColorTable(..._args: unknown[]): never {
    return unsupported("CompleteGreasedLineColorTable", GREASED_LINE_REASON);
}

// GreasedLine enums are pure numeric parity shape (no feature logic), mirrored
// from BJS so ported code that references the members resolves.
export enum GreasedLineMeshColorDistribution {
    COLOR_DISTRIBUTION_NONE = 0,
    COLOR_DISTRIBUTION_REPEAT = 1,
    COLOR_DISTRIBUTION_EVEN = 2,
    COLOR_DISTRIBUTION_START = 3,
    COLOR_DISTRIBUTION_END = 4,
    COLOR_DISTRIBUTION_START_END = 5,
}

export enum GreasedLineMeshWidthDistribution {
    WIDTH_DISTRIBUTION_NONE = 0,
    WIDTH_DISTRIBUTION_REPEAT = 1,
    WIDTH_DISTRIBUTION_EVEN = 2,
    WIDTH_DISTRIBUTION_START = 3,
    WIDTH_DISTRIBUTION_END = 4,
    WIDTH_DISTRIBUTION_START_END = 5,
}

export enum GreasedLineRibbonPointsMode {
    POINTS_MODE_POINTS = 0,
    POINTS_MODE_PATHS = 1,
}

export enum GreasedLineRibbonFacesMode {
    FACES_MODE_SINGLE_SIDED = 0,
    FACES_MODE_SINGLE_SIDED_NO_BACKFACE_CULLING = 1,
    FACES_MODE_DOUBLE_SIDED = 2,
}

export enum GreasedLineRibbonAutoDirectionMode {
    AUTO_DIRECTIONS_FROM_FIRST_SEGMENT = 0,
    AUTO_DIRECTIONS_FROM_ALL_SEGMENTS = 1,
    AUTO_DIRECTIONS_ENHANCED = 2,
    AUTO_DIRECTIONS_FACE_TO = 3,
    AUTO_DIRECTIONS_NONE = 99,
}

export class EdgesRenderer {
    public constructor() {
        unsupported("EdgesRenderer", "Edge rendering is not implemented in Babylon Lite.");
    }
}

export class OutlineRenderer {
    public constructor() {
        unsupported("OutlineRenderer", "Mesh outline rendering is not implemented in Babylon Lite.");
    }
}

// ─── Textures ────────────────────────────────────────────────────────
export class MirrorTexture {
    public constructor() {
        unsupported("MirrorTexture", "Mirror/reflection textures are not implemented in Babylon Lite. Build one from a native render-target texture + clip plane if required.");
    }
}

// ─── HTML texture interaction (DOM/CSS overlay interop) ──────────────
// `HtmlTexture` itself is Lite-backed in textures/textures.ts. These remaining
// APIs bind arbitrary textures to DOM overlay/raycast and polyfill lifecycles,
// which Lite's owned HTML-texture surface does not expose.

/** Options accepted by Babylon.js `HtmlInteractionManager` (shape-only stub). */
export interface IHtmlInteractionManagerOptions {
    [key: string]: unknown;
}

/** Options accepted by Babylon.js `HtmlRaycastInteractionManager` (shape-only stub). */
export interface IHtmlRaycastInteractionManagerOptions {
    [key: string]: unknown;
}

/** Module shape of an HTML-in-canvas polyfill (shape-only stub). */
export interface IHtmlInCanvasPolyfillModule {
    [key: string]: unknown;
}

/** Options accepted by `InstallHtmlInCanvasPolyfill` (shape-only stub). */
export interface IInstallHtmlInCanvasPolyfillOptions {
    [key: string]: unknown;
}

export class HtmlInteractionManager {
    public constructor() {
        unsupported("HtmlInteractionManager", "HTML overlay interaction is not part of Babylon Lite's WebGPU renderer.");
    }
}

export class HtmlRaycastInteractionManager {
    public constructor() {
        unsupported("HtmlRaycastInteractionManager", "HTML overlay raycast interaction is not part of Babylon Lite's WebGPU renderer.");
    }
}

/** Babylon.js `IsHtmlInCanvasUploadSupported` — kept in lockstep with the unavailable upload helper. */
export function IsHtmlInCanvasUploadSupported(engine: AbstractEngine): boolean {
    void engine;
    return unsupported(
        "IsHtmlInCanvasUploadSupported",
        "Lite's HTML texture owns its element and texture together; it cannot back BJS's arbitrary InternalTexture upload contract."
    );
}

/** Babylon.js `UploadHtmlElementToTexture` — HTML texture upload is unsupported by the compat layer. */
export function UploadHtmlElementToTexture(): never {
    return unsupported("UploadHtmlElementToTexture", "HTML-element texture upload is not supported by Babylon Lite.");
}

/** Babylon.js `ComputeOverlayCssTransform` — HTML overlay interaction is unsupported by the compat layer. */
export function ComputeOverlayCssTransform(): never {
    return unsupported("ComputeOverlayCssTransform", "HTML overlay interaction is not supported by Babylon Lite.");
}

/** Babylon.js `GetElementPixelFromUv` — HTML overlay raycast interaction is unsupported by the compat layer. */
export function GetElementPixelFromUv(): never {
    return unsupported("GetElementPixelFromUv", "HTML overlay raycast interaction is not supported by Babylon Lite.");
}

/** Babylon.js `IsHtmlInCanvasSupportedNatively` — the HTML-in-canvas feature is unsupported by the compat layer. */
export function IsHtmlInCanvasSupportedNatively(): never {
    return unsupported("IsHtmlInCanvasSupportedNatively", "The HTML-in-canvas feature is not supported by Babylon Lite.");
}

/** Babylon.js `InstallHtmlInCanvasPolyfill` — the HTML-in-canvas polyfill is unsupported by the compat layer. */
export function InstallHtmlInCanvasPolyfill(): never {
    return unsupported("InstallHtmlInCanvasPolyfill", "The HTML-in-canvas polyfill is not supported by Babylon Lite.");
}

/** Babylon.js `UninstallHtmlInCanvasPolyfill` — the HTML-in-canvas polyfill is unsupported by the compat layer. */
export function UninstallHtmlInCanvasPolyfill(): never {
    return unsupported("UninstallHtmlInCanvasPolyfill", "The HTML-in-canvas polyfill is not supported by Babylon Lite.");
}

// ─── Audio ───────────────────────────────────────────────────────────
export class Sound {
    public constructor() {
        unsupported("Sound", "Audio is not part of Babylon Lite. Use the Web Audio API directly.");
    }
}

// ─── Behaviors (mesh + camera) ───────────────────────────────────────
// Babylon Lite exposes a utility-layer pointer-drag dispatcher
// (`createPointerDrag` / `registerPointerDrag`) used by its gizmos, but it does
// not expose the main-scene mesh-dragging, XR/multi-pointer, follow, or
// geospatial camera behaviors these BJS classes provide, so each is a throwing
// stub. The camera behaviors that Lite *can* back (`AutoRotationBehavior`,
// `BouncingBehavior`, `FramingBehavior`) live in `behaviors/behaviors.ts`.
export class PointerDragBehavior {
    public constructor() {
        unsupported(
            "PointerDragBehavior",
            "Babylon Lite's pointer-drag (`createPointerDrag`) only drives utility-layer gizmo colliders, not arbitrary main-scene meshes, so mesh drag-behaviors cannot be wrapped."
        );
    }
}

export class BaseSixDofDragBehavior {
    public constructor() {
        unsupported("BaseSixDofDragBehavior", "Six-DoF mesh dragging is not implemented in Babylon Lite.");
    }
}

export class SixDofDragBehavior {
    public constructor() {
        unsupported("SixDofDragBehavior", "Six-DoF mesh dragging is not implemented in Babylon Lite.");
    }
}

export class MultiPointerScaleBehavior {
    public constructor() {
        unsupported("MultiPointerScaleBehavior", "Multi-pointer scaling is not implemented in Babylon Lite.");
    }
}

export class AttachToBoxBehavior {
    public constructor() {
        unsupported("AttachToBoxBehavior", "Bounding-box attachment (app-bar UI) is not implemented in Babylon Lite.");
    }
}

export class FadeInOutBehavior {
    public constructor() {
        unsupported("FadeInOutBehavior", "Mesh fade-in/out visibility tweening is not implemented in Babylon Lite.");
    }
}

export class SurfaceMagnetismBehavior {
    public constructor() {
        unsupported("SurfaceMagnetismBehavior", "Surface magnetism (mesh snapping) is not implemented in Babylon Lite.");
    }
}

export class FollowBehavior {
    public constructor() {
        unsupported("FollowBehavior", "Camera-follow behavior is not implemented in Babylon Lite.");
    }
}

export class HandConstraintBehavior {
    public constructor() {
        unsupported("HandConstraintBehavior", "WebXR hand-constraint behavior is out of scope for Babylon Lite.");
    }
}

export class InterpolatingBehavior {
    public constructor() {
        unsupported("InterpolatingBehavior", "The interpolating camera behavior is not implemented in Babylon Lite.");
    }
}

export class GeospatialClippingBehavior {
    public constructor() {
        unsupported("GeospatialClippingBehavior", "Geospatial camera clipping is not implemented in Babylon Lite.");
    }
}

// ─── Serialization ───────────────────────────────────────────────────
/** Babylon.js scene serializer. Babylon Lite uses different data structures and does not round-trip `.babylon`. */
export const SceneSerializer = {
    Serialize(): never {
        return unsupported("SceneSerializer.Serialize", "Babylon Lite does not implement `.babylon` scene serialization.");
    },
    SerializeMesh(): never {
        return unsupported("SceneSerializer.SerializeMesh", "Babylon Lite does not implement mesh serialization.");
    },
};
