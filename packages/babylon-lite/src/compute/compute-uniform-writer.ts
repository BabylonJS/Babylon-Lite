import { DV, F32, I32, U32 } from "../engine/typed-arrays.js";
import type { ComputeUniformArena } from "./compute-uniform-arena.js";
import { getComputeUniformSlotOffset } from "./compute-uniform-arena.js";

declare const computeUniformLayoutBrand: unique symbol;
declare const computeUniformWriterBrand: unique symbol;

const SCALAR_F32 = 0;
const SCALAR_U32 = 1;
const SCALAR_I32 = 2;
const SCALAR_F16 = 3;
const FIELD_SCALAR = 0;
const FIELD_VECTOR = 1;
const FIELD_MATRIX = 2;

type ScalarKind = typeof SCALAR_F32 | typeof SCALAR_U32 | typeof SCALAR_I32 | typeof SCALAR_F16;
type FieldKind = typeof FIELD_SCALAR | typeof FIELD_VECTOR | typeof FIELD_MATRIX;

interface ComputeUniformFieldSlot {
    readonly type: ComputeUniformType;
    readonly offset: number;
    readonly byteLength: number;
    readonly elementCount: number;
    readonly rowCount: number;
    readonly columnStride: number;
    readonly scalar: ScalarKind;
    readonly kind: FieldKind;
}

/** Scalar types supported by typed compute-uniform writers. */
export type ComputeUniformScalarType = "f32" | "u32" | "i32" | "f16";
/** Vector types supported by typed compute-uniform writers. */
export type ComputeUniformVectorType = `vec${2 | 3 | 4}<${ComputeUniformScalarType}>`;
/** Matrix types supported by typed compute-uniform writers. */
export type ComputeUniformMatrixType = `mat${2 | 3 | 4}x${2 | 3 | 4}<${"f32" | "f16"}>`;
/** WGSL host-shareable types supported by typed compute-uniform writers. */
export type ComputeUniformType = ComputeUniformScalarType | ComputeUniformVectorType | ComputeUniformMatrixType;

/** One named field in a typed compute-uniform layout. */
export interface ComputeUniformField {
    readonly name: string;
    readonly type: ComputeUniformType;
}

/** Precomputed WGSL uniform-address-space layout. */
export interface ComputeUniformLayout {
    readonly [computeUniformLayoutBrand]: true;
    readonly byteLength: number;
    /** @internal */
    readonly _fields: ReadonlyMap<string, ComputeUniformFieldSlot>;
}

/** Allocation-free writer targeting one slot of a task-owned uniform arena. */
export interface ComputeUniformWriter {
    readonly [computeUniformWriterBrand]: true;
    readonly arena: ComputeUniformArena;
    readonly slot: number;
    readonly layout: ComputeUniformLayout;
    /** @internal */
    readonly _baseOffset: number;
    /** @internal */
    readonly _f32: Float32Array;
    /** @internal */
    readonly _u32: Uint32Array;
    /** @internal */
    readonly _i32: Int32Array;
    /** @internal */
    readonly _dataView: DataView;
    /** @internal */
    readonly _f16Scratch?: DataView;
}

type ComputeUniformF16Write = (writer: ComputeUniformWriter, byteOffset: number, value: number) => void;
let _writeF16: ComputeUniformF16Write | null = null;

/** @internal Install binary16 conversion from the opt-in f16 writer module. */
export function _installComputeUniformF16Write(write: ComputeUniformF16Write): void {
    _writeF16 = write;
}

function alignUp(value: number, alignment: number): number {
    return (value + alignment - 1) & ~(alignment - 1);
}

function scalarKind(type: string): ScalarKind | -1 {
    return type === "f32" ? SCALAR_F32 : type === "u32" ? SCALAR_U32 : type === "i32" ? SCALAR_I32 : type === "f16" ? SCALAR_F16 : -1;
}

function scalarByteLength(scalar: ScalarKind): number {
    return scalar === SCALAR_F16 ? 2 : 4;
}

function createFieldSlot(type: ComputeUniformType, offset: number): ComputeUniformFieldSlot {
    const scalar = scalarKind(type);
    if (scalar !== -1) {
        const byteLength = scalarByteLength(scalar);
        return Object.freeze({
            type,
            offset: alignUp(offset, byteLength),
            byteLength,
            elementCount: 1,
            rowCount: 1,
            columnStride: byteLength,
            scalar,
            kind: FIELD_SCALAR,
        });
    }

    const vector = /^vec([234])<(f32|u32|i32|f16)>$/.exec(type);
    if (vector) {
        const elementCount = Number(vector[1]);
        const vectorScalar = scalarKind(vector[2]!);
        const elementByteLength = scalarByteLength(vectorScalar as ScalarKind);
        const alignment = elementCount === 2 ? elementByteLength * 2 : elementByteLength * 4;
        return Object.freeze({
            type,
            offset: alignUp(offset, alignment),
            byteLength: elementCount * elementByteLength,
            elementCount,
            rowCount: elementCount,
            columnStride: elementCount * elementByteLength,
            scalar: vectorScalar as ScalarKind,
            kind: FIELD_VECTOR,
        });
    }

    const matrix = /^mat([234])x([234])<(f32|f16)>$/.exec(type);
    if (matrix) {
        const columnCount = Number(matrix[1]);
        const rowCount = Number(matrix[2]);
        const matrixScalar = scalarKind(matrix[3]!) as ScalarKind;
        const elementByteLength = scalarByteLength(matrixScalar);
        const alignment = rowCount === 2 ? elementByteLength * 2 : elementByteLength * 4;
        const columnStride = alignUp(rowCount * elementByteLength, alignment);
        return Object.freeze({
            type,
            offset: alignUp(offset, alignment),
            byteLength: columnCount * columnStride,
            elementCount: columnCount * rowCount,
            rowCount,
            columnStride,
            scalar: matrixScalar,
            kind: FIELD_MATRIX,
        });
    }

    throw new Error(`ComputeUniformLayout: unsupported field type "${type}".`);
}

