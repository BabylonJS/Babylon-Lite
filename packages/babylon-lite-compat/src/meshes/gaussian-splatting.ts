/**
 * Babylon.js-compatible `GaussianSplattingMesh` over Babylon Lite's splat loaders.
 *
 * Babylon Lite fully backs Gaussian Splatting: `loadSplat` (`.ply` / `.splat` /
 * compressed-PLY), `loadSOG`, and `loadSPZ` each return a `GaussianSplattingMesh`
 * (a `SceneNode` carrying the splat cloud), with `splatsData` / `updateData` for
 * in-place edits and `bakeCurrentTransformIntoVertices` to fold the node transform
 * into the splat data. This wrapper exposes that through the Babylon.js
 * `GaussianSplattingMesh` shape so ported scenes (`new GaussianSplattingMesh(...)` +
 * `loadFileAsync`, or `ImportMeshAsync` of a splat URL) run unchanged.
 *
 * Babylon.js constructs the mesh synchronously and populates it via
 * `loadFileAsync`; Babylon Lite loads atomically. We bridge this by holding a
 * lightweight placeholder transform node until the splat loads, buffering any
 * transforms set in the meantime, then adopting the loaded Lite node.
 */

import {
    loadSplat,
    loadSOG,
    loadSPZ,
    bakeCurrentTransformIntoVertices,
    createTransformNode,
    setParent,
    _getGaussianPointSplattingPackedShBytesPerSplat,
    _hasGaussianPointSplattingProjectedDepth,
    disableGaussianPointSplatting,
    enableGaussianPointSplatting,
} from "babylon-lite";
import type { GaussianPointSplatting as LiteGaussianPointSplatting, GaussianSplattingMesh as LiteGsMesh, GsShaderFragment, Mat4, SceneNode } from "babylon-lite";

import { TransformNode } from "./meshes.js";
import type { Scene } from "../scene/scene.js";
import type { Vector3 } from "../math/vector.js";
import { liteBackedVector3 } from "../math/vector.js";
import type { Matrix } from "../math/matrix.js";

/**
 * Babylon.js `ISafeOrbitCameraLimits` — safe-orbit camera limits embedded in a Gaussian
 * Splatting file's metadata (Adobe safe-orbit extension). Exposed on the loaded mesh via
 * {@link GaussianSplattingMesh.safeOrbitCameraLimits} for shape parity with `@babylonjs/core`.
 */
export interface ISafeOrbitCameraLimits {
    /** Minimum safe orbit radius (distance from the camera to its target), if the file specifies one. */
    radiusMin?: number;
    /** Safe elevation range as `[minElevation, maxElevation]` in radians, if the file specifies one. */
    elevationMinMax?: [number, number];
}

export interface IGaussianPointSplattingProgress {
    renderedFrameCount: number;
    accumulationVersion: number;
    pixelCycleLength: number;
}

export function _HasGaussianPointSplattingProjectedDepth(projection: Matrix): boolean {
    return _hasGaussianPointSplattingProjectedDepth(projection.m as unknown as Mat4);
}

export function _GetPackedShBytesPerSplat(shDegree: number): number {
    return _getGaussianPointSplattingPackedShBytesPerSplat(shDegree);
}

/** Lite loader chosen by file extension (mirrors the BJS splat plugin dispatch). */
function liteLoaderFor(url: string): (scene: import("babylon-lite").SceneContext, url: string, fragments?: readonly GsShaderFragment[]) => Promise<LiteGsMesh> {
    const lower = url.split("?")[0]!.toLowerCase();
    if (lower.endsWith(".sog") || lower.endsWith(".zip")) {
        return loadSOG;
    }
    if (lower.endsWith(".spz")) {
        return loadSPZ;
    }
    // `.ply`, `.splat`, and compressed-PLY all flow through `loadSplat`.
    return loadSplat;
}

/** Translate Babylon.js's resolution multiplier into Lite's integer downsampling factor. */
function litePointSplattingRenderScale(value: number | "auto"): number | "auto" {
    if (value === "auto") {
        return value;
    }
    const divisor = 1 / value;
    if (!Number.isFinite(divisor) || !Number.isInteger(divisor) || divisor < 1 || divisor > 8) {
        throw new RangeError("GaussianSplattingMesh.pointSplattingRenderScale must be 'auto' or the reciprocal of an integer from 1 through 8.");
    }
    return divisor;
}

