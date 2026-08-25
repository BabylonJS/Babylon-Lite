// Scene 186 — Local Cubemap Blending
// Two adjacent floor/back-wall sets viewed from their shared boundary. The
// default compares hard local projection with fragment-blended probes.
// ?local=0 switches the two-room view to per-floor unprojected cubemaps.

import {
    addToScene,
    attachFreeControl,
    createEngine,
    createFreeCamera,
    createHemisphericLight,
    createMeshFromData,
    createPbrLocalEnvironmentProbeSet,
    createPbrMaterial,
    createSceneContext,
    createSolidTexture2D,
    enablePbrLocalCubemap,
    loadEnvironment,
    loadTexture2D,
    registerScene,
    setPbrLocalEnvironment,
    setPbrEnvironment,
    setPbrLocalEnvironmentProbeDebug,
    setPbrLocalEnvironmentProbeSet,
    startEngine,
    type EngineContext,
    type EnvironmentTextures,
    type Mesh,
    type PbrMaterialProps,
    type Texture2D,
} from "babylon-lite";

const LEFT_ENV_URL = "/textures/scene186/left.env";
const RIGHT_ENV_URL = "/textures/scene186/right.env";
const WOOD_URL = "https://assets.babylonjs.com/textures/woodAlbedo.png";
const LEFT_BACK_URL = "https://assets.babylonjs.com/textures/fur.jpg";
const RIGHT_BACK_URL = "https://assets.babylonjs.com/textures/leopard_fur.JPG";
const ROOM_WIDTH = 6;
const ROOM_HEIGHT = 5;
const ROOM_DEPTH = 5;
const ROOM_Z = 2;
const FLOOR_DEPTH = ROOM_HEIGHT;
const PROBE_CAPTURE_Z = ROOM_Z + ROOM_DEPTH / 2 - ROOM_WIDTH / 2;
const LEFT_INFLUENCE_CENTER = [-ROOM_WIDTH / 2, 0, ROOM_Z] as const;
const RIGHT_INFLUENCE_CENTER = [ROOM_WIDTH / 2, 0, ROOM_Z] as const;
const OUTER_INFLUENCE_CENTER = [0, 0, ROOM_Z] as const;
const COMPARISON_GAP = 1;
const HARD_RIGHT_CENTER_X = -ROOM_WIDTH - COMPARISON_GAP - ROOM_WIDTH / 2;
const HARD_LEFT_CENTER_X = HARD_RIGHT_CENTER_X - ROOM_WIDTH;
const COMPARISON_CENTER_X = -ROOM_WIDTH - COMPARISON_GAP / 2;
const INFLUENCE_INNER_SIZE = [ROOM_WIDTH / 80, ROOM_HEIGHT, ROOM_DEPTH] as const;
const INFLUENCE_OUTER_SIZE = [ROOM_WIDTH * 4, ROOM_HEIGHT + 1, ROOM_DEPTH + 1] as const;

interface RoomFaces {
    floor: Mesh;
    back: Mesh;
}

interface RoomMaterials {
    floor: PbrMaterialProps;
    back: PbrMaterialProps;
}

function createSurfaceMaterial(engine: EngineContext, texture: Texture2D, reflective: boolean): PbrMaterialProps {
    return createPbrMaterial({
        baseColorTexture: texture,
        ormTexture: createSolidTexture2D(engine, 1, reflective ? 0.12 : 0.82, 0, 1),
        directIntensity: 1,
        environmentIntensity: reflective ? 1 : 0.35,
        reflectance: reflective ? 0.2 : 0.04,
        doubleSided: true,
    });
}

function createFace(
    engine: EngineContext,
    name: string,
    corners: readonly (readonly [number, number, number])[],
    normal: readonly [number, number, number],
    uRepeat: number,
    vRepeat: number
): Mesh {
    const positions = new Float32Array(corners.flat());
    const normals = new Float32Array([normal, normal, normal, normal].flat());
    const uvs = new Float32Array([0, 0, uRepeat, 0, uRepeat, vRepeat, 0, vRepeat]);
    return createMeshFromData(engine, name, positions, normals, new Uint32Array([0, 1, 2, 0, 2, 3]), uvs);
}

