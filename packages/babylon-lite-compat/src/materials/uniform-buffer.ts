import { createUniformBuffer, disposeUniformBuffer, updateUniformBuffer } from "babylon-lite";
import type { UniformBuffer as LiteUniformBuffer } from "babylon-lite";

import type { AbstractEngine } from "../engine/engine.js";
import { unsupported } from "../error.js";
import type { BaseTexture } from "../textures/textures.js";

export interface MatrixLike {
    asArray(): ArrayLike<number>;
    readonly updateFlag?: number;
}

export interface Vector3Like {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

export interface Vector4Like extends Vector3Like {
    readonly w: number;
}

export interface Color3Like {
    readonly r: number;
    readonly g: number;
    readonly b: number;
}

export interface Color4Like extends Color3Like {
    readonly a: number;
}

type FloatArray = number[] | Float32Array;

interface UniformArrayLayout {
    readonly strideSize: number;
    readonly arraySize: number;
}

function bitCast(values: readonly number[], unsigned: boolean): Float32Array {
    const result = new Float32Array(values.length);
    const view = unsigned ? new Uint32Array(result.buffer) : new Int32Array(result.buffer);
    for (let i = 0; i < values.length; i++) {
        view[i] = values[i]!;
    }
    return result;
}

/** Minimum Babylon.js UniformBuffer surface needed to author compute bindings. */
export class UniformBuffer {
    private readonly _data: number[];
    private readonly _dynamic: boolean;
    private readonly _uniformLocations = new Map<string, number>();
    private readonly _uniformSizes = new Map<string, number>();
    private readonly _uniformArraySizes = new Map<string, UniformArrayLayout>();
    private readonly _uniformNames: string[] = [];
    private _uniformLocationPointer = 0;
    private _bufferData: Float32Array | null = null;
    private _buffer: LiteUniformBuffer | null = null;
    private _needSync = false;
    private _name: string;

    public constructor(
        private readonly _engine: AbstractEngine,
        data: number[] = [],
        dynamic = false,
        name = "no-name",
        forceNoUniformBuffer = false,
        _trackUBOsInFrame?: boolean
    ) {
        if (forceNoUniformBuffer) {
            unsupported(
                "UniformBuffer.constructor",
                "A forceNoUniformBuffer instance falls back to Effect setters in Babylon.js and therefore has no GPU uniform allocation that Lite compute bindings can consume."
            );
        }
        this._data = data;
        this._dynamic = dynamic;
        this._name = name;
    }

    public readonly updateMatrix3x3 = (name: string, matrix: Float32Array): void => {
        const aligned = new Float32Array(12);
        for (let column = 0; column < 3; column++) {
            aligned.set(matrix.subarray(column * 3, column * 3 + 3), column * 4);
        }
        this.updateUniform(name, aligned, 12);
    };

    public readonly updateMatrix2x2 = (name: string, matrix: Float32Array): void => {
        const aligned = new Float32Array(8);
        for (let column = 0; column < 2; column++) {
            aligned.set(matrix.subarray(column * 2, column * 2 + 2), column * 4);
        }
        this.updateUniform(name, aligned, 8);
    };