/** `.splat` row stride: position(3f) + scale(3f) + rgba(4×u8) + rot(4×u8) = 32 bytes. */
const SPLAT_ROW_BYTES = 32;
const SPLAT_ROW_FLOATS = SPLAT_ROW_BYTES / 4;
const SPLAT_Y_FLOAT_INDEX = 1;

/**
 * @internal Return a copy of a `.splat` buffer with every row's centre Y negated
 * (the position-space half of Babylon.js's `flipY`). Used to reproduce
 * `updateData(..., { flipY: false })`. Only the 32-byte `.splat` row layout is
 * handled; other buffers are returned unchanged.
 */
function mirrorSplatRowY(buffer: ArrayBuffer): ArrayBuffer {
    if (buffer.byteLength % SPLAT_ROW_BYTES !== 0) {
        return buffer;
    }
    const copy = buffer.slice(0);
    const floats = new Float32Array(copy);
    for (let f = SPLAT_Y_FLOAT_INDEX; f < floats.length; f += SPLAT_ROW_FLOATS) {
        floats[f] = -floats[f]!;
    }
    return copy;
}

/**
 * Babylon.js `GaussianSplattingMesh`. Derives from `TransformNode` so the loaded
 * cloud's `position` / `rotation` / `scaling` proxy onto the Lite splat node.
 */
export class GaussianSplattingMesh extends TransformNode {
    private static _useGpuSort = false;
    public static GpuSortMinFrameInterval = 1;

    public static get UseGpuSort(): boolean {
        return this._useGpuSort;
    }

    public static set UseGpuSort(value: boolean) {
        this._useGpuSort = value;
    }

    /** @internal The loaded Lite splat node (undefined until `loadFileAsync` resolves). */
    private _gs?: LiteGsMesh;
    /** @internal The constructor's deferred URL, loaded by `loadFileAsync()` with no argument. */
    private readonly _ctorUrl: string | null;
    /** @internal Optional Lite shader-fragment plugins applied at load (scene 126). */
    private _fragments?: readonly GsShaderFragment[];
    /** @internal Point-splatting configuration retained before the native renderer is enabled. */
    private _pointSplattingRenderScale: number | "auto" = "auto";
    /** @internal Point-splatting configuration retained before the native renderer is enabled. */
    private _pointSplattingOcclusionCulling = false;
    /** @internal Point-splatting configuration retained before the native renderer is enabled. */
    private _pointSplattingScale = 1;
    /** @internal Native point renderer enabled for this loaded splat, if any. */
    private _pointSplatting: LiteGaussianPointSplatting | null = null;
    /** @internal Requested BJS color-pass ownership, retained before the splat loads. */
    private _pointSplattingRenderMode = false;
    /** @internal Requested BJS depth-pass ownership, retained before the splat loads. */
    private _pointSplattingDepthRenderMode = false;
    private _useGpuSort: boolean | null = null;

    public get useGpuSort(): boolean | null {
        return this._useGpuSort;
    }

    public set useGpuSort(value: boolean | null) {
        this._useGpuSort = value;
    }

    /**
     * Babylon.js `gs.safeOrbitCameraLimits` — safe-orbit camera limits parsed from the source
     * file's metadata (Adobe safe-orbit extension), or `null` when the file carries none.
     *
     * Babylon Lite's splat loaders (`loadSplat` / `loadSOG` / `loadSPZ`) do not parse the Adobe
     * safe-orbit metadata block, so this stays `null` — matching BJS's own default for a file
     * without the extension. Populating it from real metadata needs a (non-tree-shakeable) change
     * to Lite's splat loaders; the field is exposed here for shape parity so ported reads resolve.
     */
    public safeOrbitCameraLimits: ISafeOrbitCameraLimits | null = null;

    public get pointSplattingRenderScale(): number | "auto" {
        return this._pointSplattingRenderScale;
    }

    public set pointSplattingRenderScale(value: number | "auto") {
        const liteValue = litePointSplattingRenderScale(value);
        this._pointSplattingRenderScale = value;
        if (this._pointSplatting) {
            this._pointSplatting.renderScale = liteValue;
        }
    }

    public get pointSplattingOcclusionCulling(): boolean {
        return this._pointSplattingOcclusionCulling;
    }

    public set pointSplattingOcclusionCulling(value: boolean) {
        this._pointSplattingOcclusionCulling = value;
        if (this._pointSplatting) {
            this._pointSplatting.occlusionCulling = value;
        }
    }

