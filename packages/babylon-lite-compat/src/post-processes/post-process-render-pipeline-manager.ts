import type { Camera } from "../cameras/cameras.js";
import { Observable } from "../misc/observable.js";

/** Babylon.js post-process pipeline shape consumed by the manager. */
export interface PostProcessRenderPipeline {
    /** @internal */
    readonly _name: string;
    readonly isSupported: boolean;
    /** @internal */
    _attachCameras(cameras: Camera[] | Camera, unique?: boolean): void;
    /** @internal */
    _detachCameras(cameras: Camera[] | Camera): void;
    /** @internal */
    _enableEffect(renderEffectName: string, cameras: Camera[] | Camera): void;
    /** @internal */
    _disableEffect(renderEffectName: string, cameras: Camera[] | Camera): void;
    /** @internal */
    _update(): void;
    /** @internal */
    _rebuild(): void;
    dispose(): void;
}

/** Babylon.js-compatible post-process pipeline registry for native Lite-backed pipelines. */
export class PostProcessRenderPipelineManager {
    private readonly _renderPipelines = new Map<string, PostProcessRenderPipeline>();
    private readonly _onNewPipelineAddedObservable = new Observable<PostProcessRenderPipeline>();
    private readonly _onPipelineRemovedObservable = new Observable<PostProcessRenderPipeline>();

    public get onNewPipelineAddedObservable(): Observable<PostProcessRenderPipeline> {
        return this._onNewPipelineAddedObservable;
    }

    public get onPipelineRemovedObservable(): Observable<PostProcessRenderPipeline> {
        return this._onPipelineRemovedObservable;
    }

    public get supportedPipelines(): PostProcessRenderPipeline[] {
        return [...this._renderPipelines.values()].filter((pipeline) => pipeline.isSupported);
    }

    public addPipeline(renderPipeline: PostProcessRenderPipeline): void {
        this.removePipeline(renderPipeline._name);
        this._renderPipelines.set(renderPipeline._name, renderPipeline);
        this._onNewPipelineAddedObservable.notifyObservers(renderPipeline);
    }

    public removePipeline(renderPipelineName: string): void {
        const pipeline = this._renderPipelines.get(renderPipelineName);
        if (!pipeline) {
            return;
        }
        this._onPipelineRemovedObservable.notifyObservers(pipeline);
        this._renderPipelines.delete(renderPipelineName);
    }

    public attachCamerasToRenderPipeline(renderPipelineName: string, cameras: Camera[] | Camera, unique = false): void {
        this._renderPipelines.get(renderPipelineName)?._attachCameras(cameras, unique);
    }

    public detachCamerasFromRenderPipeline(renderPipelineName: string, cameras: Camera[] | Camera): void {
        this._renderPipelines.get(renderPipelineName)?._detachCameras(cameras);
    }

    public enableEffectInPipeline(renderPipelineName: string, renderEffectName: string, cameras: Camera[] | Camera): void {
        this._renderPipelines.get(renderPipelineName)?._enableEffect(renderEffectName, cameras);
    }

    public disableEffectInPipeline(renderPipelineName: string, renderEffectName: string, cameras: Camera[] | Camera): void {
        this._renderPipelines.get(renderPipelineName)?._disableEffect(renderEffectName, cameras);
    }

    public update(): void {
        for (const [name, pipeline] of this._renderPipelines) {
            if (!pipeline.isSupported) {
                pipeline.dispose();
                this._renderPipelines.delete(name);
            } else {
                pipeline._update();
            }
        }
    }

    /** @internal */
    public _rebuild(): void {
        for (const pipeline of this._renderPipelines.values()) {
            pipeline._rebuild();
        }
    }

    public dispose(): void {
        for (const pipeline of [...this._renderPipelines.values()]) {
            pipeline.dispose();
        }
        this._renderPipelines.clear();
        this._onNewPipelineAddedObservable.clear();
        this._onPipelineRemovedObservable.clear();
    }
}
