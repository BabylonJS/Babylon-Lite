import {
    createMeshFromData,
    enableBoneControl,
    enableGltfCpuTangents,
    getContainerMeshes,
    getMeshGeometry,
    loadGltf,
    loadTexture2D,
    parseNodeMaterialFromSnippet,
} from "babylon-lite";
import type { EngineContext, Mesh, NodeMaterial, ShadowGenerator, Texture2D } from "babylon-lite";
import { demoAssetUrl } from "../demo-asset-url.js";
import type { BunnyRigMetadata, ModelTemplate, PlayroomAssets } from "./types.js";

interface ModelDefinition {
    readonly name: string;
    readonly file: string;
    readonly scale: readonly [number, number, number];
}

const MODELS: readonly ModelDefinition[] = [
    { name: "arch", file: "archStackArch.glb", scale: [0.2, 0.2, 0.2] },
    { name: "archCylinder", file: "archStackCylinder.glb", scale: [0.6, 0.6, 0.6] },
    { name: "archTop", file: "archStackTop.glb", scale: [0.5, 0.5, 0.2] },
    { name: "popper", file: "babylonBurster.glb", scale: [0.2, 0.2, 0.2] },
    { name: "bowlingBall", file: "bowlingBall.glb", scale: [0.2, 0.2, 0.2] },
    { name: "bowlingPin", file: "bowlingPin.glb", scale: [0.2, 0.2, 0.2] },
    { name: "chessboard", file: "chessboard.glb", scale: [0.6, 0.6, 0.6] },
    { name: "chessWhite", file: "chesspiece.glb", scale: [0.06, 0.06, 0.06] },
    { name: "chessBlack", file: "chesspiece.glb", scale: [0.06, 0.06, 0.06] },
    { name: "cube", file: "cubeBlock.glb", scale: [1, 1, 1] },
    { name: "cup", file: "cup.glb", scale: [0.2, 0.2, 0.2] },
    { name: "domino", file: "domino.glb", scale: [0.2, 0.2, 0.2] },
    { name: "ramp", file: "ramp.glb", scale: [0.2, 0.2, 0.2] },
    { name: "towerGameBlock", file: "towerGameBlock.glb", scale: [20, 20, 20] },
    { name: "transformedTowerGameBlock", file: "transformedTowerGameBlock.glb", scale: [0.2, 0.2, 0.2] },
];

function url(moduleUrl: string, relative: string): string {
    return demoAssetUrl(`./playroom/${relative}`, moduleUrl);
}

function bakeTemplate(engine: EngineContext, source: Mesh, definition: ModelDefinition): ModelTemplate {
    const geometry = getMeshGeometry(source);
    if (!geometry) {
        throw new Error(`The Playroom model ${definition.file} did not retain complete CPU geometry.`);
    }
    const [sx, sy, sz] = definition.scale;
    const positions = geometry.positions;
    const normals = geometry.normals;
    const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
    const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
        positions[i] = -positions[i]! * sx;
        positions[i + 1] = positions[i + 1]! * sy;
        positions[i + 2] = positions[i + 2]! * sz;
        minimum[0] = Math.min(minimum[0], positions[i]!);
        minimum[1] = Math.min(minimum[1], positions[i + 1]!);
        minimum[2] = Math.min(minimum[2], positions[i + 2]!);
        maximum[0] = Math.max(maximum[0], positions[i]!);
        maximum[1] = Math.max(maximum[1], positions[i + 1]!);
        maximum[2] = Math.max(maximum[2], positions[i + 2]!);
        const nx = -normals[i]! / sx;
        const ny = normals[i + 1]! / sy;
        const nz = normals[i + 2]! / sz;
        const length = Math.max(1e-8, Math.hypot(nx, ny, nz));
        normals[i] = nx / length;
        normals[i + 1] = ny / length;
        normals[i + 2] = nz / length;
    }
    if (geometry.tangents) {
        for (let i = 0; i < geometry.tangents.length; i += 4) {
            geometry.tangents[i] = -geometry.tangents[i]!;
            geometry.tangents[i + 3] = -geometry.tangents[i + 3]!;
        }
    }
    const mesh = createMeshFromData(engine, definition.name, positions, normals, geometry.indices, geometry.uvs, geometry.uvs2, geometry.tangents, geometry.colors);
    mesh.material = source.material;
    mesh.name = definition.name;
    return {
        root: mesh,
        mesh,
        collisionBounds: {
            center: [(minimum[0] + maximum[0]) * 0.5, (minimum[1] + maximum[1]) * 0.5, (minimum[2] + maximum[2]) * 0.5],
            extents: [maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2]],
        },
    };
}

async function readText(path: string): Promise<string> {
    const response = await fetch(path);
    if (!response.ok) {
        throw new Error(`The Playroom could not load ${path} (${response.status}).`);
    }
    return response.text();
}

async function loadGraph(
    engine: EngineContext,
    moduleUrl: string,
    file: string,
    textures: Readonly<Record<string, Texture2D>>,
    hasInstances: boolean,
    shadowGenerators: readonly ShadowGenerator[]
): Promise<NodeMaterial> {
    let json = await readText(url(moduleUrl, `shaders/${file}`));
    if (file === "aiming.json") {
        const graph = JSON.parse(json) as { backFaceCulling?: boolean; forceAlphaBlending?: boolean };
        graph.backFaceCulling = false;
        graph.forceAlphaBlending = true;
        json = JSON.stringify(graph);
    }
    return parseNodeMaterialFromSnippet(engine, "", { json, textures, hasInstances, shadowGenerators });
}