/** Precompute offsets and setter metadata for a WGSL uniform struct. */
export function createComputeUniformLayout(fields: readonly ComputeUniformField[]): ComputeUniformLayout {
    if (fields.length === 0) {
        throw new Error("ComputeUniformLayout requires at least one field.");
    }
    const slots = new Map<string, ComputeUniformFieldSlot>();
    let cursor = 0;
    for (const field of fields) {
        if (!field.name) {
            throw new Error("ComputeUniformLayout: field name must not be empty.");
        }
        if (slots.has(field.name)) {
            throw new Error(`ComputeUniformLayout: duplicate field "${field.name}".`);
        }
        const slot = createFieldSlot(field.type, cursor);
        slots.set(field.name, slot);
        cursor = slot.offset + slot.byteLength;
    }
    const layout = {} as ComputeUniformLayout;
    Object.defineProperties(layout, {
        byteLength: { value: alignUp(cursor, 16), enumerable: true },
        _fields: { value: slots },
    });
    return Object.freeze(layout);
}

/** Create an allocation-free typed writer for one arena slot. */
export function createComputeUniformWriter(arena: ComputeUniformArena, slot: number, layout: ComputeUniformLayout): ComputeUniformWriter {
    return _createComputeUniformWriter(arena, slot, layout);
}

/** @internal Create a writer, optionally with binary16 scratch storage. */
export function _createComputeUniformWriter(arena: ComputeUniformArena, slot: number, layout: ComputeUniformLayout, f16Scratch?: DataView): ComputeUniformWriter {
    const baseOffset = getComputeUniformSlotOffset(arena, slot);
    if (layout.byteLength > arena.slotByteLength) {
        throw new Error(`ComputeUniformWriter: layout requires ${layout.byteLength} bytes but arena slots contain ${arena.slotByteLength} bytes.`);
    }
    const data = arena.buffer._data!;
    for (const field of layout._fields.values()) {
        if (field.scalar === SCALAR_F16 && !f16Scratch) {
            throw new Error("ComputeUniformWriter: f16 fields require createComputeUniformF16Writer.");
        }
        if (field.scalar === SCALAR_F16) {
            break;
        }
    }
    const writer = {} as ComputeUniformWriter;
    Object.defineProperties(writer, {
        arena: { value: arena, enumerable: true },
        slot: { value: slot, enumerable: true },
        layout: { value: layout, enumerable: true },
        _baseOffset: { value: baseOffset },
        _f32: { value: new F32(data.buffer, data.byteOffset, data.byteLength / 4) },
        _u32: { value: new U32(data.buffer, data.byteOffset, data.byteLength / 4) },
        _i32: { value: new I32(data.buffer, data.byteOffset, data.byteLength / 4) },
        _dataView: { value: new DV(data.buffer, data.byteOffset, data.byteLength) },
        _f16Scratch: { value: f16Scratch },
    });
    return Object.freeze(writer);
}

function getField(writer: ComputeUniformWriter, name: string): ComputeUniformFieldSlot {
    if (writer.arena._destroyed || writer.arena.buffer._destroyed || !writer.arena.buffer._data) {
        throw new Error("ComputeUniformWriter targets a disposed uniform arena.");
    }
    const field = writer.layout._fields.get(name);
    if (!field) {
        throw new Error(`ComputeUniformWriter: field "${name}" was not declared.`);
    }
    return field;
}

function expectFieldKind(field: ComputeUniformFieldSlot, kind: FieldKind, setter: string): void {
    if (field.kind !== kind) {
        throw new Error(`${setter}: field type ${field.type} is not supported by this setter.`);
    }
}

function expectScalar(field: ComputeUniformFieldSlot, scalar: ScalarKind, setter: string): void {
    if (field.kind !== FIELD_SCALAR || field.scalar !== scalar) {
        throw new Error(`${setter}: field type ${field.type} does not match this setter.`);
    }
}

function markDirty(writer: ComputeUniformWriter, field: ComputeUniformFieldSlot): void {
    const start = (writer._baseOffset + field.offset) & ~3;
    const end = alignUp(writer._baseOffset + field.offset + field.byteLength, 4);
    writer.arena._dirtyStart = Math.min(writer.arena._dirtyStart, start);
    writer.arena._dirtyEnd = Math.max(writer.arena._dirtyEnd, end);
}

