import {
    addToScene,
    cloneTransformNode,
    createDefaultCamera,
    createDirectionalLight,
    createEngine,
    createHemisphericLight,
    createPcfDirectionalShadowGenerator,
    createSceneContext,
    disposeEngine,
    getMeshGeometry,
    invalidateRenderBundles,
    loadEnvironment,
    onBeforeRender,
    registerSceneWithShadowSupport,
    setShadowTaskCasterMeshes,
    setThinInstances,
    startEngine,
} from "babylon-lite";
import type { Mesh, SceneContext } from "babylon-lite";
import { loadPlayroomAssets } from "../demos/playroom/assets.js";
import { PLAYROOM_LAYOUT } from "../demos/playroom/layout.js";
import { createPuzzleRandom, expandPuzzle } from "../demos/playroom/puzzles.js";

interface GeometrySample {
    readonly index: number;
    readonly position: readonly number[];
}

interface TriangleSample {
    readonly triangleOrdinal: number;
    readonly indices: readonly number[];
    readonly positions: readonly (readonly number[])[];
    readonly normals: readonly (readonly number[])[];
    readonly geometricNormal: readonly number[];
    readonly averagedNormal: readonly number[];
    readonly orientationDot: number;
    readonly tangentHandedness: readonly number[] | null;
}

interface PlacementSnapshot {
    readonly physics: "absent";
    readonly models: ReadonlyArray<{
        readonly model: string;
        readonly vertexCount: number;
        readonly indexCount: number;
        readonly minimum: readonly number[];
        readonly maximum: readonly number[];
        readonly selectedVertices: readonly GeometrySample[];
        readonly selectedTriangles: readonly TriangleSample[];
    }>;
    readonly placements: ReadonlyArray<{
        readonly key: string;
        readonly family: string;
        readonly batches: ReadonlyArray<{
            readonly key: string;
            readonly model: string;
            readonly matrices: readonly number[][];
        }>;
    }>;
    readonly renderedBatchCount: number;
    readonly renderedInstanceCount: number;
}

function normalize3(x: number, y: number, z: number): number[] {
    const length = Math.max(1e-12, Math.hypot(x, y, z));
    return [Math.fround(x / length), Math.fround(y / length), Math.fround(z / length)];
}

function triangleSample(
    positions: Float32Array,
    normals: Float32Array,
    tangents: Float32Array | undefined,
    indices: Uint16Array | Uint32Array,
    triangleOrdinal: number
): TriangleSample {
    const triangleIndices = Array.from(indices.slice(triangleOrdinal * 3, triangleOrdinal * 3 + 3));
    const points = triangleIndices.map((index) => Array.from(positions.slice(index * 3, index * 3 + 3)));
    const triangleNormals = triangleIndices.map((index) => Array.from(normals.slice(index * 3, index * 3 + 3)));
    const ab = points[1]!.map((value, axis) => value - points[0]![axis]!);
    const ac = points[2]!.map((value, axis) => value - points[0]![axis]!);
    const geometricNormal = normalize3(ab[1]! * ac[2]! - ab[2]! * ac[1]!, ab[2]! * ac[0]! - ab[0]! * ac[2]!, ab[0]! * ac[1]! - ab[1]! * ac[0]!);
    const averagedNormal = normalize3(
        triangleNormals[0]![0]! + triangleNormals[1]![0]! + triangleNormals[2]![0]!,
        triangleNormals[0]![1]! + triangleNormals[1]![1]! + triangleNormals[2]![1]!,
        triangleNormals[0]![2]! + triangleNormals[1]![2]! + triangleNormals[2]![2]!
    );
    return {
        triangleOrdinal,
        indices: triangleIndices,
        positions: points,
        normals: triangleNormals,
        geometricNormal,
        averagedNormal,
        orientationDot: Math.fround(geometricNormal.reduce((sum, value, axis) => sum + value * averagedNormal[axis]!, 0)),
        tangentHandedness: tangents ? triangleIndices.map((index) => tangents[index * 4 + 3]!) : null,
    };
}

