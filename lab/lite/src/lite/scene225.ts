// Scene 225: Geospatial (globe-orbit) camera — static deterministic pose.
//
// A blue globe (sphere of radius PLANET_RADIUS, centred at the world origin) is
// orbited by a GeospatialCamera anchored to a surface point. Six distinct
// coloured marker cubes sit on the surface at fixed lat/long positions to break
// the sphere's rotational symmetry so the camera's yaw/pitch/radius are all
// observable in the render. The camera is pinned to a fixed center/yaw/pitch/radius;
// controls are attached (matching the Lite-scene convention and giving the geospatial
// control/fly code bundle coverage), but no input is delivered during headless capture
// and zero-input frames cause no camera drift, so the frame stays deterministic and can
// be compared pixel-for-pixel against the Babylon.js `GeospatialCamera` oracle.
//
// World "north" in Babylon's left-handed scene is +Z, so the ECEF mapping places
// the north pole at +Z and the equator in the XY plane. Markers and the camera
// centre are computed from the SAME lat/long → ECEF helper as the BJS reference.

import {
    addToScene,
    startEngine,
    createEngine,
    createSceneContext,
    createSphere,
    createBox,
    createStandardMaterial,
    createHemisphericLight,
    registerScene,
    createGeospatialCamera,
    setGeospatialOrientation,
    attachGeospatialControls,
} from "babylon-lite";

const PLANET_RADIUS = 100;
const CAMERA_RADIUS = 170;
const CAMERA_YAW = 0.6;
const CAMERA_PITCH = 0.85;
const CENTER_LAT = 20;
const CENTER_LON = 30;
const MARKER_SIZE = 18;

interface Marker {
    lat: number;
    lon: number;
    color: [number, number, number];
}

const MARKERS: Marker[] = [
    { lat: 0, lon: 0, color: [0.9, 0.15, 0.15] },
    { lat: 20, lon: 30, color: [0.95, 0.85, 0.15] },
    { lat: 40, lon: 60, color: [0.15, 0.8, 0.25] },
    { lat: -15, lon: 15, color: [0.85, 0.2, 0.8] },
    { lat: 10, lon: -20, color: [0.2, 0.75, 0.85] },
    { lat: 60, lon: 45, color: [0.92, 0.92, 0.92] },
];

/** Latitude/longitude (degrees) → ECEF position on a sphere of `r`, with +Z = north pole. */
function ecef(latDeg: number, lonDeg: number, r: number): { x: number; y: number; z: number } {
    const lat = (latDeg * Math.PI) / 180;
    const lon = (lonDeg * Math.PI) / 180;
    const cosLat = Math.cos(lat);
    return { x: r * cosLat * Math.cos(lon), y: r * cosLat * Math.sin(lon), z: r * Math.sin(lat) };
}

async function main(): Promise<void> {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    scene.clearColor = { r: 0.02, g: 0.02, b: 0.05, a: 1 };

    const cam = createGeospatialCamera({ planetRadius: PLANET_RADIUS });
    cam.fov = 0.8;
    cam.nearPlane = 1;
    cam.farPlane = PLANET_RADIUS * 16;
    setGeospatialOrientation(cam, {
        center: ecef(CENTER_LAT, CENTER_LON, PLANET_RADIUS),
        radius: CAMERA_RADIUS,
        yaw: CAMERA_YAW,
        pitch: CAMERA_PITCH,
    });
    scene.camera = cam;
    attachGeospatialControls(cam, canvas, scene);

    addToScene(scene, createHemisphericLight([0, 1, 0], 1.0));

    const globe = createSphere(engine, { diameter: PLANET_RADIUS * 2, segments: 64 });
    const globeMat = createStandardMaterial();
    globeMat.diffuseColor = [0.2, 0.45, 0.85];
    globe.material = globeMat;
    addToScene(scene, globe);

    for (const m of MARKERS) {
        const box = createBox(engine, MARKER_SIZE);
        const mat = createStandardMaterial();
        mat.diffuseColor = m.color;
        box.material = mat;
        const p = ecef(m.lat, m.lon, PLANET_RADIUS + MARKER_SIZE / 2);
        box.position.set(p.x, p.y, p.z);
        addToScene(scene, box);
    }

    await registerScene(scene);
    await startEngine(engine);
    canvas.dataset.drawCalls = String(engine.drawCallCount);
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
}

main().catch(console.error);
