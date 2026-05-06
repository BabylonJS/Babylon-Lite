import type { EngineContext } from "../engine/engine.js";
import type { EngineContextInternal } from "../engine/engine.js";
import type { Mesh, MeshInternal } from "./mesh.js";
import type { Mat4 } from "../math/types.js";
import type { Material } from "../material/material.js";
import { mat4Invert } from "../math/mat4.js";
import { createMeshFromData } from "./mesh-factories.js";

declare const csgSolidBrand: unique symbol;

export interface CsgSolid {
    readonly [csgSolidBrand]: true;
}

interface CsgSolidInternal extends CsgSolid {
    readonly _polygons: readonly CsgPolygon[];
}

interface CsgVertex {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly nx: number;
    readonly ny: number;
    readonly nz: number;
    readonly u: number;
    readonly v: number;
}

class CsgPlane {
    constructor(
        public nx: number,
        public ny: number,
        public nz: number,
        public w: number
    ) {}

    clone(): CsgPlane {
        return new CsgPlane(this.nx, this.ny, this.nz, this.w);
    }

    flip(): void {
        this.nx = -this.nx;
        this.ny = -this.ny;
        this.nz = -this.nz;
        this.w = -this.w;
    }
}

class CsgPolygon {
    public plane: CsgPlane;

    constructor(
        public vertices: CsgVertex[],
        public readonly materialSlot = 0
    ) {
        this.plane = planeFromVertices(vertices[0]!, vertices[1]!, vertices[2]!);
    }

    clone(): CsgPolygon {
        return new CsgPolygon(this.vertices.map(cloneVertex), this.materialSlot);
    }

    flip(): void {
        this.vertices.reverse();
        this.vertices = this.vertices.map((v) => ({ ...v, nx: -v.nx, ny: -v.ny, nz: -v.nz }));
        this.plane.flip();
    }
}

class CsgNode {
    private plane: CsgPlane | null = null;
    private polygons: CsgPolygon[] = [];
    private front: CsgNode | null = null;
    private back: CsgNode | null = null;

    constructor(polygons: CsgPolygon[] = []) {
        if (polygons.length > 0) {
            this.build(polygons);
        }
    }

    clone(): CsgNode {
        const node = new CsgNode();
        node.plane = this.plane?.clone() ?? null;
        node.polygons = this.polygons.map((p) => p.clone());
        node.front = this.front?.clone() ?? null;
        node.back = this.back?.clone() ?? null;
        return node;
    }

    invert(): void {
        for (const polygon of this.polygons) {
            polygon.flip();
        }
        this.plane?.flip();
        this.front?.invert();
        this.back?.invert();
        const temp = this.front;
        this.front = this.back;
        this.back = temp;
    }

    clipPolygons(polygons: CsgPolygon[]): CsgPolygon[] {
        if (!this.plane) {
            return polygons.map((p) => p.clone());
        }
        let front: CsgPolygon[] = [];
        let back: CsgPolygon[] = [];
        for (const polygon of polygons) {
            splitPolygon(this.plane, polygon, front, back, front, back);
        }
        if (this.front) {
            front = this.front.clipPolygons(front);
        }
        if (this.back) {
            back = this.back.clipPolygons(back);
        } else {
            back = [];
        }
        return front.concat(back);
    }

    clipTo(other: CsgNode): void {
        this.polygons = other.clipPolygons(this.polygons);
        this.front?.clipTo(other);
        this.back?.clipTo(other);
    }

    allPolygons(): CsgPolygon[] {
        let polygons = this.polygons.map((p) => p.clone());
        if (this.front) {
            polygons = polygons.concat(this.front.allPolygons());
        }
        if (this.back) {
            polygons = polygons.concat(this.back.allPolygons());
        }
        return polygons;
    }

    build(polygons: CsgPolygon[]): void {
        if (polygons.length === 0) {
            return;
        }
        if (!this.plane) {
            this.plane = polygons[0]!.plane.clone();
        }
        const front: CsgPolygon[] = [];
        const back: CsgPolygon[] = [];
        for (const polygon of polygons) {
            splitPolygon(this.plane, polygon, this.polygons, this.polygons, front, back);
        }
        if (front.length > 0) {
            if (!this.front) {
                this.front = new CsgNode();
            }
            this.front.build(front);
        }
        if (back.length > 0) {
            if (!this.back) {
                this.back = new CsgNode();
            }
            this.back.build(back);
        }
    }
}

const EPSILON = 1e-5;
const COPLANAR = 0;
const FRONT = 1;
const BACK = 2;
const SPANNING = 3;

function cloneVertex(v: CsgVertex): CsgVertex {
    return { x: v.x, y: v.y, z: v.z, nx: v.nx, ny: v.ny, nz: v.nz, u: v.u, v: v.v };
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
    const len = Math.hypot(x, y, z);
    if (len <= 1e-20) {
        return [0, 1, 0];
    }
    return [x / len, y / len, z / len];
}

