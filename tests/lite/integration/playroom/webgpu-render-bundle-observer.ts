export interface ObservedBuffer {
    readonly id: number;
    readonly label: string;
    readonly size: number;
    readonly usage: number;
    readonly dataBase64: string;
}

export interface ObservedBundleDraw {
    readonly type: "drawIndexed";
    readonly indexCount: number;
    readonly instanceCount: number;
    readonly firstIndex: number;
    readonly baseVertex: number;
    readonly firstInstance: number;
    readonly pipelineId: number | null;
    readonly textureIds: readonly number[];
    readonly indexBuffer: {
        readonly bufferId: number;
        readonly format: GPUIndexFormat;
        readonly offset: number;
        readonly size: number | null;
    } | null;
    readonly vertexBuffers: ReadonlyArray<{
        readonly slot: number;
        readonly bufferId: number;
        readonly offset: number;
        readonly size: number | null;
    }>;
}

export interface ObservedRenderBundle {
    readonly encoderId: number;
    readonly bundleId: number;
    readonly descriptor: {
        readonly colorFormats: readonly (GPUTextureFormat | null)[];
        readonly depthStencilFormat: GPUTextureFormat | null;
        readonly sampleCount: number;
    };
    readonly draws: readonly ObservedBundleDraw[];
}

export interface ObservedPipeline {
    readonly id: number;
    readonly label: string;
    readonly fragmentTargetCount: number;
    readonly vertexBuffers: ReadonlyArray<{
        readonly slot: number;
        readonly arrayStride: number;
        readonly stepMode: GPUVertexStepMode;
    }>;
    readonly primitive: {
        readonly topology: GPUPrimitiveTopology;
        readonly frontFace: GPUFrontFace;
        readonly cullMode: GPUCullMode;
    };
    readonly depthStencil: {
        readonly format: GPUTextureFormat;
        readonly depthCompare: GPUCompareFunction;
        readonly depthWriteEnabled: boolean;
    } | null;
    readonly blend: {
        readonly color: GPUBlendComponent;
        readonly alpha: GPUBlendComponent;
    } | null;
}

export interface RenderBundleObservation {
    readonly schemaVersion: 1;
    readonly createRenderBundleEncoderCount: number;
    readonly finishCount: number;
    readonly executeBundlesCallCount: number;
    readonly executeBundlesMemberships: ReadonlyArray<{
        readonly bundleIds: readonly number[];
        readonly callCount: number;
    }>;
    readonly executedBundles: readonly ObservedRenderBundle[];
    readonly directDraws: readonly ObservedBundleDraw[];
    readonly pipelines: readonly ObservedPipeline[];
    readonly buffers: readonly ObservedBuffer[];
    readonly createdBuffers: readonly ObservedBuffer[];
}

declare global {
    interface Window {
        __playroomRenderBundleObservation?: () => RenderBundleObservation;
        __playroomSuppressDirectDraw?: (indexCount: number, suppress: boolean) => void;
        __playroomObservedBufferId?: (buffer: GPUBuffer) => number;
        __playroomReadObservedBufferFloats?: (bufferId: number, byteOffset: number, floatCount: number) => Promise<number[]>;
        __playroomObservedTextureId?: (texture: GPUTexture) => number;
        __playroomReadObservedTextureFloats?: (textureId: number, floatCount: number) => Promise<number[]>;
    }
}

