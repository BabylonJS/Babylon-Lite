// BJS reference for scene 225 — Babylon.js GeospatialCamera oracle.
//
// Mirrors the Lite scene225: a blue globe (sphere radius PLANET_RADIUS at the
// world origin) orbited by a GeospatialCamera anchored to a surface point, with
// six coloured marker cubes on the surface to make yaw/pitch/radius observable.
// The camera is set to the SAME fixed center/radius/yaw/pitch (no controls
// attached) so both engines render an identical frame.
//
// IMPORTANT — property order: GeospatialCamera clamps pitch against the effective
// pitch-max for the CURRENT radius (pitch is disabled as the camera zooms out).
// We therefore set `radius` before `pitch` so the requested pitch is allowed.
// Lite applies all four in a single setOrientation call (radius-aware), so the
// final state is identical.

import { GeospatialCamera } from "@babylonjs/core/Cameras/geospatialCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Scene } from "@babylonjs/core/scene";

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
function ecef(latDeg: number, lonDeg: number, r: number): Vector3 {
    const lat = (latDeg * Math.PI) / 180;
    const lon = (lonDeg * Math.PI) / 180;
    const cosLat = Math.cos(lat);
    return new Vector3(r * cosLat * Math.cos(lon), r * cosLat * Math.sin(lon), r * Math.sin(lat));
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.02, 0.02, 0.05, 1);

    const cam = new GeospatialCamera("cam", scene, { planetRadius: PLANET_RADIUS });
    cam.fov = 0.8;
    cam.minZ = 1;
    cam.maxZ = PLANET_RADIUS * 16;
    cam.center = ecef(CENTER_LAT, CENTER_LON, PLANET_RADIUS);
    cam.radius = CAMERA_RADIUS;
    cam.yaw = CAMERA_YAW;
    cam.pitch = CAMERA_PITCH;

    new HemisphericLight("h", new Vector3(0, 1, 0), scene);

    const globe = MeshBuilder.CreateSphere("globe", { diameter: PLANET_RADIUS * 2, segments: 64 }, scene);
    const globeMat = new StandardMaterial("globeMat", scene);
    globeMat.diffuseColor = new Color3(0.2, 0.45, 0.85);
    globe.material = globeMat;

    for (let i = 0; i < MARKERS.length; i++) {
        const m = MARKERS[i]!;
        const box = MeshBuilder.CreateBox("marker" + i, { size: MARKER_SIZE }, scene);
        const mat = new StandardMaterial("markerMat" + i, scene);
        mat.diffuseColor = new Color3(m.color[0], m.color[1], m.color[2]);
        box.material = mat;
        box.position = ecef(m.lat, m.lon, PLANET_RADIUS + MARKER_SIZE / 2);
    }

    const eng = engine as any;
    scene.onBeforeRenderObservable.add(() => {
        if (eng._drawCalls) eng._drawCalls.fetchNewFrame();
    });
    scene.onAfterRenderObservable.add(() => {
        canvas.dataset.drawCalls = String(eng._drawCalls ? eng._drawCalls.current : 0);
    });
    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
