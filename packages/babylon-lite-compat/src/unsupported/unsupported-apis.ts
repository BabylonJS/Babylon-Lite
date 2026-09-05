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
import { PushMaterial } from "../materials/materials.js";
import type { Material } from "../materials/materials.js";
import type { Scene } from "../scene/scene.js";

// ─── Materials ───────────────────────────────────────────────────────
export class MultiMaterial {
    public constructor() {
        unsupported("MultiMaterial", "Babylon Lite uses one material per renderable. Split the mesh geometry by material into separate meshes instead.");
    }
}

export class ShaderMaterial {
    public constructor() {
        unsupported("ShaderMaterial", "Babylon Lite is WGSL-only. Use the native `createShaderMaterial` (WGSL) API; there is no automatic GLSL translation.");
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

// ─── HTML textures (DOM/CSS overlay interop) ─────────────────────────
// New in BJS: `Materials/Textures/HTML/*` — uploads a live DOM element into a
// texture and forwards pointer/raycast interaction onto an overlaid HTML layer.
// This is a DOM-driven, host-page feature with no Babylon Lite equivalent (Lite
// is a WebGPU renderer with no HTML overlay / interaction subsystem),
// so every entry throws.

/** Options accepted by Babylon.js `HtmlTexture` (shape-only stub for type parity). */
export interface IHtmlTextureOptions {
    [key: string]: unknown;
}

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

export class HtmlTexture {
    public constructor() {
        unsupported("HtmlTexture", "Rendering a live DOM element into a texture is a host-page/DOM feature with no Babylon Lite equivalent.");
    }
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

/** Babylon.js `IsHtmlInCanvasUploadSupported` — HTML texture upload is unsupported by the compat layer. */
export function IsHtmlInCanvasUploadSupported(): never {
    return unsupported("IsHtmlInCanvasUploadSupported", "HTML-element texture upload is not supported by Babylon Lite.");
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

// ─── Gaussian Splatting LOD streaming ────────────────────────────────
// BJS `@babylonjs/loaders` SPLAT exposes a Gaussian-Splatting LOD *streaming*
// subsystem (`GaussianSplattingStream` + `AddGaussianSplattingStreamPart[Async]`,
// with `IGaussianSplattingStreamingPart` / `IGaussianSplattingStreamOptions` /
// `ISOGLODMetadata` describing a compound mesh assembled from streamed parts).
// It layers SOG-octree LOD residency management (download/residency controllers,
// a block allocator) on top of a GPU work-buffer decode pipeline that decodes
// SH / rotation / scale into shared render-target atlases via dedicated
// GLSL+WGSL shaders. Babylon Lite loads a *whole* splat cloud eagerly
// (`loadSplat` / `loadSOG` / `loadSPZ`, wrapped by the compat `GaussianSplattingMesh`)
// and has no streaming/LOD residency subsystem or work-buffer decode pipeline to
// back it. Adding one is a whole GPU subsystem with open design questions
// (residency policy, LOD scheduling, atlas layout) — not a small, mechanical,
// objective Lite addition — so these throw (structural blocker; move 3).

/** Babylon.js `GaussianSplattingStreamDebugLodSource` — LOD debug source selector (shape-only stub for type parity). */
export type GaussianSplattingStreamDebugLodSource = "optimal" | "current";

/** Babylon.js `IGaussianSplattingStreamOptions` — GS LOD stream options (shape-only stub for type parity). */
export interface IGaussianSplattingStreamOptions {
    [key: string]: unknown;
}

/** Babylon.js `ISOGLODMetadata` — SOG LOD octree metadata (shape-only stub for type parity). */
export interface ISOGLODMetadata {
    [key: string]: unknown;
}

/** Babylon.js `IGaussianSplattingStreamingPart` — a streamed part of a GS compound mesh (shape-only stub for type parity). */
export interface IGaussianSplattingStreamingPart {
    [key: string]: unknown;
}

export class GaussianSplattingStream {
    public constructor(..._args: unknown[]) {
        unsupported(
            "GaussianSplattingStream",
            "Gaussian-Splatting LOD streaming is a whole GPU subsystem (SOG-octree LOD residency + work-buffer decode into render-target atlases) with no Babylon Lite equivalent. Load the full cloud with `GaussianSplattingMesh` / `loadSplat` instead."
        );
    }
}

/** Babylon.js `AddGaussianSplattingStreamPart` — appends a streamed LOD part to a GS compound mesh. */
export function AddGaussianSplattingStreamPart(..._args: unknown[]): never {
    return unsupported(
        "AddGaussianSplattingStreamPart",
        "Gaussian-Splatting LOD streaming (compound mesh + streamed parts) is not backed by Babylon Lite, which loads a whole splat cloud eagerly via `GaussianSplattingMesh`."
    );
}

/** Babylon.js `AddGaussianSplattingStreamPartAsync` — async variant of {@link AddGaussianSplattingStreamPart}. */
export function AddGaussianSplattingStreamPartAsync(..._args: unknown[]): never {
    return unsupported(
        "AddGaussianSplattingStreamPartAsync",
        "Gaussian-Splatting LOD streaming (compound mesh + streamed parts) is not backed by Babylon Lite, which loads a whole splat cloud eagerly via `GaussianSplattingMesh`."
    );
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
