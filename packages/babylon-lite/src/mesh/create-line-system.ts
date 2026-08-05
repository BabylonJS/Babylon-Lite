import type { EngineContext } from "../engine/engine.js";
import { computeAabb } from "../math/compute-aabb.js";
import type { Color4, Vec3 } from "../math/types.js";
import type { LineMaterial } from "../material/line/line-material.js";
import { createLineMaterial } from "../material/line/line-material.js";
import type { Mesh } from "./mesh.js";
import { createMeshFromData, updateMeshColors, updateMeshPositions } from "./mesh-factories.js";

export interface LineSystemData {
    readonly positions: Float32Array;
    readonly normals: Float32Array;
    readonly indices: Uint32Array;
    readonly colors?: Float32Array;
    readonly linePointCounts: Uint32Array;
}

export interface LineSystemDataOptions {
    readonly lines: ReadonlyArray<ReadonlyArray<Vec3>>;
    readonly colors?: ReadonlyArray<ReadonlyArray<Color4>>;
}

export interface LineSystemOptions extends LineSystemDataOptions {
    readonly name?: string;
    readonly color?: Color4;
    readonly useVertexAlpha?: boolean;
    readonly useThinInstances?: boolean;
    readonly useThinInstanceColors?: boolean;
    readonly material?: LineMaterial;
}

export interface LinesOptions {
    readonly name?: string;
    readonly points: ReadonlyArray<Vec3>;
    readonly colors?: ReadonlyArray<Color4>;
    readonly color?: Color4;
    readonly useVertexAlpha?: boolean;
    readonly useThinInstances?: boolean;
    readonly useThinInstanceColors?: boolean;
    readonly material?: LineMaterial;
}

export interface LineSystemUpdateOptions extends LineSystemDataOptions {}

function assertFinite(kind: string, value: number): void {
    if (!Number.isFinite(value)) {
        throw new Error(`Line system data requires finite ${kind} components`);
    }
}

function flattenLineAttributes(
    options: LineSystemDataOptions,
    vertexCount: number,
    linePointCounts?: Uint32Array,
    indices?: Uint32Array
): { positions: Float32Array; colors?: Float32Array } {
    const { lines, colors } = options;
    if (colors && colors.length !== lines.length) {
        throw new Error("Line system data requires one color row per line");
    }

    const positions = new Float32Array(vertexCount * 3);
    const vertexColors = colors ? new Float32Array(vertexCount * 4) : undefined;
    let vertex = 0;
    let index = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex]!;
        const lineColors = colors?.[lineIndex];
        if (lineColors && lineColors.length !== line.length) {
            throw new Error("Line system data requires one color per point");
        }
        if (linePointCounts) {
            linePointCounts[lineIndex] = line.length;
        }
        for (let pointIndex = 0; pointIndex < line.length; pointIndex++) {
            const point = line[pointIndex]!;
            assertFinite("position", point.x);
            assertFinite("position", point.y);
            assertFinite("position", point.z);
            const positionOffset = vertex * 3;
            positions[positionOffset] = point.x;
            positions[positionOffset + 1] = point.y;
            positions[positionOffset + 2] = point.z;
            if (vertexColors && lineColors) {
                const color = lineColors[pointIndex]!;
                assertFinite("color", color.r);
                assertFinite("color", color.g);
                assertFinite("color", color.b);
                assertFinite("color", color.a);
                const colorOffset = vertex * 4;
                vertexColors[colorOffset] = color.r;
                vertexColors[colorOffset + 1] = color.g;
                vertexColors[colorOffset + 2] = color.b;
                vertexColors[colorOffset + 3] = color.a;
            }
            if (indices && pointIndex > 0) {
                indices[index++] = vertex - 1;
                indices[index++] = vertex;
            }
            vertex++;
        }
    }
    return { positions, ...(vertexColors ? { colors: vertexColors } : {}) };
}

