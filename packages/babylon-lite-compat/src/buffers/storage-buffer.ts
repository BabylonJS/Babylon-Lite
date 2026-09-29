import { clearStorageBuffer, createStorageBuffer, disposeStorageBuffer, readStorageBufferAfterFrame, updateStorageBufferRange } from "babylon-lite";
import type { StorageBuffer as LiteStorageBuffer } from "babylon-lite";

import type { WebGPUEngine } from "../engine/engine.js";
import { unsupported } from "../error.js";

export type DataArray = number[] | ArrayBufferLike | ArrayBufferView;

function asBytes(data: DataArray, byteLength?: number): Uint8Array {
    let bytes: Uint8Array;
    if (Array.isArray(data)) {
        bytes = new Uint8Array(new Float32Array(data).buffer);
    } else if (ArrayBuffer.isView(data)) {
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
        bytes = new Uint8Array(data);
    }
    if (byteLength === undefined) {
        return bytes;
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > bytes.byteLength) {
        throw new RangeError(`StorageBuffer byteLength must be between 0 and ${bytes.byteLength}; received ${byteLength}.`);
    }
    return bytes.subarray(0, byteLength);
}

/** Babylon.js-shaped wrapper over Lite's public opaque storage allocation. */
export class StorageBuffer {
    /** @internal */
    public _lite: LiteStorageBuffer | null;
    private readonly _copyReadable: boolean;
    private readonly _copyWritable: boolean;

    public constructor(
        private readonly _engine: WebGPUEngine,
        size: number,
        creationFlags = 3,
        label?: string
    ) {
        if ((creationFlags & 4) !== 0) {
            unsupported(
                "StorageBuffer.constructor",
                "Babylon.js can combine storage and uniform usage on one DataBuffer, while Babylon Lite intentionally exposes distinct opaque StorageBuffer and UniformBuffer allocations."
            );
        }
        this._copyReadable = (creationFlags & 1) !== 0;
        this._copyWritable = (creationFlags & 2) !== 0;
        this._lite = createStorageBuffer(_engine._lite, size, {
            label,
            // Every BJS StorageBuffer can be declared read-only or read-write by WGSL.
            // Lite's `writable` flag enables that shader role and also supplies COPY_SRC;
            // the BJS READ flag is enforced independently by read().
            writable: true,
            vertex: (creationFlags & 8) !== 0,
            index: (creationFlags & 16) !== 0,
            indirect: (creationFlags & 64) !== 0,
        });
    }

    /** @internal Lite owns device-loss resource rebuilding. */
    public _rebuild(): void {}

    public getBuffer(): LiteStorageBuffer | null {
        return this._lite;
    }

    public clear(byteOffset = 0, byteLength = this._requireBuffer().byteLength - byteOffset): void {
        this._assertCopyWritable("clear");
        const buffer = this._requireBuffer();
        if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || !Number.isSafeInteger(byteLength) || byteLength < 0 || byteOffset + byteLength > buffer.byteLength) {
            throw new RangeError(`StorageBuffer.clear range [${byteOffset}, ${byteOffset + byteLength}) exceeds the ${buffer.byteLength}-byte buffer.`);
        }
        clearStorageBuffer(this._engine._lite, buffer, byteOffset, byteLength);
    }

    public update(data: DataArray, byteOffset = 0, byteLength?: number): void {
        if (!this._lite) {
            return;
        }
        this._assertCopyWritable("update");
        updateStorageBufferRange(this._engine._lite, this._lite, asBytes(data, byteLength), byteOffset);
    }

    public async read(offset = 0, size = this._requireBuffer().byteLength - offset, buffer?: ArrayBufferView, noDelay = false): Promise<ArrayBufferView> {
        if (!this._copyReadable) {
            throw new Error("StorageBuffer.read requires Constants.BUFFER_CREATIONFLAG_READ.");
        }
        const result = await readStorageBufferAfterFrame(this._requireBuffer(), offset, size, noDelay);
        const bytes = new Uint8Array(result);
        if (!buffer) {
            return bytes;
        }
        if (buffer.byteLength < bytes.byteLength) {
            throw new RangeError(`StorageBuffer.read target has ${buffer.byteLength} bytes but ${bytes.byteLength} bytes were requested.`);
        }
        new Uint8Array(buffer.buffer, buffer.byteOffset, bytes.byteLength).set(bytes);
        return buffer;
    }

    public dispose(): void {
        if (this._lite) {
            disposeStorageBuffer(this._lite);
            this._lite = null;
        }
    }

    /** @internal */
    public _getLiteBuffer(): LiteStorageBuffer {
        return this._requireBuffer();
    }

    private _requireBuffer(): LiteStorageBuffer {
        if (!this._lite) {
            throw new Error("StorageBuffer has been disposed.");
        }
        return this._lite;
    }

    private _assertCopyWritable(operation: string): void {
        if (!this._copyWritable) {
            throw new Error(`StorageBuffer.${operation} requires Constants.BUFFER_CREATIONFLAG_WRITE.`);
        }
    }
}