    public get pointSplattingRenderMode(): boolean {
        return this._pointSplattingRenderMode;
    }

    public set pointSplattingRenderMode(value: boolean) {
        if (value === this._pointSplattingRenderMode) {
            return;
        }
        this._pointSplattingRenderMode = value;
        this._syncPointSplatting();
    }

    public get pointSplattingDepthRenderMode(): boolean {
        return this._pointSplattingDepthRenderMode;
    }

    public set pointSplattingDepthRenderMode(value: boolean) {
        if (value === this._pointSplattingDepthRenderMode) {
            return;
        }
        this._pointSplattingDepthRenderMode = value;
        this._syncPointSplatting();
    }

    public get pointSplattingProgress(): IGaussianPointSplattingProgress | null {
        const progress = this._pointSplatting?.progress;
        return progress
            ? {
                  renderedFrameCount: progress.renderedFrameCount,
                  accumulationVersion: progress.accumulationVersion,
                  pixelCycleLength: progress.pixelCycleLength,
              }
            : null;
    }

    public get pointSplattingScale(): number {
        return this._pointSplattingScale;
    }

    public set pointSplattingScale(value: number) {
        this._pointSplattingScale = value;
        if (this._pointSplatting) {
            this._pointSplatting.pointScale = value;
        }
    }

    public constructor(name: string, url?: string | null, scene?: Scene, _keepInRam?: boolean) {
        // A placeholder transform node carries any transforms set before the splat
        // loads; it is never added to the scene (Lite `loadSplat` registers the real
        // splat node). Transforms are copied onto the loaded node in `loadFileAsync`.
        super(name, scene, createTransformNode(name));
        this._ctorUrl = url ?? null;
    }

    public override getClassName(): string {
        return "GaussianSplattingMesh";
    }

    /** @internal The wrapper's transform node; the loaded cloud is parented beneath it during deferred adoption. */
    private get _xform(): SceneNode {
        return this._gs?.parent === this._node ? this._node : (this._gs ?? this._node);
    }

    /** @internal Accessibility metadata belongs to the loaded cloud, or its placeholder before loading. */
    protected override _accessibilitySource(): object {
        return this._gs ?? this._node;
    }

    public override get position(): Vector3 {
        return liteBackedVector3(this._xform.position);
    }
    public override set position(value: Vector3) {
        this._xform.position.set(value.x, value.y, value.z);
    }

    public override get rotation(): Vector3 {
        return liteBackedVector3(this._xform.rotation);
    }
    public override set rotation(value: Vector3) {
        this._xform.rotation.set(value.x, value.y, value.z);
    }

    public override get scaling(): Vector3 {
        return liteBackedVector3(this._xform.scaling);
    }
    public override set scaling(value: Vector3) {
        this._xform.scaling.set(value.x, value.y, value.z);
    }

    /** @internal Set the Lite shader-fragment plugins applied on the next load (compat material-plugin path). */
    public _setFragments(fragments: readonly GsShaderFragment[]): void {
        this._fragments = fragments;
    }

    /**
     * Babylon.js `gs.loadFileAsync(url?)` — fetch + parse a splat asset and adopt
     * the resulting Lite node. With no argument, loads the constructor URL.
     */
    public async loadFileAsync(url?: string): Promise<GaussianSplattingMesh> {
        const target = url ?? this._ctorUrl;
        if (!target) {
            throw new Error("GaussianSplattingMesh.loadFileAsync: no URL provided (and none given to the constructor).");
        }
        const scene = this._scene;
        if (!scene) {
            throw new Error("GaussianSplattingMesh.loadFileAsync requires a scene (pass one to the constructor).");
        }
        const lite = await liteLoaderFor(target)(scene._lite, target, this._fragments);
        this._adopt(lite);
        return this;
    }

    /**
     * @internal Adopt a loaded Lite splat node from either the mesh or loader-plugin API.
     * Parenting preserves the loader's format-specific local transform while composing it
     * with transforms applied to the wrapper before loading.
     */
    public _adopt(lite: LiteGsMesh): void {
        const placeholder = this._node;
        const previousAccessibilitySource = this._accessibilitySource();
        this._disablePointSplatting();
        lite.parent = placeholder;
        placeholder.children.push(lite);
        lite.name = this.name;
        this._gs = lite;
        this._syncPointSplatting();
        this._syncAccessibilityTag(previousAccessibilitySource);
        this._scene?._registerMesh(this);
    }

