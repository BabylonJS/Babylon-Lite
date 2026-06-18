/**
 * Babylon.js-compatible texture wrappers over Babylon Lite's `loadTexture2D`.
 *
 * Babylon.js's `Texture` constructor is synchronous and loads in the background.
 * Babylon Lite loads textures asynchronously. The compat `Texture` kicks off the
 * load in its constructor and resolves `_lite` when ready; assign the texture to
 * a material after `await texture.whenReadyAsync()` (or construct via
 * `Texture.LoadAsync`) so the GPU handle is present when the material binds.
 */

import { loadTexture2D, loadBasisTexture2D, loadKtxTexture2D, createTexture2DFromPixels, updateTexture2DFromPixels } from "babylon-lite";
import type { Texture2D, Texture2DOptions, EngineContext } from "babylon-lite";

import { unsupported } from "../error.js";
import { Observable } from "../misc/observable.js";
import type { Scene } from "../scene/scene.js";

/** Compression suffix → `loadKtxTexture2D` token, recognised in a pre-resolved KTX URL. */
const KTX_SUFFIX_RE = /(-astc|-dxt|-etc2|-pvrtc)\.ktx(\?.*)?$/i;

/**
 * @internal Recognise a pre-resolved compressed KTX URL and split it into the
 * `{ baseUrl, suffix }` pair Babylon Lite's `loadKtxTexture2D` expects (which
 * takes a base image URL plus a format suffix and reconstructs the KTX URL
 * itself), or `null` when the URL is not a compressed KTX.
 *
 * Babylon.js code selects the format via `engine.getCaps()` and hands `Texture`
 * a single fully-qualified `.ktx` URL (e.g. `…/grid-dxt.ktx`), so the base is the
 * `.png` fallback (`…/grid.png`) and the suffix is `-dxt.ktx`. Any query string
 * (auth / cache-busting / signed-URL params) is preserved on the base URL so it
 * survives onto both the KTX fetch and the `.png` fallback.
 */
export function resolveKtxUrl(url: string): { baseUrl: string; suffix: string } | null {
    const ktx = url.match(KTX_SUFFIX_RE);
    if (!ktx) {
        return null;
    }
    return { baseUrl: url.replace(KTX_SUFFIX_RE, ".png$2"), suffix: ktx[1]! + ".ktx" };
}

/**
 * Pick the right Babylon Lite loader for a texture URL:
 *  - `.basis` → `loadBasisTexture2D` (GPU-format transcode; manages its own V-flip).
 *  - a pre-resolved compressed KTX (`…-dxt.ktx` etc.) → `loadKtxTexture2D` (see
 *    {@link resolveKtxUrl}), which re-checks device support and falls back to the
 *    base image.
 *  - everything else → the raster `loadTexture2D`.
 *
 * The basis/KTX loaders manage their own V-orientation, so the raster-only
 * `invertY` / `mipMaps` options are ignored there — passing the same opts is safe.
 */
