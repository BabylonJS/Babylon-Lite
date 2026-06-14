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

import { loadSplat, loadSOG, loadSPZ, bakeCurrentTransformIntoVertices, createTransformNode } from "babylon-lite";
import type { GaussianSplattingMesh as LiteGsMesh, GsShaderFragment, SceneNode } from "babylon-lite";

import { TransformNode } from "./meshes.js";
import type { Scene } from "../scene/scene.js";
import type { Vector3 } from "../math/vector.js";
import { liteBackedVector3 } from "../math/vector.js";

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
    /** @internal The loaded Lite splat node (undefined until `loadFileAsync` resolves). */
    private _gs?: LiteGsMesh;
    /** @internal The constructor's deferred URL, loaded by `loadFileAsync()` with no argument. */
    private readonly _ctorUrl: string | null;
    /** @internal Optional Lite shader-fragment plugins applied at load (scene 126). */
    private _fragments?: readonly GsShaderFragment[];

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

    /** @internal The transform-carrying Lite node: the loaded splat node once present, else the placeholder. */
    private get _xform(): SceneNode {
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

    /** @internal Adopt a loaded Lite splat node: carry over placeholder transforms + name, and register on the scene. */
    private _adopt(lite: LiteGsMesh): void {
        const placeholder = this._node;
        lite.position.set(placeholder.position.x, placeholder.position.y, placeholder.position.z);
        lite.scaling.set(placeholder.scaling.x, placeholder.scaling.y, placeholder.scaling.z);
        lite.rotation.set(placeholder.rotation.x, placeholder.rotation.y, placeholder.rotation.z);
        lite.name = this.name;
        this._gs = lite;
        this._scene?._registerMesh(this);
    }

    /** @internal Wrap an already-loaded Lite splat node (used by the loader's `ImportMeshAsync` path). */
    public static _fromLite(lite: LiteGsMesh, scene: Scene): GaussianSplattingMesh {
        const mesh = new GaussianSplattingMesh(lite.name, null, scene);
        mesh._gs = lite;
        scene._registerMesh(mesh);
        return mesh;
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
        }
    }

    /** @internal Babylon.js's worker-throttle flag; ported scenes poll it to detect the first sort. */
    public get _canPostToWorker(): boolean {
        return this._gs ? this._gs._canPostToWorker : false;
    }

    /** @internal The loaded Lite splat node, for the GPU picker's result mapping (undefined until loaded). */
    public get _pickLiteNode(): LiteGsMesh | undefined {
        return this._gs;
    }
}