function planeFromVertices(a: CsgVertex, b: CsgVertex, c: CsgVertex): CsgPlane {
    const bax = b.x - a.x;
    const bay = b.y - a.y;
    const baz = b.z - a.z;
    const cax = c.x - a.x;
    const cay = c.y - a.y;
    const caz = c.z - a.z;
    const [nx, ny, nz] = normalize3(cay * baz - caz * bay, caz * bax - cax * baz, cax * bay - cay * bax);
    return new CsgPlane(nx, ny, nz, nx * a.x + ny * a.y + nz * a.z);
}

function triangleArea2(a: CsgVertex, b: CsgVertex, c: CsgVertex): number {
    const bax = b.x - a.x;
    const bay = b.y - a.y;
    const baz = b.z - a.z;
    const cax = c.x - a.x;
    const cay = c.y - a.y;
    const caz = c.z - a.z;
    const cx = bay * caz - baz * cay;
    const cy = baz * cax - bax * caz;
    const cz = bax * cay - bay * cax;
    return cx * cx + cy * cy + cz * cz;
}

function interpolateVertex(a: CsgVertex, b: CsgVertex, t: number): CsgVertex {
    const nx = a.nx + (b.nx - a.nx) * t;
    const ny = a.ny + (b.ny - a.ny) * t;
    const nz = a.nz + (b.nz - a.nz) * t;
    const [nnx, nny, nnz] = normalize3(nx, ny, nz);
    return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
        nx: nnx,
        ny: nny,
        nz: nnz,
        u: a.u + (b.u - a.u) * t,
        v: a.v + (b.v - a.v) * t,
    };
}

function splitPolygon(plane: CsgPlane, polygon: CsgPolygon, coplanarFront: CsgPolygon[], coplanarBack: CsgPolygon[], front: CsgPolygon[], back: CsgPolygon[]): void {
    let polygonType = 0;
    const types: number[] = [];
    for (const vertex of polygon.vertices) {
        const t = plane.nx * vertex.x + plane.ny * vertex.y + plane.nz * vertex.z - plane.w;
        const type = t < -EPSILON ? BACK : t > EPSILON ? FRONT : COPLANAR;
        polygonType |= type;
        types.push(type);
    }

    if (polygonType === COPLANAR) {
        const facing = plane.nx * polygon.plane.nx + plane.ny * polygon.plane.ny + plane.nz * polygon.plane.nz;
        (facing > 0 ? coplanarFront : coplanarBack).push(polygon);
        return;
    }
    if (polygonType === FRONT) {
        front.push(polygon);
        return;
    }
    if (polygonType === BACK) {
        back.push(polygon);
        return;
    }

    const frontVertices: CsgVertex[] = [];
    const backVertices: CsgVertex[] = [];
    for (let i = 0; i < polygon.vertices.length; i++) {
        const j = (i + 1) % polygon.vertices.length;
        const vi = polygon.vertices[i]!;
        const vj = polygon.vertices[j]!;
        const ti = types[i]!;
        const tj = types[j]!;
        if (ti !== BACK) {
            frontVertices.push(cloneVertex(vi));
        }
        if (ti !== FRONT) {
            backVertices.push(cloneVertex(vi));
        }
        if ((ti | tj) === SPANNING) {
            const denom = plane.nx * (vj.x - vi.x) + plane.ny * (vj.y - vi.y) + plane.nz * (vj.z - vi.z);
            if (Math.abs(denom) > 1e-20) {
                const t = (plane.w - plane.nx * vi.x - plane.ny * vi.y - plane.nz * vi.z) / denom;
                const vertex = interpolateVertex(vi, vj, t);
                frontVertices.push(vertex);
                backVertices.push(cloneVertex(vertex));
            }
        }
    }
    if (frontVertices.length >= 3) {
        front.push(new CsgPolygon(frontVertices, polygon.materialSlot));
    }
    if (backVertices.length >= 3) {
        back.push(new CsgPolygon(backVertices, polygon.materialSlot));
    }
}

function solidFromPolygons(polygons: CsgPolygon[]): CsgSolid {
    return { _polygons: polygons } as unknown as CsgSolidInternal;
}

function internalSolid(solid: CsgSolid): CsgSolidInternal {
    return solid as CsgSolidInternal;
}

function clonePolygons(solid: CsgSolid): CsgPolygon[] {
    return internalSolid(solid)._polygons.map((p) => p.clone());
}

function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
    return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
}

function transformNormal(m: Mat4, inv: Mat4 | null, x: number, y: number, z: number): [number, number, number] {
    if (inv) {
        return normalize3(inv[0]! * x + inv[1]! * y + inv[2]! * z, inv[4]! * x + inv[5]! * y + inv[6]! * z, inv[8]! * x + inv[9]! * y + inv[10]! * z);
    }
    return normalize3(m[0]! * x + m[4]! * y + m[8]! * z, m[1]! * x + m[5]! * y + m[9]! * z, m[2]! * x + m[6]! * y + m[10]! * z);
}

