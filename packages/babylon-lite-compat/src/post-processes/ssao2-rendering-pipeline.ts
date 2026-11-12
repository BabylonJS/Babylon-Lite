import { attachSceneSsaoPipeline, createSceneSsaoPipeline, detachSceneSsaoPipeline, disposeSceneSsaoPipeline, type SceneSsaoPipeline } from "babylon-lite";

import type { Camera } from "../cameras/cameras.js";
import type { AbstractEngine } from "../engine/engine.js";
import { _getLastCreatedEngine } from "../engine/engine.js";
import { unsupported } from "../error.js";
import { Logger } from "../misc/misc-utils.js";
import type { Scene } from "../scene/scene.js";

type Ratio = number | { ssaoRatio?: number; blurRatio?: number };

/** Babylon.js-shaped adapter over Babylon Lite's native scene SSAO pipeline. */
export class SSAO2RenderingPipeline {
    private static _uniqueIdSource = 0;
    public readonly SSAOOriginalSceneColorEffect = "SSAOOriginalSceneColorEffect";
    public readonly SSAORenderEffect = "SSAORenderEffect";
    public readonly SSAOBlurHRenderEffect = "SSAOBlurHRenderEffect";
    public readonly SSAOBlurVRenderEffect = "SSAOBlurVRenderEffect";
    public readonly SSAOCombineRenderEffect = "SSAOCombineRenderEffect";
    public readonly isSupported: boolean;
    public readonly uniqueId = ++SSAO2RenderingPipeline._uniqueIdSource;
    /** @internal Babylon.js pipeline registry key. */
    public readonly _name: string;

    private readonly _scene: Scene;
    private readonly _ratio: Ratio;
    private readonly _forceGeometryBuffer: boolean | object;
    private readonly _textureType: number;
    private readonly _resolutionScale: number;
    private _native: SceneSsaoPipeline | null = null;
    private _camera: Camera | null = null;
    private _disposed = false;
    private _radius = 2;
    private _totalStrength = 1;
    private _base = 0;
    private _maxZ = 100;
    private _minZAspect = 0.2;
    private _epsilon = 0.02;
    private _samples = 8;
    private _expensiveBlur = true;
    private _bypassBlur = false;
    private _bilateralSamples = 16;
    private _bilateralSoften = 0;
    private _bilateralTolerance = 0;
    private _useViewportInCombineStage = true;
    private _textureSamples = 1;
    private readonly _warned = new Set<string>();
    public readonly cameras: Camera[] = [];

    public constructor(name: string, scene: Scene, ratio: Ratio, cameras?: Camera[], forceGeometryBuffer: boolean | object = false, textureType = 0) {
        this._name = name;
        this._scene = scene;
        this._ratio = ratio;
        this._forceGeometryBuffer = forceGeometryBuffer;
        this._textureType = textureType;
        this._resolutionScale = typeof ratio === "number" ? ratio : (ratio.ssaoRatio ?? 1);
        this.isSupported = !scene.getEngine()._headless;
        scene.postProcessRenderPipelineManager.addPipeline(this);
        if (scene.getEngine()._headless) {
            Logger.Error("SSAO2RenderingPipeline is not supported by the headless engine.");
            return;
        }
        if (forceGeometryBuffer !== false) {
            this._warnUnsupported("forceGeometryBuffer", forceGeometryBuffer);
        }
        if (textureType !== 0) {
            this._warnUnsupported("textureType", textureType);
        }
        if (typeof ratio !== "number" && ratio.blurRatio !== undefined && ratio.blurRatio !== ratio.ssaoRatio) {
            this._warnUnsupported("blurRatio", ratio.blurRatio);
        }
        if (cameras?.length) {
            this._attachCameras(cameras);
        }
    }

    public get radius(): number {
        return this._radius;
    }
    public set radius(value: number) {
        this._radius = value;
        if (this._native) {
            this._native.radius = value;
        }
    }

    public get totalStrength(): number {
        return this._totalStrength;
    }
    public set totalStrength(value: number) {
        this._totalStrength = value;
        if (this._native) {
            this._native.intensity = value;
        }
    }