/** Flatten independent polylines into one indexed line-list geometry. */
export function createLineSystemData(options: LineSystemDataOptions): LineSystemData {
    const { lines } = options;

    let vertexCount = 0;
    let indexCount = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex]!;
        vertexCount += line.length;
        indexCount += Math.max(0, line.length - 1) * 2;
    }
    if (vertexCount === 0) {
        throw new Error("createLineSystemData requires at least one point");
    }

    const normals = new Float32Array(vertexCount * 3);
    const indices = new Uint32Array(indexCount);
    const linePointCounts = new Uint32Array(lines.length);
    const flattened = flattenLineAttributes(options, vertexCount, linePointCounts, indices);

    return {
        positions: flattened.positions,
        normals,
        indices,
        ...(flattened.colors ? { colors: flattened.colors } : {}),
        linePointCounts,
    };
}

/** Create a line-system mesh with an unlit line material unless one is supplied. */
export function createLineSystem(engine: EngineContext, options: LineSystemOptions): Mesh {
    const data = createLineSystemData(options);
    const material =
        options.material ??
        createLineMaterial({
            color: options.color,
            useVertexColor: !!data.colors,
            useVertexAlpha: options.useVertexAlpha,
            useThinInstances: options.useThinInstances,
            useThinInstanceColors: options.useThinInstanceColors,
        });
    if (material.useVertexColor !== !!data.colors) {
        throw new Error("createLineSystem requires material.useVertexColor to match the line color-buffer layout");
    }

    const mesh = createMeshFromData(engine, options.name ?? "lineSystem", data.positions, data.normals, data.indices, undefined, undefined, undefined, data.colors);
    mesh.material = material;
    mesh.hasVertexAlpha = !!data.colors && material.useVertexAlpha;
    mesh._topology = 2;
    mesh._linePointCounts = data.linePointCounts;
    mesh._cpuColors = data.colors ?? null;
    return mesh;
}

/** Create one polyline through the line-system implementation. */
export function createLines(engine: EngineContext, options: LinesOptions): Mesh {
    return createLineSystem(engine, {
        name: options.name ?? "lines",
        lines: [options.points],
        ...(options.colors ? { colors: [options.colors] } : {}),
        color: options.color,
        useVertexAlpha: options.useVertexAlpha,
        useThinInstances: options.useThinInstances,
        useThinInstanceColors: options.useThinInstanceColors,
        material: options.material,
    });
}

/** Update line positions and optional colors without changing line/point counts. */
export function updateLineSystem(engine: EngineContext, mesh: Mesh, options: LineSystemUpdateOptions): void {
    const pointCounts = mesh._linePointCounts;
    if (!pointCounts) {
        throw new Error("updateLineSystem requires a mesh created by createLineSystem");
    }
    if (options.lines.length !== pointCounts.length) {
        throw new Error("updateLineSystem requires unchanged line and point counts");
    }
    for (let i = 0; i < pointCounts.length; i++) {
        if (options.lines[i]!.length !== pointCounts[i]) {
            throw new Error("updateLineSystem requires unchanged line and point counts");
        }
    }
    if (options.colors && !mesh._gpu.colorBuffer) {
        throw new Error("updateLineSystem cannot add colors to a mesh created without vertex colors");
    }

    let vertexCount = 0;
    for (const count of pointCounts) {
        vertexCount += count;
    }
    const data = flattenLineAttributes(options, vertexCount);
    updateMeshPositions(engine, mesh, data.positions);
    if (data.colors) {
        updateMeshColors(engine, mesh, data.colors);
    }

    const [min, max] = computeAabb(data.positions);
    mesh.boundMin = min;
    mesh.boundMax = max;
    mesh._cpuPositions = data.positions;
    if (data.colors) {
        mesh._cpuColors = data.colors;
    }
    engine._dlr?.m(mesh, mesh._cpuUv2s ?? null, mesh._cpuTangents ?? null, mesh._cpuColors ?? null, mesh._cpuIndices!, mesh._cpuIndexFormat ?? "uint32");
}