function geometrySnapshot(model: string, mesh: Mesh): PlacementSnapshot["models"][number] {
    const geometry = getMeshGeometry(mesh);
    if (!geometry) {
        throw new Error(`The Playroom placement harness could not read ${model} geometry.`);
    }
    const positions = geometry.positions;
    const normals = geometry.normals;
    const tangents = geometry.tangents;
    const indices = geometry.indices;
    const vertexCount = positions.length / 3;
    const selectedIndices = [...new Set([0, Math.floor(vertexCount / 2), vertexCount - 1])];
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < positions.length; index += 3) {
        for (let axis = 0; axis < 3; axis++) {
            minimum[axis] = Math.min(minimum[axis]!, positions[index + axis]!);
            maximum[axis] = Math.max(maximum[axis]!, positions[index + axis]!);
        }
    }
    const asymmetricTriangles: number[] = [];
    for (let triangleOrdinal = 0; triangleOrdinal < indices.length / 3; triangleOrdinal++) {
        const sample = triangleSample(positions, normals, tangents, indices, triangleOrdinal);
        const squaredLengths = [0, 1, 2].map((edge) => {
            const left = sample.positions[edge]!;
            const right = sample.positions[(edge + 1) % 3]!;
            return left.reduce((sum, value, axis) => sum + (value - right[axis]!) ** 2, 0);
        });
        if (Math.max(...squaredLengths) - Math.min(...squaredLengths) > 1e-8 && Math.abs(sample.orientationDot) > 1e-5) {
            asymmetricTriangles.push(triangleOrdinal);
        }
    }
    if (!asymmetricTriangles.length) {
        throw new Error(`The Playroom placement harness found no asymmetric ${model} triangle.`);
    }
    const selectedTriangleOrdinals = [...new Set([asymmetricTriangles[0]!, asymmetricTriangles[Math.floor(asymmetricTriangles.length / 2)]!, asymmetricTriangles.at(-1)!])];
    return {
        model,
        vertexCount,
        indexCount: indices.length,
        minimum,
        maximum,
        selectedVertices: selectedIndices.map((index) => ({ index, position: Array.from(positions.slice(index * 3, index * 3 + 3)) })),
        selectedTriangles: selectedTriangleOrdinals.map((triangleOrdinal) => triangleSample(positions, normals, tangents, indices, triangleOrdinal)),
    };
}

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    createDefaultCamera(scene);
    const sun = createDirectionalLight([0, -2, -2], 0.85);
    sun.position.set(0, 12, 0);
    const shadow = createPcfDirectionalShadowGenerator(engine, sun, {
        mapSize: 2048,
        bias: 0.0001,
        orthoMinZ: -6,
        orthoMaxZ: 30,
    });
    sun.shadowGenerator = shadow;
    addToScene(scene, sun);
    addToScene(scene, createHemisphericLight([0, 1, 0.5], 0.1));
    await loadEnvironment(scene, new URL("/playroom/env/childRoom_ibl.env", window.location.href).href, {
        skipSkybox: true,
        skipGround: true,
        brdfUrl: new URL("/brdf-lut.png", window.location.href).href,
    });

    // A synthetic module URL makes the existing asset resolver target /playroom/
    // in dev without coupling this test-only entry to the production demo bundle.
    const assetBase = new URL("/playroom-oracle-entry.js", window.location.href).href;
    const assets = await loadPlayroomAssets(engine, assetBase, [shadow]);
    const captureMode = new URLSearchParams(window.location.search).has("capture");
    const models = Object.entries(assets.models)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([model, template]) => geometrySnapshot(model, template.mesh));

    const familyIndices = new Map<string, number>();
    const placements: PlacementSnapshot["placements"][number][] = [];
    const meshes: Mesh[] = [];
    let renderedBatchCount = 0;
    let renderedInstanceCount = 0;
    const random = createPuzzleRandom(0x504c4159);
    for (let placementIndex = 0; placementIndex < PLAYROOM_LAYOUT.length; placementIndex++) {
        const entry = PLAYROOM_LAYOUT[placementIndex]!;
        const familyIndex = familyIndices.get(entry.family) ?? 0;
        familyIndices.set(entry.family, familyIndex + 1);
        const key = `${entry.family}/${String(familyIndex).padStart(3, "0")}`;
        const batches = expandPuzzle(entry, random, assets.models).map((batch) => {
            const template = assets.models[batch.model];
            if (!template) {
                throw new Error(`The Playroom placement harness has no ${batch.model} template.`);
            }
            const mesh = cloneTransformNode(template.mesh) as Mesh;
            mesh.name = `placement-harness-${key}-${batch.model}`;
            setThinInstances(mesh, batch.matrices, batch.matrices.length / 16);
            addToScene(scene, mesh);
            meshes.push(mesh);
            const matrices = Array.from({ length: batch.matrices.length / 16 }, (_, index) => Array.from(batch.matrices.slice(index * 16, index * 16 + 16)));
            renderedBatchCount++;
            renderedInstanceCount += matrices.length;
            return { key: `${key}/${batch.model}`, model: batch.model, matrices };
        });
        placements.push({ key, family: entry.family, batches });
    }

    setShadowTaskCasterMeshes(shadow, meshes);
    await registerSceneWithShadowSupport(scene);
    if (captureMode) {
        const renderables = (scene as SceneContext & { _renderables: Array<{ _direct?: boolean }> })._renderables;
        for (const renderable of renderables) {
            renderable._direct = true;
        }
        invalidateRenderBundles(engine);
        onBeforeRender(scene, () => invalidateRenderBundles(engine));
    }
    await startEngine(engine);
    const snapshot: PlacementSnapshot = { physics: "absent", models, placements, renderedBatchCount, renderedInstanceCount };
    const output = document.createElement("script");
    output.id = "playroom-placement-snapshot";
    output.type = "application/json";
    output.textContent = JSON.stringify(snapshot);
    document.body.append(output);
    canvas.dataset.physics = snapshot.physics;
    canvas.dataset.renderedBatches = String(renderedBatchCount);
    canvas.dataset.renderedInstances = String(renderedInstanceCount);
    canvas.dataset.ready = "true";
    window.addEventListener("pagehide", () => disposeEngine(engine), { once: true });
}

void main().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
