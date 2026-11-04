import { addToScene, createLineMaterial, createLineSystem, createSphere, createStandardMaterial, type EngineContext, type Mesh } from "babylon-lite";

interface Bounds {
    readonly name: string;
    readonly center: readonly [number, number, number];
    readonly size: readonly [number, number, number];
    readonly color: readonly [number, number, number];
    readonly alpha?: number;
}

interface Marker {
    readonly name: string;
    readonly position: readonly [number, number, number];
    readonly color: readonly [number, number, number];
}

export interface Scene186DebugOptions {
    readonly bounds: readonly Bounds[];
    readonly markers: readonly Marker[];
}

function createBoundsWireframe(engine: EngineContext, options: Bounds): Mesh {
    const xMin = options.center[0] - options.size[0] / 2;
    const xMax = options.center[0] + options.size[0] / 2;
    const yMin = options.center[1] - options.size[1] / 2;
    const yMax = options.center[1] + options.size[1] / 2;
    const zMin = options.center[2] - options.size[2] / 2;
    const zMax = options.center[2] + options.size[2] / 2;
    const point = (x: number, y: number, z: number) => ({ x, y, z });
    const corners = [
        point(xMin, yMin, zMin),
        point(xMax, yMin, zMin),
        point(xMax, yMin, zMax),
        point(xMin, yMin, zMax),
        point(xMin, yMax, zMin),
        point(xMax, yMax, zMin),
        point(xMax, yMax, zMax),
        point(xMin, yMax, zMax),
    ];
    const edge = (start: number, end: number) => [corners[start]!, corners[end]!] as const;
    const wireframe = createLineSystem(engine, {
        name: options.name,
        lines: [edge(0, 1), edge(1, 2), edge(2, 3), edge(3, 0), edge(4, 5), edge(5, 6), edge(6, 7), edge(7, 4), edge(0, 4), edge(1, 5), edge(2, 6), edge(3, 7)],
        material: createLineMaterial({
            name: `${options.name}Material`,
            color: { r: options.color[0], g: options.color[1], b: options.color[2], a: options.alpha ?? 0.8 },
            useVertexAlpha: true,
            depthWrite: false,
            depthCompare: "always",
        }),
    });
    wireframe.pickable = false;
    wireframe.renderOrder = 10_000;
    return wireframe;
}

function createCaptureMarker(engine: EngineContext, marker: Marker): Mesh {
    const mesh = createSphere(engine, { diameter: 0.4, segments: 16 });
    const material = createStandardMaterial();
    material.diffuseColor = [1, 1, 1];
    material.emissiveColor = [marker.color[0], marker.color[1], marker.color[2]];
    material.specularColor = [0, 0, 0];
    material.disableLighting = true;
    mesh.name = marker.name;
    mesh.material = material;
    mesh.position.set(...marker.position);
    mesh.pickable = false;
    return mesh;
}

export function addScene186DebugHelpers(scene: Parameters<typeof addToScene>[0], engine: EngineContext, options: Scene186DebugOptions): void {
    for (const marker of options.markers) {
        addToScene(scene, createCaptureMarker(engine, marker));
    }
    for (const bounds of options.bounds) {
        addToScene(scene, createBoundsWireframe(engine, bounds));
    }
}