async function loadTextures(engine: EngineContext, moduleUrl: string): Promise<Record<string, Texture2D>> {
    const definitions: readonly [string, string, boolean][] = [
        ["baseColorTex", "textures/woodGrain_baseColor.png", true],
        ["normalTex", "textures/woodGrain_normal.png", false],
        ["rugBaseColor", "textures/rug_woven_basecolor.png", true],
        ["rugNormal", "textures/rug_woven_normal.png", false],
        ["baseColorMask", "textures/rug_woven_mask.png", false],
        ["ormTex", "textures/rug_woven_orm.png", false],
        ["baseColorGradient", "textures/colorGradient_baseColor.png", true],
        ["EmbeddedDomino50", "textures/shader-embedded/domino-50.jpg", true],
        ["EmbeddedDomino84", "textures/shader-embedded/domino-84.jpg", true],
        ["EmbeddedBabylonburster55", "textures/shader-embedded/babylonBurster-55.jpg", true],
        ["EmbeddedBabylonburster59", "textures/shader-embedded/babylonBurster-59.jpg", true],
        ["EmbeddedBabylonburster63", "textures/shader-embedded/babylonBurster-63.jpg", true],
        ["pointStar", "textures/pointStar.png", true],
        ["flare", "textures/flare.png", true],
        ["confetti", "textures/confetti.png", true],
    ];
    const pairs = await Promise.all(definitions.map(async ([name, path, srgb]) => [name, await loadTexture2D(engine, url(moduleUrl, path), { invertY: true, srgb })] as const));
    return Object.fromEntries(pairs);
}

export async function loadPlayroomAssets(engine: EngineContext, moduleUrl: string, shadowGenerators: readonly ShadowGenerator[] = []): Promise<PlayroomAssets> {
    enableBoneControl();
    enableGltfCpuTangents();
    const [containers, bunny, textures, rigText] = await Promise.all([
        Promise.all(MODELS.map((definition) => loadGltf(engine, url(moduleUrl, `gltf/${definition.file}`)))),
        loadGltf(engine, url(moduleUrl, "gltf/bunny_rigged.glb")),
        loadTextures(engine, moduleUrl),
        readText(url(moduleUrl, "gltf/bunny-rig.json")),
    ]);
    const models: Record<string, ModelTemplate> = {};
    for (let i = 0; i < MODELS.length; i++) {
        const definition = MODELS[i]!;
        const source = getContainerMeshes(containers[i]!)[0];
        if (!source) {
            throw new Error(`The Playroom model ${definition.file} contains no mesh.`);
        }
        models[definition.name] = bakeTemplate(engine, source, definition);
    }
    const bunnyMesh = getContainerMeshes(bunny)[0];
    const bunnySkeleton = bunny.skeletons?.[0];
    if (!bunnyMesh || !bunnySkeleton || !bunny.entities[0]) {
        throw new Error("The Playroom bunny is missing its skinned mesh, root, or skeleton.");
    }
    const rig = JSON.parse(rigText) as BunnyRigMetadata;
    const blockTextures = { baseColorTex: textures.baseColorTex!, normalTex: textures.normalTex! };
    const rugTextures = {
        baseColorTex: textures.rugBaseColor!,
        normalTex: textures.rugNormal!,
        baseColorMask: textures.baseColorMask!,
        ormTex: textures.ormTex!,
        baseColorGradient: textures.baseColorGradient!,
    };
    const dominoTextures = { EmbeddedDomino50: textures.EmbeddedDomino50!, EmbeddedDomino84: textures.EmbeddedDomino84! };
    const [blockMaterial, rugMaterial, dominoMaterial, aimingMaterial] = await Promise.all([
        loadGraph(engine, moduleUrl, "towerGameBlockShader.json", blockTextures, true, shadowGenerators),
        loadGraph(engine, moduleUrl, "rugShader.json", rugTextures, false, shadowGenerators),
        loadGraph(engine, moduleUrl, "domino.json", dominoTextures, true, shadowGenerators),
        loadGraph(engine, moduleUrl, "aiming.json", {}, false, shadowGenerators),
    ]);
    if (rugMaterial.inputs.rugMinWidth) {
        rugMaterial.inputs.rugMinWidth.value = -20;
        rugMaterial.inputs.rugMaxWidth!.value = 20;
        rugMaterial.inputs.rugRatio!.value = 1;
        rugMaterial.inputs.rugTiling!.value = 60;
        rugMaterial.inputs.patternBands!.value = 10;
    }
    models.towerGameBlock!.mesh.material = blockMaterial;
    models.transformedTowerGameBlock!.mesh.material = blockMaterial;
    models.domino!.mesh.material = dominoMaterial;

    return {
        models,
        bunnyRoot: bunny.entities[0],
        bunnyMesh,
        bunnySkeleton,
        textures,
        blockMaterial,
        rugMaterial,
        dominoMaterial,
        aimingMaterial,
        rig,
    };
}