    public readonly updateFloat = (name: string, x: number, _suffix?: string): void => this.updateUniform(name, [x], 1);
    public readonly updateFloat2 = (name: string, x: number, y: number, _suffix?: string): void => this.updateUniform(name, [x, y], 2);
    public readonly updateFloat3 = (name: string, x: number, y: number, z: number, _suffix?: string): void => this.updateUniform(name, [x, y, z], 3);
    public readonly updateFloat4 = (name: string, x: number, y: number, z: number, w: number, _suffix?: string): void => this.updateUniform(name, [x, y, z, w], 4);
    public readonly updateFloatArray = (name: string, array: Float32Array, _suffix?: string): void => this.updateUniformArray(name, array, array.length);
    public readonly updateArray = (name: string, array: number[]): void => this.updateUniformArray(name, array, array.length);
    public readonly updateIntArray = (name: string, array: Int32Array): void =>
        this.updateUniformArray(name, new Float32Array(array.buffer, array.byteOffset, array.length), array.length);
    public readonly updateUIntArray = (name: string, array: Uint32Array): void =>
        this.updateUniformArray(name, new Float32Array(array.buffer, array.byteOffset, array.length), array.length);
    public readonly updateMatrix = (name: string, matrix: MatrixLike): void => this.updateUniform(name, Array.from(matrix.asArray()), 16);
    public readonly updateMatrices = (name: string, matrices: Float32Array): void => this.updateUniform(name, matrices, matrices.length);
    public readonly updateVector3 = (name: string, vector: Vector3Like): void => this.updateFloat3(name, vector.x, vector.y, vector.z);
    public readonly updateVector4 = (name: string, vector: Vector4Like): void => this.updateFloat4(name, vector.x, vector.y, vector.z, vector.w);
    public readonly updateColor3 = (name: string, color: Color3Like, suffix?: string): void => this.updateFloat3(name, color.r, color.g, color.b, suffix);
    public readonly updateColor4 = (name: string, color: Color3Like, alpha: number, suffix?: string): void => this.updateFloat4(name, color.r, color.g, color.b, alpha, suffix);
    public readonly updateDirectColor4 = (name: string, color: Color4Like, suffix?: string): void => this.updateFloat4(name, color.r, color.g, color.b, color.a, suffix);
    public readonly updateInt = (name: string, x: number, _suffix?: string): void => this.updateUniform(name, bitCast([x], false), 1);
    public readonly updateInt2 = (name: string, x: number, y: number, _suffix?: string): void => this.updateUniform(name, bitCast([x, y], false), 2);
    public readonly updateInt3 = (name: string, x: number, y: number, z: number, _suffix?: string): void => this.updateUniform(name, bitCast([x, y, z], false), 3);
    public readonly updateInt4 = (name: string, x: number, y: number, z: number, w: number, _suffix?: string): void => this.updateUniform(name, bitCast([x, y, z, w], false), 4);
    public readonly updateUInt = (name: string, x: number, _suffix?: string): void => this.updateUniform(name, bitCast([x], true), 1);
    public readonly updateUInt2 = (name: string, x: number, y: number, _suffix?: string): void => this.updateUniform(name, bitCast([x, y], true), 2);
    public readonly updateUInt3 = (name: string, x: number, y: number, z: number, _suffix?: string): void => this.updateUniform(name, bitCast([x, y, z], true), 3);
    public readonly updateUInt4 = (name: string, x: number, y: number, z: number, w: number, _suffix?: string): void => this.updateUniform(name, bitCast([x, y, z, w], true), 4);

    public get useUbo(): boolean {
        return true;
    }

    public get isSync(): boolean {
        return !this._needSync;
    }

    public isDynamic(): boolean {
        return this._dynamic;
    }

    public getData(): Float32Array {
        return this._bufferData ?? new Float32Array(this._data);
    }

    public getBuffer(): LiteUniformBuffer | null {
        return this._buffer;
    }

    public getUniformNames(): string[] {
        return this._uniformNames.slice();
    }

    public addUniform(name: string, sizeOrData: number | number[], arraySize = 0): void {
        if (this._uniformLocations.has(name)) {
            return;
        }
        if (this._buffer) {
            throw new Error(`Cannot add uniform "${name}" after the UniformBuffer has been created.`);
        }
        this._uniformNames.push(name);
        let size: number;
        let data: number[];
        if (arraySize > 0) {
            if (typeof sizeOrData !== "number") {
                throw new TypeError(`addUniform cannot use inline array data for UBO array "${name}".`);
            }
            this._align(4);
            this._uniformArraySizes.set(name, { strideSize: sizeOrData, arraySize });
            size = sizeOrData === 16 ? sizeOrData * arraySize : 4 * arraySize;
            data = new Array<number>(size).fill(0);
        } else {
            data = typeof sizeOrData === "number" ? new Array<number>(sizeOrData).fill(0) : sizeOrData.slice();
            size = data.length;
            this._align(size);
        }
        this._uniformLocations.set(name, this._uniformLocationPointer);
        this._uniformSizes.set(name, size);
        this._uniformLocationPointer += size;
        this._data.push(...data);
        this._needSync = true;
    }

    public addMatrix(name: string, matrix: MatrixLike): void {
        this.addUniform(name, Array.from(matrix.asArray()));
    }

    public addFloat2(name: string, x: number, y: number): void {
        this.addUniform(name, [x, y]);
    }

    public addFloat3(name: string, x: number, y: number, z: number): void {
        this.addUniform(name, [x, y, z]);
    }

    public addColor3(name: string, color: Color3Like): void {
        this.addUniform(name, [color.r, color.g, color.b]);
    }

    public addColor4(name: string, color: Color3Like, alpha: number): void {
        this.addUniform(name, [color.r, color.g, color.b, alpha]);
    }

    public addVector3(name: string, vector: Vector3Like): void {
        this.addUniform(name, [vector.x, vector.y, vector.z]);
    }

    public addMatrix3x3(name: string): void {
        this.addUniform(name, 12);
    }

    public addMatrix2x2(name: string): void {
        this.addUniform(name, 8);
    }