function writeElement(writer: ComputeUniformWriter, scalar: ScalarKind, byteOffset: number, value: number): void {
    if (scalar === SCALAR_F32) {
        writer._f32[byteOffset >> 2] = value;
    } else if (scalar === SCALAR_U32) {
        writer._u32[byteOffset >> 2] = value;
    } else if (scalar === SCALAR_I32) {
        writer._i32[byteOffset >> 2] = value;
    } else {
        if (!_writeF16 || !writer._f16Scratch) {
            throw new Error("ComputeUniformWriter: f16 writes require createComputeUniformF16Writer.");
        }
        _writeF16(writer, byteOffset, value);
    }
}

function writeScalar(writer: ComputeUniformWriter, field: ComputeUniformFieldSlot, value: number): void {
    writeElement(writer, field.scalar, writer._baseOffset + field.offset, value);
    markDirty(writer, field);
}

function expectElementCount(field: ComputeUniformFieldSlot, value: ArrayLike<number>, setter: string): void {
    if (value.length !== field.elementCount) {
        throw new Error(`${setter}: field "${field.type}" expects ${field.elementCount} values, received ${value.length}.`);
    }
}

function writeVector(writer: ComputeUniformWriter, field: ComputeUniformFieldSlot, value: ArrayLike<number>): void {
    const elementByteLength = scalarByteLength(field.scalar);
    let byteOffset = writer._baseOffset + field.offset;
    for (let i = 0; i < field.elementCount; i++, byteOffset += elementByteLength) {
        writeElement(writer, field.scalar, byteOffset, value[i]!);
    }
    markDirty(writer, field);
}

function writeMatrix(writer: ComputeUniformWriter, field: ComputeUniformFieldSlot, value: ArrayLike<number>): void {
    const elementByteLength = scalarByteLength(field.scalar);
    const columnCount = field.elementCount / field.rowCount;
    let sourceIndex = 0;
    for (let column = 0; column < columnCount; column++) {
        let byteOffset = writer._baseOffset + field.offset + column * field.columnStride;
        for (let row = 0; row < field.rowCount; row++, byteOffset += elementByteLength) {
            writeElement(writer, field.scalar, byteOffset, value[sourceIndex++]!);
        }
    }
    markDirty(writer, field);
}

/** Set one declared `f32` scalar. */
export function setComputeUniformF32(writer: ComputeUniformWriter, name: string, value: number): void {
    const field = getField(writer, name);
    expectScalar(field, SCALAR_F32, "setComputeUniformF32");
    writeScalar(writer, field, value);
}

/** Set one declared `u32` scalar. */
export function setComputeUniformU32(writer: ComputeUniformWriter, name: string, value: number): void {
    const field = getField(writer, name);
    expectScalar(field, SCALAR_U32, "setComputeUniformU32");
    writeScalar(writer, field, value);
}

/** Set one declared `i32` scalar. */
export function setComputeUniformI32(writer: ComputeUniformWriter, name: string, value: number): void {
    const field = getField(writer, name);
    expectScalar(field, SCALAR_I32, "setComputeUniformI32");
    writeScalar(writer, field, value);
}

/** Set one declared `f16` scalar. */
export function setComputeUniformF16(writer: ComputeUniformWriter, name: string, value: number): void {
    const field = getField(writer, name);
    expectScalar(field, SCALAR_F16, "setComputeUniformF16");
    writeScalar(writer, field, value);
}

/** Set one declared vector from an exactly sized array-like value. */
export function setComputeUniformVector(writer: ComputeUniformWriter, name: string, value: ArrayLike<number>): void {
    const field = getField(writer, name);
    expectFieldKind(field, FIELD_VECTOR, "setComputeUniformVector");
    expectElementCount(field, value, "setComputeUniformVector");
    writeVector(writer, field, value);
}

/** Set one declared column-major matrix from an exactly sized array-like value. */
export function setComputeUniformMatrix(writer: ComputeUniformWriter, name: string, value: ArrayLike<number>): void {
    const field = getField(writer, name);
    expectFieldKind(field, FIELD_MATRIX, "setComputeUniformMatrix");
    expectElementCount(field, value, "setComputeUniformMatrix");
    writeMatrix(writer, field, value);
}

/** Generic validated convenience setter. Specialized setters avoid category dispatch. */
export function setComputeUniform(writer: ComputeUniformWriter, name: string, value: number | ArrayLike<number>): void {
    const field = getField(writer, name);
    if (field.kind === FIELD_SCALAR) {
        if (typeof value === "number") {
            writeScalar(writer, field, value);
            return;
        }
        expectElementCount(field, value, "setComputeUniform");
        writeScalar(writer, field, value[0]!);
        return;
    }
    if (typeof value === "number") {
        throw new Error(`setComputeUniform: field "${field.type}" expects ${field.elementCount} values, received 1.`);
    }
    expectElementCount(field, value, "setComputeUniform");
    if (field.kind === FIELD_VECTOR) {
        writeVector(writer, field, value);
    } else {
        writeMatrix(writer, field, value);
    }
}
