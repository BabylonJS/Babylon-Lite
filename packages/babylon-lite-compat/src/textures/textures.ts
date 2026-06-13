/**
 * Babylon.js-compatible texture wrappers over Babylon Lite's `loadTexture2D`.
 *
 * Babylon.js's `Texture` constructor is synchronous and loads in the background.
 * Babylon Lite loads textures asynchronously. The compat `Texture` kicks off the
 * load in its constructor and resolves `_lite` when ready; assign the texture to
 * a material after `await texture.whenReadyAsync()` (or construct via
 * `Texture.LoadAsync`) so the GPU handle is present when the material binds.
 */

import { loadTexture2D, createTexture2DFromPixels, updateTexture2DFromPixels } from "babylon-lite";
import type { Texture2D } from "babylon-lite";

import { unsupported } from "../error.js";
import { Observable } from "../misc/observable.js";
import type { Scene } from "../scene/scene.js";

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

    public constructor(url: string, scene: Scene) {
        super();
        this.name = url;
        const engine = scene.getEngine()._lite;
        this._ready = loadTexture2D(engine, url).then((tex) => {
            this._lite = tex;
        });
    }

    public override getClassName(): string {
        return "Texture";
    }

    public override whenReadyAsync(): Promise<void> {
        return this._ready;
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