function createRoomFaces(engine: EngineContext, name: string, xMin: number, xMax: number): RoomFaces {
    const halfHeight = ROOM_HEIGHT / 2;
    const zMax = ROOM_Z + ROOM_DEPTH / 2;
    const floorZMin = zMax - FLOOR_DEPTH;
    return {
        floor: createFace(
            engine,
            `${name}Floor`,
            [
                [xMin, -halfHeight, floorZMin],
                [xMax, -halfHeight, floorZMin],
                [xMax, -halfHeight, zMax],
                [xMin, -halfHeight, zMax],
            ],
            [0, 1, 0],
            ROOM_WIDTH / 2,
            FLOOR_DEPTH / 2
        ),
        back: createFace(
            engine,
            `${name}Back`,
            [
                [xMin, -halfHeight, zMax],
                [xMax, -halfHeight, zMax],
                [xMax, halfHeight, zMax],
                [xMin, halfHeight, zMax],
            ],
            [0, 0, -1],
            ROOM_WIDTH / 2,
            ROOM_HEIGHT / 2
        ),
    };
}

function addRoom(scene: ReturnType<typeof createSceneContext>, faces: RoomFaces, materials: RoomMaterials): void {
    faces.floor.material = materials.floor;
    faces.back.material = materials.back;
    addToScene(scene, faces.floor);
    addToScene(scene, faces.back);
}

function configureReflectiveRoom(engine: EngineContext, materials: RoomMaterials): void {
    materials.floor.ormTexture = createSolidTexture2D(engine, 1, 0.01, 1, 1);
    materials.floor.directIntensity = 0;
    materials.back.environmentIntensity = 0;
}

function assignProbeToFloor(materials: RoomMaterials, environment: EnvironmentTextures, x: number): void {
    assignSingleProbe(materials.floor, environment, x);
}

function assignProbeSetToFloor(materials: RoomMaterials, probeSet: Parameters<typeof setPbrLocalEnvironmentProbeSet>[1]): void {
    setPbrLocalEnvironmentProbeSet(materials.floor, probeSet);
}

function assignSingleProbe(material: ReturnType<typeof createPbrMaterial>, environment: EnvironmentTextures, x: number): void {
    setPbrLocalEnvironment(material, environment, {
        capturePosition: [x, 0, PROBE_CAPTURE_Z],
        projectionPosition: [x, 0, ROOM_Z],
        projectionSize: [ROOM_WIDTH, ROOM_HEIGHT, ROOM_DEPTH],
    });
}

