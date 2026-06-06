// BJS reference for scene 217 — opt-in Material Plugins (BlackAndWhite grayscale).
//
// Mirrors the Lite scene217: a PBR sphere (left) and a Standard box (right), each
// with a BlackAndWhite `MaterialPluginBase` plugin that injects a grayscale
// conversion at CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR (WGSL). The grayscale weights
// match the Lite plugin exactly so the golden is the parity ground truth.
//
// The BJS PBR shader names the working color `finalColor` at that point, while
// the Standard shader names it `color`; the plugin is parametrised with the
// target variable accordingly.

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { Material } from "@babylonjs/core/Materials/material";
import type { Nullable } from "@babylonjs/core/types";
import { Scene } from "@babylonjs/core/scene";

/** BlackAndWhite material plugin — grayscale at CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR. */
class BlackAndWhitePlugin extends MaterialPluginBase {
    private readonly _colorVar: string;
    constructor(material: Material, colorVar: string) {
        super(material, "BlackAndWhite", 200, { BLACKANDWHITE: false });
        this._colorVar = colorVar;
        this._enable(true);
    }
    public override getClassName(): string {
        return "BlackAndWhitePlugin";
    }
    public override isCompatible(_shaderLanguage: ShaderLanguage): boolean {
        // This plugin only ships WGSL, used by the WebGPU engine.
        return true;
    }
    public override getCustomCode(shaderType: string, shaderLanguage: ShaderLanguage = ShaderLanguage.GLSL): Nullable<{ [pointName: string]: string }> {
        if (shaderType !== "fragment" || shaderLanguage !== ShaderLanguage.WGSL) {
            return null;
        }
        const v = this._colorVar;
        return {
            CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
let bwLuma = dot(${v}.rgb, vec3<f32>(0.3, 0.59, 0.11));
${v} = vec4f(bwLuma, bwLuma, bwLuma, ${v}.a);`,
        };
    }
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.35, 0.45, 0.6, 1);

    const cam = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 2.5, 7, Vector3.Zero(), scene);
    cam.setTarget(Vector3.Zero());

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.7;
    const dir = new DirectionalLight("dir", new Vector3(-0.5, -1, -0.6), scene);
    dir.intensity = 0.9;

    // PBR sphere (left) — warm red dielectric, grayscaled by the plugin.
    const pbrMat = new PBRMaterial("pbrMat", scene);
    pbrMat.albedoColor = new Color3(0.85, 0.2, 0.15);
    pbrMat.metallic = 0.0;
    pbrMat.roughness = 0.4;
    pbrMat.usePhysicalLightFalloff = false;
    new BlackAndWhitePlugin(pbrMat, "finalColor");

    const sphere = MeshBuilder.CreateSphere("sphere", { diameter: 2.2, segments: 48 }, scene);
    sphere.position = new Vector3(-1.5, 0, 0);
    sphere.material = pbrMat;

    // Standard box (right) — blue diffuse, grayscaled by the same plugin.
    const stdMat = new StandardMaterial("stdMat", scene);
    stdMat.diffuseColor = new Color3(0.15, 0.3, 0.85);
    stdMat.specularColor = new Color3(0.4, 0.4, 0.4);
    new BlackAndWhitePlugin(stdMat, "color");

    const box = MeshBuilder.CreateBox("box", { size: 2 }, scene);
    box.position = new Vector3(1.5, 0, 0);
    box.material = stdMat;

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
