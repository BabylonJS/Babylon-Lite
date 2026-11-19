import { addTaskAfter, buildFrameGraphTask, createGlowPostProcessTask, getFrameGraph, removeTask } from "babylon-lite";
import type { GlowColor, GlowPostProcessTask, Mesh as LiteMesh, Material as LiteMaterial, RenderTarget, Task, Texture2D } from "babylon-lite";
import type { Camera } from "../cameras/cameras.js";
import { _getLastCreatedEngine } from "../engine/engine.js";
import { LiteCompatError, unsupported } from "../error.js";
import { Color4 } from "../math/color.js";
import { PBRMaterial, StandardMaterial } from "../materials/materials.js";
import { NodeMaterial } from "../materials/node-material.js";
import type { AbstractMesh } from "../meshes/meshes.js";
import { Mesh } from "../meshes/meshes.js";
import { Logger } from "../misc/misc-utils.js";
import type { Scene } from "../scene/scene.js";
import type { BaseTexture } from "../textures/textures.js";

/** Babylon-shaped glow settings with optional explicit Lite frame-graph wiring. */
export interface IGlowLayerOptions {
    mainTextureRatio?: number;
    mainTextureFixedSize?: number;
    mainTextureType?: number;
    mainTextureFormat?: number;
    mainTextureSamples?: number;
    blurKernelSize?: number;
    alphaBlendingMode?: number;
    camera?: Camera | null;
    renderingGroupId?: number;
    ldrMerge?: boolean;
    excludeByDefault?: boolean;
    generateStencilBuffer?: boolean;
    /** Lite extension: borrowed final color destination. */
    targetTexture?: RenderTarget;
    /** Lite extension: resolve destination for a multisample targetTexture. */
    resolveTexture?: RenderTarget;
    /** Lite extension: explicit producer anchor; requires targetTexture. */
    afterTask?: Task;
}

export type GlowLayerMaterial = StandardMaterial | PBRMaterial | NodeMaterial;
/** Lite renders one material per mesh; subMesh is null, not an emulated SubMesh. */
export type GlowLayerColorSelector = (mesh: Mesh, subMesh: null, material: GlowLayerMaterial, result: Color4) => void;
export type GlowLayerTextureSelector = (mesh: Mesh, subMesh: null, material: GlowLayerMaterial) => BaseTexture | null;

/** Babylon.js GlowLayer facade over one compact native frame-graph task. */
export class GlowLayer {
    public static readonly DefaultBlurKernelSize = 32;
    public static readonly DefaultTextureRatio = 0.5;
    public readonly isSupported: boolean;
    private readonly _scene: Scene;
    private readonly _options: IGlowLayerOptions;
    private readonly _included = new Set<LiteMesh>();
    private readonly _excluded = new Set<LiteMesh>();
    private readonly _color = new Color4(0, 0, 0, 1);
    private readonly _disposeObserver = (): void => this.dispose();
    private _task: GlowPostProcessTask | null = null;
    private _disposed = false;
    private _enabled = true;
    private _intensity = 1;
    private _kernel = 32;
    private _neutral = new Color4(0, 0, 0, 1);
    private _camera: Camera | null;
    private _excludeByDefault: boolean;
    private _colorSelector: GlowLayerColorSelector | null = null;
    private _textureSelector: GlowLayerTextureSelector | null = null;
    private _selectedTexture: Texture2D | null = null;

    public constructor(
        public name: string,
        scene?: Scene,
        options: IGlowLayerOptions = {}
    ) {
        const owner = scene ?? _getLastCreatedEngine()?.scenes.at(-1);
        if (!owner) {
            throw new Error("GlowLayer requires a scene.");
        }
        if ((options.renderingGroupId ?? -1) !== -1) {
            unsupported("GlowLayer.renderingGroupId", "Order rendering tasks explicitly; use afterTask and targetTexture for a custom chain.");
        }
        if ((options.mainTextureSamples ?? 1) !== 1) {
            unsupported("GlowLayer.mainTextureSamples", "The glow map is single-sample; the final composition target may still use MSAA.");
        }
        if (options.generateStencilBuffer) {
            unsupported("GlowLayer.generateStencilBuffer", "Glow uses private depth without stencil.");
        }
        if (options.resolveTexture && !options.targetTexture) {
            throw new Error("GlowLayer resolveTexture requires targetTexture.");
        }
        if (options.afterTask && !options.targetTexture) {
            throw new Error("GlowLayer afterTask requires explicit targetTexture.");
        }
        this._scene = owner;
        this._options = { ...options };
        this._camera = options.camera ?? null;
        this._excludeByDefault = options.excludeByDefault ?? false;
        this.blurKernelSize = options.blurKernelSize ?? 32;
        this.isSupported = !owner.getEngine()._headless;
        owner.onDisposeObservable.add(this._disposeObserver);
        if (!this.isSupported) {
            Logger.Error("GlowLayer is not supported by the headless engine.");
            return;
        }
        owner.getEngine()._registerLateWork(() => this._initialize());
    }

