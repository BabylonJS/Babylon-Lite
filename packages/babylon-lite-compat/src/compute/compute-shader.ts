import {
    addComputeDispatch,
    computeStorageBufferBinding,
    computeUniformBufferBinding,
    createComputeBindingSet,
    createComputeDispatch,
    createComputeIndirectDispatch,
    createComputeShader,
    createComputeTask,
    disposeComputeBindingSet,
    disposeComputeShader,
    submitComputeTasks,
} from "babylon-lite";
import type {
    ComputeBindingDecl,
    ComputeBindingResources,
    ComputeBindingSet as LiteComputeBindingSet,
    ComputeShader as LiteComputeShader,
    StorageBuffer as LiteStorageBuffer,
    UniformBuffer as LiteUniformBuffer,
} from "babylon-lite";

import type { StorageBuffer } from "../buffers/storage-buffer.js";
import type { AbstractEngine } from "../engine/engine.js";
import { unsupported } from "../error.js";
import type { UniformBuffer } from "../materials/uniform-buffer.js";
import type { BaseTexture } from "../textures/textures.js";

export interface ComputeBindingLocation {
    group: number;
    binding: number;
}

export type ComputeBindingMapping = Record<string, ComputeBindingLocation>;

export interface IComputeShaderPath {
    computeSource?: string;
    compute?: string;
    computeElement?: string;
}

export interface IComputeShaderOptions {
    bindingsMapping: ComputeBindingMapping;
    defines?: string[];
    entryPoint?: string;
    processFinalCode?: ((code: string) => string) | null;
    useExplicitComputePipelineLayout?: boolean;
}

type ComputeEffect = LiteComputeShader;
type BufferBinding = { readonly kind: "uniform"; readonly resource: LiteUniformBuffer } | { readonly kind: "storage"; readonly resource: LiteStorageBuffer };
let nextComputeShaderId = 1;

function sourceFrom(shaderPath: IComputeShaderPath | string): string {
    if (typeof shaderPath === "object" && shaderPath.computeSource !== undefined) {
        return shaderPath.computeSource;
    }
    return unsupported(
        "ComputeShader.constructor",
        "Lite's public compute factory accepts complete WGSL source. Babylon.js ShaderStore names, external .compute.fx paths, and DOM script-element lookup have no public Lite resolver."
    );
}

/** Babylon.js ComputeShader adapted to Lite's public buffer-backed compute graph. */
export class ComputeShader {
    public static readonly Parse = ComputeShaderParse;

    public readonly uniqueId = nextComputeShaderId++;
    public name: string;
    public fastMode = false;
    public onCompiled: ((effect: ComputeEffect) => void) | null = null;
    public onError: ((effect: ComputeEffect, errors: string) => void) | null = null;
    public readonly gpuTimeInFrame = undefined;
    public triggerContextRebuild = false;

    private readonly _source: string;
    private readonly _bindings = new Map<string, BufferBinding>();
    private _shader: LiteComputeShader | null = null;
    private _bindingSet: LiteComputeBindingSet | null = null;
    private _bindingsDirty = false;
    private _shaderDirty = false;
    private _compiled = false;

    public constructor(
        name: string,
        private readonly _engine: AbstractEngine,
        private readonly _shaderPath: IComputeShaderPath | string,
        options: Partial<IComputeShaderOptions> = {}
    ) {
        this.name = name;
        this._options = {
            bindingsMapping: {},
            defines: [],
            entryPoint: "main",
            ...options,
        };
        if (this._options.defines?.length) {
            unsupported(
                "ComputeShader.constructor(options.defines)",
                "Lite's public compute factory accepts final WGSL and intentionally exposes no Babylon.js shader preprocessor for #define expansion."
            );
        }
        const source = sourceFrom(this._shaderPath);
        this._source = this._options.processFinalCode?.(source) ?? source;
    }

    private readonly _options: IComputeShaderOptions;

    public get options(): IComputeShaderOptions {
        return this._options;
    }

    public get shaderPath(): string | IComputeShaderPath {
        return this._shaderPath;
    }

    public getClassName(): string {
        return "ComputeShader";
    }