    public get base(): number {
        return this._base;
    }
    public set base(value: number) {
        this._base = value;
        if (this._native) {
            this._native.base = value;
        }
    }

    public get maxZ(): number {
        return this._maxZ;
    }
    public set maxZ(value: number) {
        this._maxZ = value;
        if (this._native) {
            this._native.fadeEnd = value;
        }
    }

    public get minZAspect(): number {
        return this._minZAspect;
    }
    public set minZAspect(value: number) {
        this._minZAspect = value;
        if (value !== 0.2) {
            this._warnUnsupported("minZAspect", value);
        }
    }

    public get epsilon(): number {
        return this._epsilon;
    }
    public set epsilon(value: number) {
        this._epsilon = value;
        if (value !== 0.02) {
            this._warnUnsupported("epsilon", value);
        }
    }

    public get samples(): number {
        return this._samples;
    }
    public set samples(value: number) {
        this._samples = value;
        if (value !== 8) {
            this._warnUnsupported("samples", value);
        }
    }

    public get expensiveBlur(): boolean {
        return this._expensiveBlur;
    }

    public get bypassBlur(): boolean {
        return this._bypassBlur;
    }
    public set bypassBlur(value: boolean) {
        this._bypassBlur = value;
        if (value !== false) {
            this._warnUnsupported("bypassBlur", value);
        }
    }

    public get bilateralSamples(): number {
        return this._bilateralSamples;
    }
    public set bilateralSamples(value: number) {
        this._bilateralSamples = value;
        if (value !== 16) {
            this._warnUnsupported("bilateralSamples", value);
        }
    }

    public get bilateralSoften(): number {
        return this._bilateralSoften;
    }
    public set bilateralSoften(value: number) {
        this._bilateralSoften = value;
        if (value !== 0) {
            this._warnUnsupported("bilateralSoften", value);
        }
    }

    public get bilateralTolerance(): number {
        return this._bilateralTolerance;
    }
    public set bilateralTolerance(value: number) {
        this._bilateralTolerance = value;
        if (value !== 0) {
            this._warnUnsupported("bilateralTolerance", value);
        }
    }

    public get useViewportInCombineStage(): boolean {
        return this._useViewportInCombineStage;
    }
    public set useViewportInCombineStage(value: boolean) {
        this._useViewportInCombineStage = value;
        if (value !== true) {
            this._warnUnsupported("useViewportInCombineStage", value);
        }
    }
    public set expensiveBlur(value: boolean) {
        this._expensiveBlur = value;
        if (value !== true) {
            this._warnUnsupported("expensiveBlur", value);
        }
    }

    public get textureSamples(): number {
        return this._textureSamples;
    }
    public set textureSamples(value: number) {
        this._textureSamples = value;
        if (value !== 1) {
            this._warnUnsupported("textureSamples", value);
        }
    }

    public getClassName(): string {
        return "SSAO2RenderingPipeline";
    }

    public get name(): string {
        return this._name;
    }

    public get engine(): AbstractEngine {
        return this._scene.getEngine();
    }

    public get scene(): Scene {
        return this._scene;
    }

    public static get IsSupported(): boolean {
        const engine = _getLastCreatedEngine();
        return engine !== null && !engine._headless;
    }

    public static Parse(source: Record<string, unknown>, scene: Scene): SSAO2RenderingPipeline {
        const pipeline = new SSAO2RenderingPipeline(
            String(source._name ?? "ssao"),
            scene,
            (source._ratio as Ratio | undefined) ?? 1,
            undefined,
            (source._forceGeometryBuffer as boolean | object | undefined) ?? false,
            Number(source._textureType ?? 0)
        );
        for (const key of [
            "radius",
            "totalStrength",
            "base",
            "maxZ",
            "minZAspect",
            "epsilon",
            "samples",
            "expensiveBlur",
            "bypassBlur",
            "bilateralSamples",
            "bilateralSoften",
            "bilateralTolerance",
            "textureSamples",
        ] as const) {
            if (source[key] !== undefined) {
                (pipeline as unknown as Record<string, unknown>)[key] = source[key];
            }
        }
        return pipeline;
    }