    public get intensity(): number {
        return this._intensity;
    }
    public set intensity(value: number) {
        if (!Number.isFinite(value)) {
            throw new Error("GlowLayer.intensity must be finite.");
        }
        this._intensity = value;
        if (this._task) {
            this._task.intensity = value;
        }
    }
    public get isEnabled(): boolean {
        return this._enabled;
    }
    public set isEnabled(value: boolean) {
        this._enabled = value;
    }
    public get blurKernelSize(): number {
        return this._kernel;
    }
    public set blurKernelSize(value: number) {
        if (!(value > 0) || !Number.isFinite(value)) {
            throw new Error("GlowLayer.blurKernelSize must be positive and finite.");
        }
        this._kernel = value;
        if (this._task) {
            this._task.blurKernelSize = value;
        }
    }
    public get neutralColor(): Color4 {
        return this._neutral;
    }
    public set neutralColor(value: Color4) {
        this._neutral = value;
        if (this._task) {
            this._task.neutralColor = value;
        }
    }
    public get camera(): Camera | null {
        return this._camera;
    }
    public set camera(value: Camera | null) {
        this._camera = value;
        if (this._task) {
            this._task.camera = value?._lite ?? null;
        }
    }
    public get ldrMerge(): boolean {
        return this._options.ldrMerge ?? false;
    }
    public get alphaBlendingMode(): number {
        return this._options.alphaBlendingMode ?? 1;
    }
    public get renderingGroupId(): number {
        return -1;
    }
    public set renderingGroupId(value: number) {
        if (value !== -1) {
            unsupported("GlowLayer.renderingGroupId", "Order tasks in the frame graph instead.");
        }
    }
    public get customEmissiveColorSelector(): GlowLayerColorSelector | null {
        return this._colorSelector;
    }
    public set customEmissiveColorSelector(value: GlowLayerColorSelector | null) {
        this._colorSelector = value;
    }
    public get customEmissiveTextureSelector(): GlowLayerTextureSelector | null {
        return this._textureSelector;
    }
    public set customEmissiveTextureSelector(value: GlowLayerTextureSelector | null) {
        this._textureSelector = value;
        if (this._task) {
            this._task.customEmissiveTextureSelector = value ? this._textureBridge : undefined;
        }
    }
    public getClassName(): string {
        return "GlowLayer";
    }
    public getScene(): Scene {
        return this._scene;
    }
    public isReady(_subMesh?: unknown, _useInstances?: boolean): boolean {
        return !this._disposed && this._task !== null;
    }

    public addIncludedOnlyMesh(mesh: AbstractMesh): void {
        this._included.add(mesh._lite);
        this._syncMembership();
    }
    public removeIncludedOnlyMesh(mesh: AbstractMesh): void {
        this._included.delete(mesh._lite);
        this._syncMembership();
    }
    public addExcludedMesh(mesh: AbstractMesh): void {
        this._excluded.add(mesh._lite);
        this._syncMembership();
    }
    public removeExcludedMesh(mesh: AbstractMesh): void {
        this._excluded.delete(mesh._lite);
        this._syncMembership();
    }
    public setExcludedByDefault(value: boolean): void {
        this._excludeByDefault = value;
        if (this._task) {
            this._task.excludeByDefault = value;
        }
    }
    public hasMesh(mesh: AbstractMesh): boolean {
        return this._included.size ? this._included.has(mesh._lite) : !this._excludeByDefault && !this._excluded.has(mesh._lite);
    }

    public dispose(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        this._scene.onDisposeObservable.remove(this._disposeObserver);
        const task = this._task;
        this._task = null;
        if (task) {
            removeTask(this._scene._lite, task);
            task.dispose();
        }
        this._included.clear();
        this._excluded.clear();
        this._selectedTexture = null;
    }

    private _syncMembership(): void {
        const task = this._task;
        if (!task) {
            return;
        }
        task.includedOnlyMeshes.clear();
        task.excludedMeshes.clear();
        for (const mesh of this._included) {
            task.includedOnlyMeshes.add(mesh);
        }
        if (!this._included.size) {
            for (const mesh of this._excluded) {
                task.excludedMeshes.add(mesh);
            }
        }
    }