    public setTexture(_name: string, _texture: BaseTexture, _bindSampler = true): never {
        return unsupported(
            "ComputeShader.setTexture",
            "Lite validates an existing Texture2D for compute through the asynchronous createComputeTextureResource API, which cannot preserve Babylon.js's synchronous setter and dispatch contract."
        );
    }

    public setInternalTexture(_name: string, _texture: unknown): never {
        return unsupported(
            "ComputeShader.setInternalTexture",
            "Lite intentionally does not expose raw GPU texture handles, and its public compute texture adapter is asynchronous."
        );
    }

    public setStorageTexture(_name: string, _texture: BaseTexture): never {
        return unsupported(
            "ComputeShader.setStorageTexture",
            "A Babylon.js BaseTexture does not carry the storage usage, format, and access metadata required by Lite's distinct ComputeStorageTexture public resource."
        );
    }

    public setExternalTexture(_name: string, _texture: unknown): never {
        return unsupported("ComputeShader.setExternalTexture", "Lite's public compute binding API has no external-texture binding declaration or resource.");
    }

    public setVideoTexture(_name: string, _texture: unknown): false {
        return false;
    }

    public setUniformBuffer(name: string, buffer: UniformBuffer | LiteUniformBuffer): void {
        const resource = "_getLiteBuffer" in buffer ? buffer._getLiteBuffer() : buffer;
        const current = this._bindings.get(name);
        if (current?.kind === "uniform" && current.resource === resource) {
            return;
        }
        this._bindingsDirty = true;
        this._shaderDirty ||= this._shader !== null && (current === undefined || current.kind !== "uniform");
        this._bindings.set(name, { kind: "uniform", resource });
    }

    public setStorageBuffer(name: string, buffer: StorageBuffer | LiteStorageBuffer): void {
        const resource = "_getLiteBuffer" in buffer ? buffer._getLiteBuffer() : buffer;
        const current = this._bindings.get(name);
        if (current?.kind === "storage" && current.resource === resource) {
            return;
        }
        this._bindingsDirty = true;
        this._shaderDirty ||= this._shader !== null && (current === undefined || current.kind !== "storage");
        this._bindings.set(name, { kind: "storage", resource });
    }

    public setTextureSampler(_name: string, _sampler: unknown): never {
        return unsupported(
            "ComputeShader.setTextureSampler",
            "Babylon.js TextureSampler does not expose a Lite ComputeSampler, and Lite intentionally does not accept raw GPUSampler handles."
        );
    }

    public isReady(): boolean {
        if (!this._engine._lite) {
            return false;
        }
        for (const name of this._bindings.keys()) {
            if (!this._options.bindingsMapping[name]) {
                throw new Error(`ComputeShader ('${this.name}'): No binding mapping has been provided for the property '${name}'`);
            }
        }
        if (this._bindingsDirty) {
            this._invalidateBindings(this._shaderDirty);
            this._bindingsDirty = false;
            this._shaderDirty = false;
        }
        this._createGraph();
        return true;
    }

    public dispatch(x: number, y = 1, z = 1): boolean {
        const checkContext = !this.fastMode || this.triggerContextRebuild || !this._shader || !this._bindingSet;
        if (this.triggerContextRebuild) {
            this._bindingsDirty = true;
        }
        if (checkContext && !this.isReady()) {
            return false;
        }
        const graph = this._createGraph();
        const dispatch = createComputeDispatch(graph.shader, graph.bindings, { size: { x, y, z } });
        this._submit(graph, dispatch);
        return true;
    }

    public dispatchIndirect(buffer: StorageBuffer | LiteStorageBuffer, offset = 0): boolean {
        const checkContext = !this.fastMode || this.triggerContextRebuild || !this._shader || !this._bindingSet;
        if (this.triggerContextRebuild) {
            this._bindingsDirty = true;
        }
        if (checkContext && !this.isReady()) {
            return false;
        }
        const resource = "_getLiteBuffer" in buffer ? buffer._getLiteBuffer() : buffer;
        const graph = this._createGraph();
        const dispatch = createComputeIndirectDispatch(graph.shader, graph.bindings, { buffer: resource, byteOffset: offset });
        this._submit(graph, dispatch);
        return true;
    }

    public async dispatchWhenReady(x: number, y = 1, z = 1, delay = 10): Promise<void> {
        while (!this.dispatch(x, y, z)) {
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
        }
    }