export function installWebGpuRenderBundleObserver(): void {
    type BufferRecord = {
        id: number;
        label: string;
        size: number;
        usage: number;
        data: Uint8Array;
    };
    type EncoderRecord = {
        encoderId: number;
        bundleId: number | null;
        descriptor: {
            colorFormats: (GPUTextureFormat | null)[];
            depthStencilFormat: GPUTextureFormat | null;
            sampleCount: number;
        };
        draws: ObservedBundleDraw[];
    };

    let nextId = 1;
    let createRenderBundleEncoderCount = 0;
    let finishCount = 0;
    let executeBundlesCallCount = 0;
    const ids = new WeakMap<object, number>();
    const bufferRecords = new WeakMap<GPUBuffer, BufferRecord>();
    const bufferRecordsById = new Map<number, BufferRecord>();
    const buffersById = new Map<number, GPUBuffer>();
    const observed = { device: null as GPUDevice | null };
    const mappedRanges = new WeakMap<GPUBuffer, Array<{ offset: number; range: ArrayBuffer }>>();
    const encoderRecords = new WeakMap<GPURenderBundleEncoder, EncoderRecord>();
    const encoderRecordList: EncoderRecord[] = [];
    const bundleRecords = new WeakMap<GPURenderBundle, EncoderRecord>();
    const pipelineRecordsById = new Map<number, ObservedPipeline>();
    const executeMemberships = new Map<string, { bundleIds: number[]; callCount: number }>();
    const directDraws: ObservedBundleDraw[] = [];
    const suppressedDirectIndexCounts = new Set<number>();

    const idFor = (value: object): number => {
        let id = ids.get(value);
        if (id === undefined) {
            id = nextId++;
            ids.set(value, id);
        }
        return id;
    };

    const copyBufferSource = (data: GPUAllowSharedBufferSource, dataOffset = 0, size?: number): Uint8Array => {
        const source = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        const byteLength = size ?? source.byteLength - dataOffset;
        return source.slice(dataOffset, dataOffset + byteLength);
    };

    const nativeCreateBuffer = GPUDevice.prototype.createBuffer;
    Object.defineProperty(GPUDevice.prototype, "createBuffer", {
        configurable: true,
        writable: true,
        value: function (this: GPUDevice, descriptor: GPUBufferDescriptor): GPUBuffer {
            observed.device ??= this;
            const observedDescriptor =
                descriptor.label === "thin-instance-matrices"
                    ? {
                          ...descriptor,
                          usage: descriptor.usage | GPUBufferUsage.COPY_SRC,
                      }
                    : descriptor;
            const buffer = nativeCreateBuffer.call(this, observedDescriptor);
            const id = idFor(buffer);
            const record: BufferRecord = {
                id,
                label: observedDescriptor.label ?? "",
                size: Number(observedDescriptor.size),
                usage: observedDescriptor.usage,
                data: new Uint8Array(Number(observedDescriptor.size)),
            };
            bufferRecords.set(buffer, record);
            bufferRecordsById.set(id, record);
            buffersById.set(id, buffer);
            return buffer;
        },
    });

    const nativeGetMappedRange = GPUBuffer.prototype.getMappedRange;
    Object.defineProperty(GPUBuffer.prototype, "getMappedRange", {
        configurable: true,
        writable: true,
        value: function (this: GPUBuffer, offset = 0, size?: number): ArrayBuffer {
            const range = nativeGetMappedRange.call(this, offset, size);
            const ranges = mappedRanges.get(this) ?? [];
            ranges.push({ offset, range });
            mappedRanges.set(this, ranges);
            return range;
        },
    });

    const nativeUnmap = GPUBuffer.prototype.unmap;
    Object.defineProperty(GPUBuffer.prototype, "unmap", {
        configurable: true,
        writable: true,
        value: function (this: GPUBuffer): void {
            const record = bufferRecords.get(this);
            if (record) {
                for (const mapped of mappedRanges.get(this) ?? []) {
                    record.data.set(new Uint8Array(mapped.range), mapped.offset);
                }
            }
            mappedRanges.delete(this);
            nativeUnmap.call(this);
        },
    });

    const nativeWriteBuffer = GPUQueue.prototype.writeBuffer;
    Object.defineProperty(GPUQueue.prototype, "writeBuffer", {
        configurable: true,
        writable: true,
        value: function (this: GPUQueue, buffer: GPUBuffer, bufferOffset: GPUSize64, data: GPUAllowSharedBufferSource, dataOffset?: GPUSize64, size?: GPUSize64): void {
            const record = bufferRecords.get(buffer);
            if (record) {
                const copied = copyBufferSource(data, Number(dataOffset ?? 0), size === undefined ? undefined : Number(size));
                record.data.set(copied, Number(bufferOffset));
            }
            nativeWriteBuffer.call(this, buffer, bufferOffset, data, dataOffset, size);
        },
    });

    const nativeCreateRenderBundleEncoder = GPUDevice.prototype.createRenderBundleEncoder;
    Object.defineProperty(GPUDevice.prototype, "createRenderBundleEncoder", {
        configurable: true,
        writable: true,
        value: function (this: GPUDevice, descriptor: GPURenderBundleEncoderDescriptor): GPURenderBundleEncoder {
            const encoder = nativeCreateRenderBundleEncoder.call(this, descriptor);
            const record: EncoderRecord = {
                encoderId: idFor(encoder),
                bundleId: null,
                descriptor: {
                    colorFormats: Array.from(descriptor.colorFormats, (format) => format ?? null),
                    depthStencilFormat: descriptor.depthStencilFormat ?? null,
                    sampleCount: descriptor.sampleCount ?? 1,
                },
                draws: [],
            };
            encoderRecords.set(encoder, record);
            encoderRecordList.push(record);
            createRenderBundleEncoderCount++;
            return encoder;
        },
    });

    const recordPipeline = (pipeline: GPURenderPipeline, descriptor: GPURenderPipelineDescriptor): GPURenderPipeline => {
        const primitive = descriptor.primitive;
        const depth = descriptor.depthStencil;
        const target = descriptor.fragment?.targets[0];
        const id = idFor(pipeline);
        pipelineRecordsById.set(id, {
            id,
            label: descriptor.label ?? "",
            fragmentTargetCount: descriptor.fragment?.targets.length ?? 0,
            vertexBuffers: Array.from(descriptor.vertex.buffers ?? [], (layout, slot) =>
                layout
                    ? {
                          slot,
                          arrayStride: Number(layout.arrayStride),
                          stepMode: layout.stepMode ?? "vertex",
                      }
                    : null
            ).filter((layout): layout is NonNullable<typeof layout> => layout !== null),
            primitive: {
                topology: primitive?.topology ?? "triangle-list",
                frontFace: primitive?.frontFace ?? "ccw",
                cullMode: primitive?.cullMode ?? "none",
            },
            depthStencil: depth
                ? {
                      format: depth.format,
                      depthCompare: depth.depthCompare ?? "always",
                      depthWriteEnabled: depth.depthWriteEnabled ?? false,
                  }
                : null,
            blend:
                target?.blend !== undefined
                    ? {
                          color: { ...target.blend.color },
                          alpha: { ...target.blend.alpha },
                      }
                    : null,
        });
        return pipeline;
    };

    const nativeCreateRenderPipeline = GPUDevice.prototype.createRenderPipeline;
    Object.defineProperty(GPUDevice.prototype, "createRenderPipeline", {
        configurable: true,
        writable: true,
        value: function (this: GPUDevice, descriptor: GPURenderPipelineDescriptor): GPURenderPipeline {
            return recordPipeline(nativeCreateRenderPipeline.call(this, descriptor), descriptor);
        },
    });

    const nativeCreateRenderPipelineAsync = GPUDevice.prototype.createRenderPipelineAsync;
    Object.defineProperty(GPUDevice.prototype, "createRenderPipelineAsync", {
        configurable: true,
        writable: true,
        value: async function (this: GPUDevice, descriptor: GPURenderPipelineDescriptor): Promise<GPURenderPipeline> {
            return recordPipeline(await nativeCreateRenderPipelineAsync.call(this, descriptor), descriptor);
        },
    });

    const encoderStates = new WeakMap<
        object,
        {
            pipelineId: number | null;
            indexBuffer: ObservedBundleDraw["indexBuffer"];
            vertexBuffers: Map<number, ObservedBundleDraw["vertexBuffers"][number]>;
            bindGroupTextureIds: Map<number, readonly number[]>;
        }
    >();
    const stateFor = (encoder: object) => {
        let state = encoderStates.get(encoder);
        if (!state) {
            state = { pipelineId: null, indexBuffer: null, vertexBuffers: new Map(), bindGroupTextureIds: new Map() };
            encoderStates.set(encoder, state);
        }
        return state;
    };

    const textureIdsByView = new WeakMap<GPUTextureView, number>();
    const texturesById = new Map<number, { texture: GPUTexture; width: number; height: number; format: GPUTextureFormat }>();
    const bindGroupTextureIds = new WeakMap<GPUBindGroup, readonly number[]>();
    const nativeCreateTexture = GPUDevice.prototype.createTexture;
    Object.defineProperty(GPUDevice.prototype, "createTexture", {
        configurable: true,
        writable: true,
        value: function (this: GPUDevice, descriptor: GPUTextureDescriptor): GPUTexture {
            const size = descriptor.size;
            const width = Number(Symbol.iterator in Object(size) ? Array.from(size as Iterable<number>)[0] : (size as GPUExtent3DDict).width);
            const height = Number(Symbol.iterator in Object(size) ? (Array.from(size as Iterable<number>)[1] ?? 1) : ((size as GPUExtent3DDict).height ?? 1));
            const readable = descriptor.format === "rgba32float" && height === 1;
            const observedDescriptor = readable ? { ...descriptor, usage: descriptor.usage | GPUTextureUsage.COPY_SRC } : descriptor;
            const texture = nativeCreateTexture.call(this, observedDescriptor);
            texturesById.set(idFor(texture), { texture, width, height, format: descriptor.format });
            return texture;
        },
    });

    const nativeCreateView = GPUTexture.prototype.createView;
    Object.defineProperty(GPUTexture.prototype, "createView", {
        configurable: true,
        writable: true,
        value: function (this: GPUTexture, descriptor?: GPUTextureViewDescriptor): GPUTextureView {
            const view = nativeCreateView.call(this, descriptor);
            textureIdsByView.set(view, idFor(this));
            return view;
        },
    });

    const nativeCreateBindGroup = GPUDevice.prototype.createBindGroup;
    Object.defineProperty(GPUDevice.prototype, "createBindGroup", {
        configurable: true,
        writable: true,
        value: function (this: GPUDevice, descriptor: GPUBindGroupDescriptor): GPUBindGroup {
            const bindGroup = nativeCreateBindGroup.call(this, descriptor);
            bindGroupTextureIds.set(
                bindGroup,
                descriptor.entries.map((entry) => textureIdsByView.get(entry.resource as GPUTextureView)).filter((id): id is number => id !== undefined)
            );
            return bindGroup;
        },
    });

    const textureIdsFor = (state: ReturnType<typeof stateFor>): number[] => [...new Set([...state.bindGroupTextureIds.values()].flat())].sort((left, right) => left - right);

    const nativeSetPipeline = GPURenderBundleEncoder.prototype.setPipeline;
    Object.defineProperty(GPURenderBundleEncoder.prototype, "setPipeline", {
        configurable: true,
        writable: true,
        value: function (this: GPURenderBundleEncoder, pipeline: GPURenderPipeline): void {
            stateFor(this).pipelineId = idFor(pipeline);
            nativeSetPipeline.call(this, pipeline);
        },
    });

    const nativeSetBindGroup = GPURenderBundleEncoder.prototype.setBindGroup;
    const emptyDynamicOffsets = new Uint32Array();
    Object.defineProperty(GPURenderBundleEncoder.prototype, "setBindGroup", {
        configurable: true,
        writable: true,
        value: function (
            this: GPURenderBundleEncoder,
            index: GPUIndex32,
            bindGroup: GPUBindGroup,
            dynamicOffsets: Uint32Array = emptyDynamicOffsets,
            dynamicOffsetsDataStart = 0,
            dynamicOffsetsDataLength = dynamicOffsets.length
        ): void {
            stateFor(this).bindGroupTextureIds.set(index, bindGroupTextureIds.get(bindGroup) ?? []);
            nativeSetBindGroup.call(this, index, bindGroup, dynamicOffsets, dynamicOffsetsDataStart, dynamicOffsetsDataLength);
        },
    });

    const nativeSetIndexBuffer = GPURenderBundleEncoder.prototype.setIndexBuffer;
    Object.defineProperty(GPURenderBundleEncoder.prototype, "setIndexBuffer", {
        configurable: true,
        writable: true,
        value: function (this: GPURenderBundleEncoder, buffer: GPUBuffer, indexFormat: GPUIndexFormat, offset = 0, size?: number): void {
            stateFor(this).indexBuffer = {
                bufferId: idFor(buffer),
                format: indexFormat,
                offset,
                size: size ?? null,
            };
            nativeSetIndexBuffer.call(this, buffer, indexFormat, offset, size);
        },
    });

    const nativeSetVertexBuffer = GPURenderBundleEncoder.prototype.setVertexBuffer;
    Object.defineProperty(GPURenderBundleEncoder.prototype, "setVertexBuffer", {
        configurable: true,
        writable: true,
        value: function (this: GPURenderBundleEncoder, slot: GPUIndex32, buffer: GPUBuffer | null, offset = 0, size?: number): void {
            const state = stateFor(this);
            if (buffer) {
                state.vertexBuffers.set(slot, {
                    slot,
                    bufferId: idFor(buffer),
                    offset,
                    size: size ?? null,
                });
            } else {
                state.vertexBuffers.delete(slot);
            }
            nativeSetVertexBuffer.call(this, slot, buffer, offset, size);
        },
    });

    const nativeDrawIndexed = GPURenderBundleEncoder.prototype.drawIndexed;
    Object.defineProperty(GPURenderBundleEncoder.prototype, "drawIndexed", {
        configurable: true,
        writable: true,
        value: function (this: GPURenderBundleEncoder, indexCount: GPUSize32, instanceCount = 1, firstIndex = 0, baseVertex = 0, firstInstance = 0): void {
            const state = stateFor(this);
            encoderRecords.get(this)?.draws.push({
                type: "drawIndexed",
                indexCount,
                instanceCount,
                firstIndex,
                baseVertex,
                firstInstance,
                pipelineId: state.pipelineId,
                textureIds: textureIdsFor(state),
                indexBuffer: state.indexBuffer,
                vertexBuffers: [...state.vertexBuffers.values()].sort((left, right) => left.slot - right.slot),
            });

            const nativePassSetPipeline = GPURenderPassEncoder.prototype.setPipeline;
            Object.defineProperty(GPURenderPassEncoder.prototype, "setPipeline", {
                configurable: true,
                writable: true,
                value: function (this: GPURenderPassEncoder, pipeline: GPURenderPipeline): void {
                    stateFor(this).pipelineId = idFor(pipeline);
                    nativePassSetPipeline.call(this, pipeline);
                },
            });

            const nativePassSetBindGroup = GPURenderPassEncoder.prototype.setBindGroup;
            Object.defineProperty(GPURenderPassEncoder.prototype, "setBindGroup", {
                configurable: true,
                writable: true,
                value: function (
                    this: GPURenderPassEncoder,
                    index: GPUIndex32,
                    bindGroup: GPUBindGroup,
                    dynamicOffsets: Uint32Array = emptyDynamicOffsets,
                    dynamicOffsetsDataStart = 0,
                    dynamicOffsetsDataLength = dynamicOffsets.length
                ): void {
                    stateFor(this).bindGroupTextureIds.set(index, bindGroupTextureIds.get(bindGroup) ?? []);
                    nativePassSetBindGroup.call(this, index, bindGroup, dynamicOffsets, dynamicOffsetsDataStart, dynamicOffsetsDataLength);
                },
            });

            const nativePassSetIndexBuffer = GPURenderPassEncoder.prototype.setIndexBuffer;
            Object.defineProperty(GPURenderPassEncoder.prototype, "setIndexBuffer", {
                configurable: true,
                writable: true,
                value: function (this: GPURenderPassEncoder, buffer: GPUBuffer, indexFormat: GPUIndexFormat, offset = 0, size?: number): void {
                    stateFor(this).indexBuffer = {
                        bufferId: idFor(buffer),
                        format: indexFormat,
                        offset,
                        size: size ?? null,
                    };
                    nativePassSetIndexBuffer.call(this, buffer, indexFormat, offset, size);
                },
            });

            const nativePassSetVertexBuffer = GPURenderPassEncoder.prototype.setVertexBuffer;
            Object.defineProperty(GPURenderPassEncoder.prototype, "setVertexBuffer", {
                configurable: true,
                writable: true,
                value: function (this: GPURenderPassEncoder, slot: GPUIndex32, buffer: GPUBuffer | null, offset = 0, size?: number): void {
                    const state = stateFor(this);
                    if (buffer) {
                        state.vertexBuffers.set(slot, {
                            slot,
                            bufferId: idFor(buffer),
                            offset,
                            size: size ?? null,
                        });
                    } else {
                        state.vertexBuffers.delete(slot);
                    }
                    nativePassSetVertexBuffer.call(this, slot, buffer, offset, size);
                },
            });

            const nativePassDrawIndexed = GPURenderPassEncoder.prototype.drawIndexed;
            Object.defineProperty(GPURenderPassEncoder.prototype, "drawIndexed", {
                configurable: true,
                writable: true,
                value: function (this: GPURenderPassEncoder, indexCount: GPUSize32, instanceCount = 1, firstIndex = 0, baseVertex = 0, firstInstance = 0): void {
                    const state = stateFor(this);
                    directDraws.push({
                        type: "drawIndexed",
                        indexCount,
                        instanceCount,
                        firstIndex,
                        baseVertex,
                        firstInstance,
                        pipelineId: state.pipelineId,
                        textureIds: textureIdsFor(state),
                        indexBuffer: state.indexBuffer,
                        vertexBuffers: [...state.vertexBuffers.values()].sort((left, right) => left.slot - right.slot),
                    });
                    if (!suppressedDirectIndexCounts.has(indexCount)) {
                        nativePassDrawIndexed.call(this, indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
                    }
                },
            });
            nativeDrawIndexed.call(this, indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
        },
    });

    const nativeFinish = GPURenderBundleEncoder.prototype.finish;
    Object.defineProperty(GPURenderBundleEncoder.prototype, "finish", {
        configurable: true,
        writable: true,
        value: function (this: GPURenderBundleEncoder, descriptor?: GPURenderBundleDescriptor): GPURenderBundle {
            const bundle = nativeFinish.call(this, descriptor);
            const record = encoderRecords.get(this);
            if (record) {
                record.bundleId = idFor(bundle);
                bundleRecords.set(bundle, record);
                finishCount++;
            }
            return bundle;
        },
    });

    const nativeExecuteBundles = GPURenderPassEncoder.prototype.executeBundles;
    Object.defineProperty(GPURenderPassEncoder.prototype, "executeBundles", {
        configurable: true,
        writable: true,
        value: function (this: GPURenderPassEncoder, bundles: Iterable<GPURenderBundle>): void {
            const copiedBundles = Array.from(bundles);
            const bundleIds = copiedBundles.map((bundle) => idFor(bundle));
            const key = bundleIds.join(",");
            const membership = executeMemberships.get(key) ?? { bundleIds, callCount: 0 };
            membership.callCount++;
            executeMemberships.set(key, membership);
            executeBundlesCallCount++;
            nativeExecuteBundles.call(this, copiedBundles);
        },
    });

    const bytesToBase64 = (bytes: Uint8Array): string => {
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return btoa(binary);
    };
    const snapshotBuffer = (record: BufferRecord): ObservedBuffer => ({
        id: record.id,
        label: record.label,
        size: record.size,
        usage: record.usage,
        dataBase64: bytesToBase64(record.data),
    });

    Object.defineProperty(window, "__playroomRenderBundleObservation", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: (): RenderBundleObservation => {
            const executedBundleIds = new Set([...executeMemberships.values()].flatMap((membership) => membership.bundleIds));
            const executedRecords = encoderRecordList.filter(
                (record): record is EncoderRecord & { bundleId: number } => record.bundleId !== null && executedBundleIds.has(record.bundleId)
            );
            const usedBufferIds = new Set<number>();
            const usedPipelineIds = new Set<number>();
            for (const record of executedRecords) {
                for (const draw of record.draws) {
                    if (draw.pipelineId !== null) {
                        usedPipelineIds.add(draw.pipelineId);
                    }
                    if (draw.indexBuffer) {
                        usedBufferIds.add(draw.indexBuffer.bufferId);
                    }
                    for (const vertexBuffer of draw.vertexBuffers) {
                        usedBufferIds.add(vertexBuffer.bufferId);
                    }
                }
            }
            for (const draw of directDraws) {
                if (draw.pipelineId !== null) {
                    usedPipelineIds.add(draw.pipelineId);
                }
                if (draw.indexBuffer) {
                    usedBufferIds.add(draw.indexBuffer.bufferId);
                }
                for (const vertexBuffer of draw.vertexBuffers) {
                    usedBufferIds.add(vertexBuffer.bufferId);
                }
            }
            return {
                schemaVersion: 1,
                createRenderBundleEncoderCount,
                finishCount,
                executeBundlesCallCount,
                executeBundlesMemberships: [...executeMemberships.values()].map((membership) => ({
                    bundleIds: [...membership.bundleIds],
                    callCount: membership.callCount,
                })),
                executedBundles: executedRecords.map((record) => ({
                    encoderId: record.encoderId,
                    bundleId: record.bundleId,
                    descriptor: {
                        colorFormats: [...record.descriptor.colorFormats],
                        depthStencilFormat: record.descriptor.depthStencilFormat,
                        sampleCount: record.descriptor.sampleCount,
                    },
                    draws: record.draws.map((draw) => ({
                        ...draw,
                        indexBuffer: draw.indexBuffer ? { ...draw.indexBuffer } : null,
                        vertexBuffers: draw.vertexBuffers.map((vertexBuffer) => ({ ...vertexBuffer })),
                    })),
                })),
                directDraws: directDraws.map((draw) => ({
                    ...draw,
                    indexBuffer: draw.indexBuffer ? { ...draw.indexBuffer } : null,
                    vertexBuffers: draw.vertexBuffers.map((vertexBuffer) => ({ ...vertexBuffer })),
                })),
                pipelines: [...usedPipelineIds]
                    .sort((left, right) => left - right)
                    .map((id) => pipelineRecordsById.get(id))
                    .filter((record): record is ObservedPipeline => record !== undefined)
                    .map((record) => ({
                        ...record,
                        vertexBuffers: record.vertexBuffers.map((buffer) => ({ ...buffer })),
                        primitive: { ...record.primitive },
                        depthStencil: record.depthStencil ? { ...record.depthStencil } : null,
                        blend: record.blend
                            ? {
                                  color: { ...record.blend.color },
                                  alpha: { ...record.blend.alpha },
                              }
                            : null,
                    })),
                buffers: [...usedBufferIds]
                    .sort((left, right) => left - right)
                    .map((id) => bufferRecordsById.get(id))
                    .filter((record): record is BufferRecord => record !== undefined)
                    .map(snapshotBuffer),
                createdBuffers: [...bufferRecordsById.values()].sort((left, right) => left.id - right.id).map(snapshotBuffer),
            };
        },
    });
    Object.defineProperty(window, "__playroomObservedBufferId", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: (buffer: GPUBuffer): number => idFor(buffer),
    });
    Object.defineProperty(window, "__playroomReadObservedBufferFloats", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: async (bufferId: number, byteOffset: number, floatCount: number): Promise<number[]> => {
            const source = buffersById.get(bufferId);
            if (!source) {
                throw new Error(`Observed GPU buffer ${bufferId} does not exist.`);
            }
            const byteLength = floatCount * Float32Array.BYTES_PER_ELEMENT;
            if (!observed.device) {
                throw new Error("Observed WebGPU device is unavailable.");
            }
            const readback = observed.device.createBuffer({
                size: byteLength,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
            const encoder = observed.device.createCommandEncoder();
            encoder.copyBufferToBuffer(source, byteOffset, readback, 0, byteLength);
            observed.device.queue.submit([encoder.finish()]);
            await readback.mapAsync(GPUMapMode.READ);
            const values = Array.from(new Float32Array(readback.getMappedRange().slice(0)));
            readback.unmap();
            readback.destroy();
            return values;
        },
    });
    Object.defineProperty(window, "__playroomObservedTextureId", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: (texture: GPUTexture): number => idFor(texture),
    });
    Object.defineProperty(window, "__playroomReadObservedTextureFloats", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: async (textureId: number, floatCount: number): Promise<number[]> => {
            const source = texturesById.get(textureId);
            if (!source || source.format !== "rgba32float" || source.height !== 1) {
                throw new Error(`Observed readable rgba32float texture ${textureId} does not exist.`);
            }
            if (!observed.device) {
                throw new Error("Observed WebGPU device is unavailable.");
            }
            const rowBytes = source.width * 4 * Float32Array.BYTES_PER_ELEMENT;
            const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
            const readback = observed.device.createBuffer({
                size: bytesPerRow,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
            const encoder = observed.device.createCommandEncoder();
            encoder.copyTextureToBuffer({ texture: source.texture }, { buffer: readback, bytesPerRow }, { width: source.width, height: 1 });
            observed.device.queue.submit([encoder.finish()]);
            await readback.mapAsync(GPUMapMode.READ);
            const values = Array.from(new Float32Array(readback.getMappedRange().slice(0, floatCount * Float32Array.BYTES_PER_ELEMENT)));
            readback.unmap();
            readback.destroy();
            return values;
        },
    });
    Object.defineProperty(window, "__playroomSuppressDirectDraw", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: (indexCount: number, suppress: boolean): void => {
            if (suppress) {
                suppressedDirectIndexCounts.add(indexCount);
            } else {
                suppressedDirectIndexCounts.delete(indexCount);
            }
        },
    });
}