    public create(): void {
        if (this._buffer) {
            return;
        }
        this._align(4);
        this._bufferData = new Float32Array(this._data);
        this._buffer = createUniformBuffer(this._engine._lite, this._bufferData, { label: `${this._name}_UniformList:${this._uniformNames.slice(0, 10).join(",")}` });
        this._needSync = true;
    }

    /** @internal */
    public _getLiteBuffer(): LiteUniformBuffer {
        this.create();
        return this._buffer!;
    }

    public get name(): string {
        return this._name;
    }

    public set name(value: string) {
        this._name = value;
    }

    public get currentEffect(): unknown | null {
        return null;
    }

    public update(): void {
        this.create();
        if (this._dynamic || this._needSync) {
            updateUniformBuffer(this._engine._lite, this._buffer!, this._bufferData!);
            this._needSync = false;
        }
    }

    public updateUniform(uniformName: string, data: FloatArray, size: number): void {
        let location = this._uniformLocations.get(uniformName);
        if (location === undefined) {
            this.addUniform(uniformName, size);
            location = this._uniformLocations.get(uniformName)!;
        }
        this.create();
        if (size > (this._uniformSizes.get(uniformName) ?? 0)) {
            throw new RangeError(`Uniform "${uniformName}" has room for ${this._uniformSizes.get(uniformName)} floats, not ${size}.`);
        }
        for (let i = 0; i < size; i++) {
            const value = Math.fround(data[i]!);
            if (this._bufferData![location + i] !== value) {
                this._bufferData![location + i] = value;
                this._needSync = true;
            }
        }
    }

    public updateUniformArray(uniformName: string, data: FloatArray, size: number): void {
        const location = this._uniformLocations.get(uniformName);
        const layout = this._uniformArraySizes.get(uniformName);
        if (location === undefined || !layout) {
            throw new Error(`Uniform array "${uniformName}" must be declared with addUniform before it can be updated.`);
        }
        this.create();
        if (size > layout.strideSize * layout.arraySize) {
            throw new RangeError(`Uniform array "${uniformName}" accepts at most ${layout.strideSize * layout.arraySize} values, not ${size}.`);
        }
        for (let i = 0; i < size; i++) {
            const destination = location + Math.floor(i / layout.strideSize) * 4 + (i % layout.strideSize);
            const value = Math.fround(data[i]!);
            if (this._bufferData![destination] !== value) {
                this._bufferData![destination] = value;
                this._needSync = true;
            }
        }
    }

    public setTexture(_name: string, _texture: BaseTexture | null): never {
        return unsupported("UniformBuffer.setTexture", "Lite compute uniform allocations contain bytes only and do not own Effect sampler bindings.");
    }

    public setTextureArray(_name: string, _textures: BaseTexture[]): never {
        return unsupported("UniformBuffer.setTextureArray", "Lite compute uniform allocations contain bytes only and do not own Effect sampler bindings.");
    }

    public bindTexture(_name: string, _texture: unknown | null): never {
        return unsupported("UniformBuffer.bindTexture", "Lite compute uniform allocations contain bytes only and do not own Effect sampler bindings.");
    }

    public updateUniformDirectly(uniformName: string, data: FloatArray): void {
        const size = this._uniformSizes.get(uniformName);
        if (size === undefined) {
            throw new Error(`Uniform "${uniformName}" has not been declared.`);
        }
        this.updateUniform(uniformName, data, Math.min(size, data.length));
        this.update();
    }

    public bindToEffect(_effect: unknown, _name: string): never {
        return unsupported(
            "UniformBuffer.bindToEffect",
            "The compute-only compat UniformBuffer forwards to Lite's opaque compute allocation; Lite has no Babylon.js Effect binding surface."
        );
    }

    public bindUniformBuffer(): never {
        return unsupported("UniformBuffer.bindUniformBuffer", "The compute-only compat UniformBuffer is bound through ComputeShader.setUniformBuffer.");
    }

    public unbindEffect(): void {}

    public setDataBuffer(dataBuffer: LiteUniformBuffer): boolean {
        return this._buffer === dataBuffer;
    }

    public has(name: string): boolean {
        return this._uniformLocations.has(name);
    }

    public dispose(): void {
        if (this._buffer) {
            disposeUniformBuffer(this._buffer);
            this._buffer = null;
        }
    }

    private _align(size: number): void {
        const alignment = size <= 2 ? size : 4;
        if (alignment > 0 && this._uniformLocationPointer % alignment !== 0) {
            const padding = alignment - (this._uniformLocationPointer % alignment);
            this._data.push(...new Array<number>(padding).fill(0));
            this._uniformLocationPointer += padding;
        }
    }
}