async function main(): Promise<void> {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const params = new URLSearchParams(location.search);
    const geometryOnly = params.get("geometry") === "1";
    const localCubemaps = params.get("local") !== "0";
    const blending = params.get("blend") !== "0";
    const debug = params.get("debug") === "1";
    const showComparison = !geometryOnly && localCubemaps && blending && params.get("compare") !== "0";
    const localDebug = localCubemaps && blending && debug;
    const probeHelpers = localDebug ? "inner-influence-wireframes,outer-influence-wireframe,capture-spheres" : debug ? "capture-spheres" : "none";
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.025, g: 0.03, b: 0.045, a: 1 };

    const camera = showComparison
        ? createFreeCamera({ x: COMPARISON_CENTER_X, y: 2.5, z: -7 }, { x: COMPARISON_CENTER_X, y: -1.5, z: ROOM_Z })
        : createFreeCamera({ x: -6, y: 1.5, z: -5 }, { x: 0, y: -1.5, z: ROOM_Z });
    camera.nearPlane = 0.05;
    camera.farPlane = 100;
    camera.fov = 1.2;
    camera.speed = 0.35;
    camera.angularSensitivity = 1200;
    scene.camera = camera;
    attachFreeControl(camera, canvas, scene);

    const [woodTexture, leftBackTexture, rightBackTexture] = await Promise.all([
        loadTexture2D(engine, WOOD_URL, { srgb: true }),
        loadTexture2D(engine, LEFT_BACK_URL, { srgb: true }),
        loadTexture2D(engine, RIGHT_BACK_URL, { srgb: true }),
    ]);
    const leftMaterials: RoomMaterials = {
        floor: createSurfaceMaterial(engine, woodTexture, true),
        back: createSurfaceMaterial(engine, leftBackTexture, false),
    };
    const rightMaterials: RoomMaterials = {
        floor: createSurfaceMaterial(engine, woodTexture, true),
        back: createSurfaceMaterial(engine, rightBackTexture, false),
    };
    const hardLeftMaterials: RoomMaterials | null = showComparison
        ? {
              floor: createSurfaceMaterial(engine, woodTexture, true),
              back: createSurfaceMaterial(engine, leftBackTexture, false),
          }
        : null;
    const hardRightMaterials: RoomMaterials | null = showComparison
        ? {
              floor: createSurfaceMaterial(engine, woodTexture, true),
              back: createSurfaceMaterial(engine, rightBackTexture, false),
          }
        : null;
    const leftRoom = createRoomFaces(engine, "left", -ROOM_WIDTH, 0);
    const rightRoom = createRoomFaces(engine, "right", 0, ROOM_WIDTH);
    const hardRightMaxX = -ROOM_WIDTH - COMPARISON_GAP;
    const hardLeftRoom = showComparison ? createRoomFaces(engine, "hardLeft", hardRightMaxX - ROOM_WIDTH * 2, hardRightMaxX - ROOM_WIDTH) : null;
    const hardRightRoom = showComparison ? createRoomFaces(engine, "hardRight", hardRightMaxX - ROOM_WIDTH, hardRightMaxX) : null;
    if (debug) {
        const { addScene186DebugHelpers } = await import("./scene186-debug");
        addScene186DebugHelpers(scene, engine, {
            markers: [
                { name: "leftProbeCapturePosition", position: [-ROOM_WIDTH / 2, 0, PROBE_CAPTURE_Z], color: [0.15, 0.85, 1] },
                { name: "rightProbeCapturePosition", position: [ROOM_WIDTH / 2, 0, PROBE_CAPTURE_Z], color: [1, 0.65, 0.1] },
                ...(showComparison
                    ? ([
                          { name: "hardLeftProbeCapturePosition", position: [HARD_LEFT_CENTER_X, 0, PROBE_CAPTURE_Z], color: [0.15, 0.85, 1] },
                          { name: "hardRightProbeCapturePosition", position: [HARD_RIGHT_CENTER_X, 0, PROBE_CAPTURE_Z], color: [1, 0.65, 0.1] },
                      ] as const)
                    : []),
            ],
            bounds: localDebug
                ? [
                      { name: "leftInnerInfluenceBounds", center: LEFT_INFLUENCE_CENTER, size: INFLUENCE_INNER_SIZE, color: [0.15, 0.85, 1] },
                      { name: "rightInnerInfluenceBounds", center: RIGHT_INFLUENCE_CENTER, size: INFLUENCE_INNER_SIZE, color: [1, 0.65, 0.1] },
                      { name: "outerInfluenceBounds", center: OUTER_INFLUENCE_CENTER, size: INFLUENCE_OUTER_SIZE, color: [0.8, 0.25, 1], alpha: 0.45 },
                  ]
                : [],
        });
    }

    if (geometryOnly) {
        addToScene(scene, createHemisphericLight([0, 1, 0], 1.25));
        addRoom(scene, leftRoom, leftMaterials);
        addRoom(scene, rightRoom, rightMaterials);

        await registerScene(scene);
        await startEngine(engine);
        canvas.dataset.localCubemap = "false";
        canvas.dataset.probeHelpers = probeHelpers;
        canvas.dataset.roomFaces = "floor,back";
        canvas.dataset.drawCalls = String(engine.drawCallCount);
        canvas.dataset.initMs = String(performance.now() - initStart);
        canvas.dataset.ready = "true";
        return;
    }

    configureReflectiveRoom(engine, leftMaterials);
    configureReflectiveRoom(engine, rightMaterials);
    if (hardLeftMaterials && hardRightMaterials) {
        configureReflectiveRoom(engine, hardLeftMaterials);
        configureReflectiveRoom(engine, hardRightMaterials);
    }
    addToScene(scene, createHemisphericLight([0, 1, 0], 1.25));

    await enablePbrLocalCubemap({ maxCandidates: 2 });
    const leftEnvironment = await loadEnvironment(scene, LEFT_ENV_URL, {
        brdfUrl: "/brdf-lut.png",
        skipGround: true,
        skipSkybox: true,
    });
    const rightEnvironment = await loadEnvironment(scene, RIGHT_ENV_URL, {
        brdfUrl: "/brdf-lut.png",
        skipGround: true,
        skipSkybox: true,
    });

    if (!localCubemaps) {
        setPbrEnvironment(leftMaterials.floor, leftEnvironment);
        setPbrEnvironment(rightMaterials.floor, rightEnvironment);
        addRoom(scene, leftRoom, leftMaterials);
        addRoom(scene, rightRoom, rightMaterials);

        await registerScene(scene);
        await startEngine(engine);
        canvas.dataset.localCubemap = "false";
        canvas.dataset.localCubemapBlending = "false";
        canvas.dataset.environment = "per-floor";
        canvas.dataset.probeHelpers = probeHelpers;
        canvas.dataset.roomFaces = "floor,back";
        canvas.dataset.drawCalls = String(engine.drawCallCount);
        canvas.dataset.initMs = String(performance.now() - initStart);
        canvas.dataset.ready = "true";
        return;
    }

    const probeSet = createPbrLocalEnvironmentProbeSet(scene, {
        probes: [
            {
                environment: leftEnvironment,
                capturePosition: [-ROOM_WIDTH / 2, 0, PROBE_CAPTURE_Z],
                projectionPosition: [-ROOM_WIDTH / 2, 0, ROOM_Z],
                projectionSize: [ROOM_WIDTH, ROOM_HEIGHT, ROOM_DEPTH],
                influencePosition: LEFT_INFLUENCE_CENTER,
                influenceInnerSize: INFLUENCE_INNER_SIZE,
                influenceOuterPosition: OUTER_INFLUENCE_CENTER,
                influenceOuterSize: INFLUENCE_OUTER_SIZE,
                debugColor: [1, 0, 0],
            },
            {
                environment: rightEnvironment,
                capturePosition: [ROOM_WIDTH / 2, 0, PROBE_CAPTURE_Z],
                projectionPosition: [ROOM_WIDTH / 2, 0, ROOM_Z],
                projectionSize: [ROOM_WIDTH, ROOM_HEIGHT, ROOM_DEPTH],
                influencePosition: RIGHT_INFLUENCE_CENTER,
                influenceInnerSize: INFLUENCE_INNER_SIZE,
                influenceOuterPosition: OUTER_INFLUENCE_CENTER,
                influenceOuterSize: INFLUENCE_OUTER_SIZE,
                debugColor: [0, 0, 1],
            },
        ],
        voxelGrid: {
            minimum: [-ROOM_WIDTH, -ROOM_HEIGHT / 2, ROOM_Z - ROOM_DEPTH / 2],
            maximum: [ROOM_WIDTH, ROOM_HEIGHT / 2, ROOM_Z + ROOM_DEPTH / 2],
            cellSize: 2,
        },
    });
    setPbrLocalEnvironmentProbeDebug(probeSet, localDebug);

    if (blending) {
        assignProbeSetToFloor(leftMaterials, probeSet);
        assignProbeSetToFloor(rightMaterials, probeSet);
        if (hardLeftMaterials && hardRightMaterials && hardLeftRoom && hardRightRoom) {
            assignProbeToFloor(hardLeftMaterials, leftEnvironment, HARD_LEFT_CENTER_X);
            assignProbeToFloor(hardRightMaterials, rightEnvironment, HARD_RIGHT_CENTER_X);
            addRoom(scene, hardLeftRoom, hardLeftMaterials);
            addRoom(scene, hardRightRoom, hardRightMaterials);
        }
    } else {
        assignProbeToFloor(leftMaterials, leftEnvironment, -ROOM_WIDTH / 2);
        assignProbeToFloor(rightMaterials, rightEnvironment, ROOM_WIDTH / 2);
    }
    addRoom(scene, leftRoom, leftMaterials);
    addRoom(scene, rightRoom, rightMaterials);

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.localCubemap = "true";
    canvas.dataset.localCubemapBlending = String(blending);
    canvas.dataset.localCubemapDebug = String(localDebug);
    canvas.dataset.comparison = showComparison ? "hard-left,blended-right" : "false";
    canvas.dataset.probeHelpers = probeHelpers;
    canvas.dataset.probes = "left,right";
    canvas.dataset.roomFaces = "floor,back";
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - initStart);
    canvas.dataset.ready = "true";
}

main().catch((error: unknown) => {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
    if (canvas) {
        canvas.dataset.error = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
});