    private _mesh(lite: LiteMesh): Mesh {
        const wrapper = this._scene._getMeshWrapper(lite);
        if (wrapper instanceof Mesh) {
            return wrapper;
        }
        if (wrapper) {
            return unsupported("GlowLayer selector", "The rendered node has no Mesh facade.");
        }
        return Mesh._fromLite(lite, undefined, this._scene);
    }

    private _material(mesh: Mesh, lite: LiteMaterial): GlowLayerMaterial {
        const material = mesh.material ?? this._scene._wrapLoadedMaterial(lite);
        if (material instanceof StandardMaterial || material instanceof PBRMaterial || material instanceof NodeMaterial) {
            return material;
        }
        return unsupported("GlowLayer selector", "Only StandardMaterial, PBRMaterial and NodeMaterial surfaces are supported.");
    }

    private readonly _colorBridge = (liteMesh: LiteMesh, liteMaterial: LiteMaterial, result: GlowColor): void => {
        // Without user selectors only a Standard emissive texture's level needs the facade; skip wrapper lookups otherwise.
        if (!this._colorSelector && !this._textureSelector && !(liteMaterial as { _emissiveTexture?: unknown })._emissiveTexture) {
            return;
        }
        const mesh = this._mesh(liteMesh);
        const material = this._material(mesh, liteMaterial);
        let texture: BaseTexture | null = null;
        if (this._textureSelector) {
            texture = this._textureSelector(mesh, null, material);
            if (texture !== null && !texture?._lite) {
                throw new LiteCompatError("GlowLayer.customEmissiveTextureSelector", "Return a ready 2D texture or null.");
            }
            this._selectedTexture = texture?._lite ?? null;
        }
        if (this._colorSelector) {
            this._color.set(result.r, result.g, result.b, result.a);
            this._colorSelector(mesh, null, material, this._color);
            result.r = this._color.r;
            result.g = this._color.g;
            result.b = this._color.b;
            result.a = this._color.a;
        } else if (!this._textureSelector && material instanceof StandardMaterial && material.emissiveTexture) {
            const level = material.emissiveTexture.level;
            result.r *= level;
            result.g *= level;
            result.b *= level;
        }
    };

    private readonly _textureBridge = (): Texture2D | null => this._selectedTexture;

    private async _initialize(): Promise<void> {
        await Promise.resolve();
        if (this._disposed || this._task) {
            return;
        }
        const scene = this._scene._lite;
        const producer = scene.defaultRenderTask;
        const anchor = this._options.afterTask ?? producer;
        const target = this._options.targetTexture ?? producer?.config.rt;
        if (!anchor || !target) {
            throw new Error("GlowLayer requires a default render task or explicit afterTask and targetTexture.");
        }
        const resolve = this._options.targetTexture ? this._options.resolveTexture : producer?.config.rst;
        const task = createGlowPostProcessTask(
            {
                ...this._options,
                name: this.name,
                targetTexture: target,
                resolveTexture: resolve,
                camera: this._camera?._lite ?? null,
                intensity: this._intensity,
                blurKernelSize: this._kernel,
                neutralColor: this._neutral,
                excludeByDefault: this._excludeByDefault,
                customEmissiveColorSelector: this._colorBridge,
                customEmissiveTextureSelector: this._textureSelector ? this._textureBridge : undefined,
            },
            this._scene.getEngine()._lite,
            scene
        );
        try {
            await task._preload?.();
            if (this._disposed) {
                task.dispose();
                return;
            }
            if (!this._options.targetTexture && (producer!.config.rt !== target || producer!.config.rst !== resolve)) {
                throw new Error("GlowLayer output changed during initialization. Configure the output pipeline first or supply explicit destinations.");
            }
            task.intensity = this._intensity;
            task.blurKernelSize = this._kernel;
            task.neutralColor = this._neutral;
            task.camera = this._camera?._lite ?? null;
            task.excludeByDefault = this._excludeByDefault;
            task.customEmissiveTextureSelector = this._textureSelector ? this._textureBridge : undefined;
            Object.defineProperty(task, "isEnabled", { get: () => this._enabled && (!this._camera || scene.camera === this._camera._lite) });
            addTaskAfter(scene, task, anchor);
            buildFrameGraphTask(getFrameGraph(scene), task);
            this._task = task;
            this._syncMembership();
        } catch (error) {
            removeTask(scene, task);
            task.dispose();
            throw error;
        }
    }
}