function requireCpuGeometry(mesh: Mesh): MeshInternal {
    const internal = mesh as MeshInternal;
    if (!internal._cpuPositions) {
        throw new Error(`createCsgFromMesh("${mesh.name}") requires CPU positions. Use a Babylon Lite mesh factory or loader that retains CPU geometry.`);
    }
    if (!internal._cpuIndices) {
        throw new Error(`createCsgFromMesh("${mesh.name}") requires CPU indices. Use a Babylon Lite mesh factory or loader that retains CPU geometry.`);
    }
    if (!internal._cpuNormals) {
        throw new Error(`createCsgFromMesh("${mesh.name}") requires CPU normals. Use a Babylon Lite mesh factory or loader that retains CPU geometry.`);
    }
    return internal;
}

export function createCsgFromMesh(mesh: Mesh, materialSlot = 0): CsgSolid {
    const internal = requireCpuGeometry(mesh);
    const positions = internal._cpuPositions!;
    const normals = internal._cpuNormals!;
    const indices = internal._cpuIndices!;
    const uvs = internal._cpuUvs;
    const world = mesh.worldMatrix;
    const invWorld = mat4Invert(world);
    const polygons: CsgPolygon[] = [];

    for (let i = 0; i < indices.length; i += 3) {
        const vertices: CsgVertex[] = [];
        for (let corner = 0; corner < 3; corner++) {
            const index = indices[i + corner]!;
            const p = index * 3;
            const uv = index * 2;
            const [x, y, z] = transformPoint(world, positions[p]!, positions[p + 1]!, positions[p + 2]!);
            const [nx, ny, nz] = transformNormal(world, invWorld, normals[p]!, normals[p + 1]!, normals[p + 2]!);
            vertices.push({ x, y, z, nx, ny, nz, u: uvs?.[uv] ?? 0, v: uvs?.[uv + 1] ?? 0 });
        }
        if (triangleArea2(vertices[0]!, vertices[1]!, vertices[2]!) <= EPSILON * EPSILON) {
            continue;
        }
        polygons.push(new CsgPolygon(vertices, materialSlot));
    }

    return solidFromPolygons(polygons);
}

export function csgUnion(a: CsgSolid, b: CsgSolid): CsgSolid {
    const an = new CsgNode(clonePolygons(a));
    const bn = new CsgNode(clonePolygons(b));
    an.clipTo(bn);
    bn.clipTo(an);
    bn.invert();
    bn.clipTo(an);
    bn.invert();
    an.build(bn.allPolygons());
    return solidFromPolygons(an.allPolygons());
}

export function csgSubtract(a: CsgSolid, b: CsgSolid): CsgSolid {
    const an = new CsgNode(clonePolygons(a));
    const bn = new CsgNode(clonePolygons(b));
    an.invert();
    an.clipTo(bn);
    bn.clipTo(an);
    bn.invert();
    bn.clipTo(an);
    bn.invert();
    an.build(bn.allPolygons());
    an.invert();
    return solidFromPolygons(an.allPolygons());
}

export function csgIntersect(a: CsgSolid, b: CsgSolid): CsgSolid {
    const an = new CsgNode(clonePolygons(a));
    const bn = new CsgNode(clonePolygons(b));
    an.invert();
    bn.clipTo(an);
    bn.invert();
    an.clipTo(bn);
    bn.clipTo(an);
    an.build(bn.allPolygons());
    an.invert();
    return solidFromPolygons(an.allPolygons());
}

function createMeshFromPolygons(engine: EngineContext, polygons: readonly CsgPolygon[], name: string): Mesh {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    for (const polygon of polygons) {
        const base = positions.length / 3;
        for (const vertex of polygon.vertices) {
            positions.push(vertex.x, vertex.y, vertex.z);
            normals.push(vertex.nx, vertex.ny, vertex.nz);
            uvs.push(vertex.u, vertex.v);
        }
        for (let i = 2; i < polygon.vertices.length; i++) {
            indices.push(base, base + i - 1, base + i);
        }
    }

    return createMeshFromData(engine as EngineContextInternal, name, new Float32Array(positions), new Float32Array(normals), new Uint32Array(indices), new Float32Array(uvs));
}

export function createMeshFromCsg(engine: EngineContext, solid: CsgSolid, name = "csg"): Mesh {
    return createMeshFromPolygons(engine, internalSolid(solid)._polygons, name);
}

export function createMeshesFromCsg(engine: EngineContext, solid: CsgSolid, materials: readonly Material[], name = "csg"): Mesh[] {
    const polygons = internalSolid(solid)._polygons;
    const slots: number[] = [];
    for (const polygon of polygons) {
        if (!slots.includes(polygon.materialSlot)) {
            slots.push(polygon.materialSlot);
        }
    }
    slots.sort((a, b) => a - b);

    const meshes: Mesh[] = [];
    for (const slot of slots) {
        const material = materials[slot];
        if (!material) {
            throw new Error(`createMeshesFromCsg("${name}") missing material for CSG material slot ${slot}.`);
        }
        const slotPolygons = polygons.filter((p) => p.materialSlot === slot);
        const mesh = createMeshFromPolygons(engine, slotPolygons, `${name}_sub${slot}`);
        mesh.material = material;
        meshes.push(mesh);
    }
    return meshes;
}