    /** @internal Wrap an already-loaded Lite splat node (used by the loader's `ImportMeshAsync` path). */
    public static _fromLite(lite: LiteGsMesh, scene: Scene): GaussianSplattingMesh {
        const mesh = new GaussianSplattingMesh(lite.name, null, scene);
        mesh._gs = lite;
        mesh._syncPointSplatting();
        scene._registerMesh(mesh);
        return mesh;
    }

    /** @internal Reconcile BJS point-mode state with Lite's opt-in renderer. */
    private _syncPointSplatting(): void {
        if (!this._gs || !this._scene) {
            return;
        }
        if (!this._pointSplattingRenderMode && !this._pointSplattingDepthRenderMode) {
            this._disablePointSplatting();
            return;
        }
        this._pointSplatting = enableGaussianPointSplatting(this._scene._lite, this._gs, {
            colorRenderMode: this._pointSplattingRenderMode,
            depthRenderMode: this._pointSplattingDepthRenderMode,
            pointScale: this._pointSplattingScale,
            renderScale: litePointSplattingRenderScale(this._pointSplattingRenderScale),
            occlusionCulling: this._pointSplattingOcclusionCulling,
        });
    }

    /** @internal Release the point renderer owned by the currently adopted splat. */
    private _disablePointSplatting(): void {
        if (this._pointSplatting && this._scene) {
            disableGaussianPointSplatting(this._scene._lite, this._pointSplatting);
            this._pointSplatting = null;
        }
    }

    /** Babylon.js `gs.splatsData` — the raw 32-byte/splat row buffer (for inspection / `updateData`). */
    public get splatsData(): ArrayBuffer | null {
        return this._gs ? this._gs.splatsData : null;
    }

    /**
     * Babylon.js `gs.updateData(buffer, sh?, options?)` — replace the splat data in
     * place. Babylon Lite always applies its loader's Y convention on update; the
     * `sh` argument is accepted for signature parity and ignored.
     *
     * `options.flipY === false` is honoured: Babylon.js's `.splat` loader flips Y
     * on load by default, so `flipY:false` re-uploads the buffer **without** that
     * flip — i.e. mirrored relative to the default-loaded pose, which ported scenes
     * then correct with `scaling.y = -1`. Lite has no per-call flip flag and always
     * applies its (flip-on-load-equivalent) convention, so we mirror the row Y here
     * to reproduce the `flipY:false` pose before handing the buffer to Lite.
     */
    public updateData(splatBuffer: ArrayBuffer, _sh?: unknown, options?: { flipY?: boolean }): void {
        const buffer = options?.flipY === false ? mirrorSplatRowY(splatBuffer) : splatBuffer;
        this._gs?.updateData(buffer);
    }

    /** Babylon.js `gs.bakeCurrentTransformIntoVertices()` — fold the node transform into the splat data. */
    public bakeCurrentTransformIntoVertices(): void {
        if (this._gs) {
            bakeCurrentTransformIntoVertices(this._gs);
            if (this._gs.parent === this._node) {
                const userChildren = this._node.children.filter((child) => child !== this._gs && child.parent === this._node);
                for (const child of this.getChildren(undefined, true)) {
                    if (child instanceof TransformNode && child._node !== this._gs && !userChildren.includes(child._node)) {
                        userChildren.push(child._node);
                    }
                }
                for (const child of userChildren) {
                    setParent(child, null);
                }
                this._node.position.set(0, 0, 0);
                this._node.rotation.set(0, 0, 0);
                this._node.scaling.set(1, 1, 1);
                for (const child of userChildren) {
                    setParent(child, this._node);
                }
            }
        }
    }

    /** @internal Babylon.js's worker-throttle flag; ported scenes poll it to detect the first sort. */
    public get _canPostToWorker(): boolean {
        return this._gs ? this._gs._orderPool.length === 2 : false;
    }

    /** @internal The loaded Lite splat node, for the GPU picker's result mapping (undefined until loaded). */
    public get _pickLiteNode(): LiteGsMesh | undefined {
        return this._gs;
    }

    /** @internal Release the opt-in point renderer before removing the splat node. */
    protected override _disposeSelf(doNotRecurse: boolean): void {
        this._disablePointSplatting();
        super._disposeSelf(doNotRecurse);
    }
}