    public serialize(): Record<string, unknown> {
        return {
            name: this.name,
            fastMode: this.fastMode,
            options: this._options,
            shaderPath: this._shaderPath,
            bindings: {},
            textures: {},
        };
    }

    private _createGraph(): { shader: LiteComputeShader; bindings: LiteComputeBindingSet } {
        const shader = this._createShader();
        let compiledNow = false;
        if (!this._compiled) {
            this._compiled = true;
            compiledNow = true;
            this.onCompiled?.(shader);
        }
        if (compiledNow && this._bindingsDirty) {
            const recreateShader = this._shaderDirty;
            this._invalidateBindings(recreateShader);
            this._bindingsDirty = false;
            this._shaderDirty = false;
            const finalShader = recreateShader ? this._createShader() : shader;
            this._compiled = true;
            return { shader: finalShader, bindings: this._createBindingSet(finalShader) };
        }
        return { shader, bindings: this._createBindingSet(shader) };
    }

    private _createShader(): LiteComputeShader {
        const declarations: ComputeBindingDecl[] = [];
        for (const [name, binding] of this._bindings) {
            const location = this._options.bindingsMapping[name];
            if (!location) {
                throw new Error(`ComputeShader ('${this.name}'): No binding mapping has been provided for the property '${name}'`);
            }
            declarations.push(
                binding.kind === "uniform"
                    ? computeUniformBufferBinding(name, location)
                    : computeStorageBufferBinding(name, {
                          ...location,
                          access: this._options.useExplicitComputePipelineLayout === true ? "read-write" : "read",
                      })
            );
        }
        return (this._shader ??= createComputeShader(this._engine._lite, {
            name: this.name,
            computeSource: this._source,
            entryPoint: this._options.entryPoint,
            bindings: declarations,
            automaticLayout: this._options.useExplicitComputePipelineLayout !== true,
        }));
    }

    private _createBindingSet(shader: LiteComputeShader): LiteComputeBindingSet {
        if (!this._bindingSet) {
            const resources: Record<string, unknown> = {};
            for (const [name, binding] of this._bindings) {
                resources[name] = binding.resource;
            }
            this._bindingSet = createComputeBindingSet(shader, resources as ComputeBindingResources);
        }
        return this._bindingSet;
    }

    private _submit(graph: { shader: LiteComputeShader; bindings: LiteComputeBindingSet }, dispatch: ReturnType<typeof createComputeDispatch>): void {
        const task = createComputeTask(this._engine._lite, this.name);
        addComputeDispatch(task, dispatch);
        task.record();
        try {
            submitComputeTasks([task]);
        } catch (error) {
            if (error instanceof Error && error.message === "submitComputeTasks cannot run while a frame is being recorded.") {
                return unsupported(
                    "ComputeShader.dispatch",
                    "Lite's public immediate compute submission cannot run while its frame encoder is active, and it exposes no engine-level hook equivalent to Babylon.js's in-frame compute dispatch."
                );
            }
            this.onError?.(graph.shader, error instanceof Error ? error.message : String(error));
            throw error;
        } finally {
            task.dispose();
            this.triggerContextRebuild = false;
        }
    }

    private _invalidateBindings(recreateShader = false): void {
        if (this._bindingSet) {
            disposeComputeBindingSet(this._bindingSet);
            this._bindingSet = null;
        }
        if (recreateShader && this._shader) {
            disposeComputeShader(this._shader);
            this._shader = null;
            this._compiled = false;
        }
    }
}

export function ComputeShaderParse(source: Record<string, unknown>, scene: { getEngine(): AbstractEngine }, _rootUrl: string): ComputeShader {
    if (source.textures && Object.keys(source.textures as object).length > 0) {
        return unsupported(
            "ComputeShader.Parse",
            "Serialized Babylon.js textures require its texture parser, while Lite's public compute texture adapter is asynchronous and has no serialization registry."
        );
    }
    const computeShader = new ComputeShader(
        String(source.name ?? ""),
        scene.getEngine(),
        source.shaderPath as IComputeShaderPath | string,
        (source.options ?? {}) as Partial<IComputeShaderOptions>
    );
    computeShader.fastMode = source.fastMode === true;
    return computeShader;
}

export function RegisterComputeShader(): void {}