    public isReady(): boolean {
        return this.isSupported && !this._disposed;
    }

    public serialize(): Record<string, unknown> {
        return {
            customType: "SSAO2RenderingPipeline",
            _name: this._name,
            _ratio: this._ratio,
            _forceGeometryBuffer: this._forceGeometryBuffer,
            _textureType: this._textureType,
            radius: this.radius,
            totalStrength: this.totalStrength,
            base: this.base,
            maxZ: this.maxZ,
            minZAspect: this.minZAspect,
            epsilon: this.epsilon,
            samples: this.samples,
            expensiveBlur: this.expensiveBlur,
            bypassBlur: this.bypassBlur,
            bilateralSamples: this.bilateralSamples,
            bilateralSoften: this.bilateralSoften,
            bilateralTolerance: this.bilateralTolerance,
            textureSamples: this.textureSamples,
        };
    }

    /** @internal */
    public _attachCameras(cameras: Camera[] | Camera, _unique = false): void {
        if (this._disposed || this._scene.getEngine()._headless) {
            return;
        }
        const list = Array.isArray(cameras) ? cameras : [cameras];
        if (list.length !== 1) {
            unsupported("SSAO2RenderingPipeline cameras", "Babylon Lite's native scene SSAO pipeline supports exactly one fullscreen camera per scene.");
        }
        const camera = list[0]!;
        if (this._camera === camera && this._native?.attached) {
            return;
        }
        if (this._native) {
            detachSceneSsaoPipeline(this._native);
        }
        this._camera = camera;
        this.cameras.length = 0;
        this.cameras.push(camera);
        this._native ??= createSceneSsaoPipeline(
            {
                name: this._name,
                resolutionScale: this._resolutionScale,
                radius: this._radius,
                intensity: this._totalStrength,
                base: this._base,
                fadeEnd: this._maxZ,
            },
            this._scene.getEngine()._lite,
            this._scene._lite,
            camera._lite
        );
        this._native.camera = camera._lite;
        attachSceneSsaoPipeline(this._native, camera._lite);
    }

    /** @internal */
    public _detachCameras(cameras: Camera[] | Camera): void {
        const list = Array.isArray(cameras) ? cameras : [cameras];
        if (this._camera && list.includes(this._camera)) {
            if (this._native) {
                detachSceneSsaoPipeline(this._native, this._camera._lite);
            }
            this.cameras.length = 0;
        }
    }

    /** @internal */
    public _enableEffect(_renderEffectName: string, _cameras: Camera[] | Camera): never {
        return unsupported(
            "PostProcessRenderPipelineManager.enableEffectInPipeline",
            "Babylon Lite's native scene SSAO is a single composite task and does not expose independently toggleable Babylon.js render effects."
        );
    }

    /** @internal */
    public _disableEffect(_renderEffectName: string, _cameras: Camera[] | Camera): never {
        return unsupported(
            "PostProcessRenderPipelineManager.disableEffectInPipeline",
            "Babylon Lite's native scene SSAO is a single composite task and does not expose independently toggleable Babylon.js render effects."
        );
    }

    /** @internal */
    public _update(): void {}

    /** @internal */
    public _rebuild(): void {}

    public dispose(_disableGeometryBufferRenderer = false): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        if (this._native) {
            disposeSceneSsaoPipeline(this._native);
        }
        this._native = null;
        this._camera = null;
        this.cameras.length = 0;
        this._scene.postProcessRenderPipelineManager.removePipeline(this._name);
    }

    private _warnUnsupported(setting: string, value: unknown): void {
        if (this._warned.has(setting)) {
            return;
        }
        this._warned.add(setting);
        Logger.Warn(`SSAO2RenderingPipeline.${setting}=${String(value)} has no native Babylon Lite equivalent and is retained for readback only.`);
    }
}