function loadCompatTexture(engine: EngineContext, url: string, opts: Texture2DOptions): Promise<Texture2D> {
    const path = url.split(/[?#]/)[0]!.toLowerCase();
    if (path.endsWith(".basis")) {
        return loadBasisTexture2D(engine, url, opts);
    }
    const ktx = resolveKtxUrl(url);
    if (ktx) {
        return loadKtxTexture2D(engine, ktx.baseUrl, [ktx.suffix], opts);
    }
    return loadTexture2D(engine, url, opts);
}

export abstract class BaseTexture {
    public name = "";
    /** @internal The underlying Lite texture handle. Undefined until the async load resolves. */
    public _lite: Texture2D | undefined;

    public getClassName(): string {
        return "BaseTexture";
    }

    public abstract whenReadyAsync(): Promise<void>;

    public dispose(): void {
        // Lite texture lifetimes are managed by the GPU resource pool; explicit
        // disposal is a no-op in the compat layer.
    }
}

export class Texture extends BaseTexture {
    private readonly _ready: Promise<void>;
    /** Babylon.js sampling-mode constants (numeric parity). */
    public static readonly NEAREST_SAMPLINGMODE = 1;
    public static readonly BILINEAR_SAMPLINGMODE = 2;
    public static readonly TRILINEAR_SAMPLINGMODE = 3;
    public static readonly NEAREST_NEAREST = 8;
    public static readonly LINEAR_LINEAR = 11;
    /** Babylon.js coordinate-mode constants (numeric parity). */
    public static readonly CLAMP_ADDRESSMODE = 0;
    public static readonly WRAP_ADDRESSMODE = 1;
    public static readonly MIRROR_ADDRESSMODE = 2;
    /** Babylon.js texture UV tiling (applied to the Lite material at bind time). */
    public uScale = 1;
    public vScale = 1;
    public uOffset = 0;
    public vOffset = 0;
    public hasAlpha = false;
    public coordinatesIndex = 0;
    /** Babylon.js sampling mode passed at construction (`NEAREST_SAMPLINGMODE` = 1, etc.). */
    public readonly samplingMode: number;
    /** @internal The Scene or engine this texture was created against (for `clone`). */
    private readonly _source: Scene | { _lite: import("babylon-lite").EngineContext };

    public constructor(
        url: string,
        sceneOrEngine: Scene | { _lite: import("babylon-lite").EngineContext },
        noMipmapOrOptions?: unknown,
        invertY?: boolean,
        _samplingMode?: number,
        onLoad?: (() => void) | null
    ) {
        super();
        this.name = url;
        // Babylon.js `Texture(url, scene, noMipmapOrOptions?, invertY?, samplingMode?)`.
        // The third argument is either a `noMipmap` boolean or an options object; parse
        // both shapes so the load matches what the ported code asked for.
        let noMipmap = false;
        let invertYOpt = invertY;
        let samplingMode = _samplingMode;
        if (typeof noMipmapOrOptions === "boolean") {
            noMipmap = noMipmapOrOptions;
        } else if (noMipmapOrOptions && typeof noMipmapOrOptions === "object") {
            const o = noMipmapOrOptions as { noMipmap?: boolean; invertY?: boolean; samplingMode?: number };
            noMipmap = o.noMipmap ?? false;
            invertYOpt = invertYOpt ?? o.invertY;
            samplingMode = samplingMode ?? o.samplingMode;
        }
        // Babylon.js `Texture.invertY` defaults to true; honour an explicit `false`.
        this._invertY = invertYOpt ?? true;
        this._noMipmap = noMipmap;
        this.samplingMode = samplingMode ?? Texture.BILINEAR_SAMPLINGMODE;
        this._source = sceneOrEngine;
        // Babylon.js's `Texture` accepts either a `Scene` or a `ThinEngine`. When a
        // scene is passed, the load is tracked so the scene awaits it at build; when
        // a bare engine is passed (e.g. the scene-less `SpriteRenderer` path), there
        // is no scene to track against, so the caller awaits readiness itself.
        const scene = (sceneOrEngine as Scene).getEngine ? (sceneOrEngine as Scene) : undefined;
        const engineWrapper = scene ? undefined : (sceneOrEngine as { _lite: import("babylon-lite").EngineContext; _registerStartupWork?: (w: () => Promise<void>) => void });
        const engine = scene ? scene.getEngine()._lite : engineWrapper!._lite;
        // Honour `invertY` / `noMipmap` only on the material (scene-based) path. The
        // bare-engine path feeds Babylon Lite's sprite renderer, which applies its own
        // V-orientation, so it keeps `loadTexture2D`'s defaults (matching the Lite ports).
        // Map the Babylon.js sampling mode to Lite's min/mag filters: `NEAREST_SAMPLINGMODE`
        // must load with nearest filtering, else the alpha of an alpha-tested (cutout)
        // texture is bilinear-filtered and the discard boundary shifts — invisible on
        // axis-aligned sprites but a large divergence on rotated cutout billboards.
        const nearest = this.samplingMode === Texture.NEAREST_SAMPLINGMODE || this.samplingMode === Texture.NEAREST_NEAREST;
        const filterOpts: { minFilter?: "nearest" | "linear"; magFilter?: "nearest" | "linear" } = nearest ? { minFilter: "nearest", magFilter: "nearest" } : {};
        const loadOpts = scene ? { invertY: this._invertY, mipMaps: !this._noMipmap, ...filterOpts } : {};

        this._ready = loadCompatTexture(engine, url, loadOpts).then((tex) => {
            this._lite = tex;
            if (onLoad) {
                onLoad();
            }
        });
        // Let the scene await this load before it builds renderables, so the GPU
        // handle exists when the owning material binds (Babylon.js loads in the
        // background but its render loop simply waits a frame; we wait at build).
        scene?._trackTextureLoad(this._ready);
        // Scene-less path (bare engine): register the load as engine startup work
        // so `texture.isReady()` is true by the time the render loop first runs.
        engineWrapper?._registerStartupWork?.(() => this._ready);
    }

    /** @internal Upload-time vertical flip / mipmap flags, preserved across `clone`. */
    private readonly _invertY: boolean;
    private readonly _noMipmap: boolean;

    public override getClassName(): string {
        return "Texture";
    }

    /**
     * Babylon.js `texture.clone()` — a new `Texture` over the same source URL.
     * UV tiling/offset and sampling are copied; the clone re-resolves the GPU
     * handle (tracked against the same scene so it is ready at build).
     */
    public clone(): Texture {
        const c = new Texture(this.name, this._source, this._noMipmap, this._invertY, this.samplingMode);
        c.uScale = this.uScale;
        c.vScale = this.vScale;
        c.uOffset = this.uOffset;
        c.vOffset = this.vOffset;
        c.hasAlpha = this.hasAlpha;
        c.coordinatesIndex = this.coordinatesIndex;
        return c;
    }

    public override whenReadyAsync(): Promise<void> {
        return this._ready;
    }

    /** Babylon.js `BaseTexture.isReady()` — true once the GPU handle has resolved. */
    public isReady(): boolean {
        return this._lite !== undefined;
    }

    /** Load a texture and resolve once its GPU handle is available. */
    public static async LoadAsync(url: string, scene: Scene): Promise<Texture> {
        const texture = new Texture(url, scene);
        await texture.whenReadyAsync();
        return texture;
    }
}

/**
 * Babylon.js `RawTexture` — a texture created from raw pixel bytes. Backed by
 * Babylon Lite's `createTexture2DFromPixels`; the GPU handle is available
 * synchronously after construction.
 */
export class RawTexture extends BaseTexture {
    private readonly _scene: Scene;

    public constructor(data: Uint8Array, width: number, height: number, scene: Scene) {
        super();
        this._scene = scene;
        this._lite = createTexture2DFromPixels(scene.getEngine()._lite, data, width, height);
    }

    public override getClassName(): string {
        return "RawTexture";
    }

    /** Replace the texture's pixel contents. */
    public update(data: Uint8Array): void {
        if (this._lite) {
            updateTexture2DFromPixels(this._scene.getEngine()._lite, this._lite, data);
        }
    }

    public override whenReadyAsync(): Promise<void> {
        return Promise.resolve();
    }

    public static CreateRGBATexture(data: Uint8Array, width: number, height: number, scene: Scene): RawTexture {
        return new RawTexture(data, width, height, scene);
    }
}

/**
 * Babylon.js `DynamicTexture` — a canvas-backed texture. Draw into
 * `getContext()`, then call `update()` to upload the canvas pixels to the GPU.
 * Backed by Babylon Lite's pixel-texture path.
 */
export class DynamicTexture extends BaseTexture {
    private readonly _scene: Scene;
    private readonly _canvas: HTMLCanvasElement;
    private readonly _context: CanvasRenderingContext2D;
    private readonly _width: number;
    private readonly _height: number;

    public constructor(name: string, options: { width: number; height: number }, scene: Scene) {
        super();
        this.name = name;
        this._scene = scene;
        this._width = options.width;
        this._height = options.height;
        this._canvas = document.createElement("canvas");
        this._canvas.width = options.width;
        this._canvas.height = options.height;
        const ctx = this._canvas.getContext("2d");
        if (!ctx) {
            throw new Error("DynamicTexture: 2D canvas context unavailable.");
        }
        this._context = ctx;
    }

    public override getClassName(): string {
        return "DynamicTexture";
    }

    public getContext(): CanvasRenderingContext2D {
        return this._context;
    }

    public getSize(): { width: number; height: number } {
        return { width: this._width, height: this._height };
    }

    /** Draw `text` and refresh the GPU texture. */
    public drawText(text: string, x: number, y: number, font: string, color: string, clearColor: string | null): void {
        const ctx = this._context;
        if (clearColor) {
            ctx.fillStyle = clearColor;
            ctx.fillRect(0, 0, this._width, this._height);
        }
        ctx.font = font;
        ctx.fillStyle = color;
        ctx.fillText(text, x, y);
        this.update();
    }

    /** Upload the current canvas pixels to the GPU. */
    public update(): void {
        const image = this._context.getImageData(0, 0, this._width, this._height);
        const data = new Uint8Array(image.data.buffer);
        if (!this._lite) {
            this._lite = createTexture2DFromPixels(this._scene.getEngine()._lite, data, this._width, this._height);
        } else {
            updateTexture2DFromPixels(this._scene.getEngine()._lite, this._lite, data);
        }
    }

    public override whenReadyAsync(): Promise<void> {
        return Promise.resolve();
    }
}

/**
 * Babylon.js `CubeTexture` — environment/skybox cube map. Babylon Lite loads
 * environments through `loadEnvironment` (IBL + skybox registered on the scene)
 * rather than as a standalone GPU texture object. This compat `CubeTexture`
 * therefore acts as a lightweight handle that records the environment URL; the
 * actual GPU work happens when it is assigned to `scene.environmentTexture` and
 * the engine starts (see `Scene` env handling).
 */
export class CubeTexture {
    /** Source URL of the (prefiltered) environment. */
    public readonly url: string;
    /** Babylon.js `coordinatesMode` (skybox = 5). Recorded for API parity. */
    public coordinatesMode = 0;
    public name: string;
    public gammaSpace = true;
    public level = 1;
    /** Fires when the cube map is "ready" (resolved on a microtask in this compat layer). */
    public readonly onLoadObservable = new Observable<CubeTexture>();
    private _ready = false;

    public constructor(
        url: string,
        _scene?: unknown,
        _extensions?: unknown,
        _noMipmap?: boolean,
        _files?: unknown,
        onLoad?: (() => void) | null,
        _onError?: unknown,
        _format?: unknown,
        _prefiltered?: boolean
    ) {
        this.url = url;
        this.name = url;
        // Babylon.js fires onLoad once the cube map is ready; some scenes await it
        // before continuing. We resolve on a microtask since the actual GPU upload
        // is deferred to `loadEnvironment` at engine start.
        setTimeout(() => {
            this._ready = true;
            if (onLoad) {
                onLoad();
            }
            this.onLoadObservable.notifyObservers(this);
        }, 0);
    }

    /** Babylon.js `BaseTexture.isReady()`. */
    public isReady(): boolean {
        return this._ready;
    }

    /** Babylon.js `CubeTexture.CreateFromPrefilteredData(url, scene)`. */
    public static CreateFromPrefilteredData(url: string, scene?: unknown): CubeTexture {
        return new CubeTexture(url, scene);
    }

    public dispose(): void {
        // GPU resources are owned by the scene's environment, disposed with the scene.
    }
}

/** Babylon.js `HDRCubeTexture` — see {@link CubeTexture}; use native `loadHdrEnvironment`. */
export class HDRCubeTexture {
    public constructor() {
        unsupported("HDRCubeTexture", "Use the native `loadHdrEnvironment` API; a standalone HDR cube texture object is not wrapped.");
    }
}

/** Babylon.js `RenderTargetTexture` — offscreen render target. Use the native frame-graph RTT APIs. */
export class RenderTargetTexture {
    public constructor() {
        unsupported("RenderTargetTexture", "Offscreen rendering uses Babylon Lite's frame-graph render-target APIs (`createRenderTargetTexture` / render tasks).");
    }
}
