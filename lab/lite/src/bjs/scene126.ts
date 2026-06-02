// Scene 126 — BJS reference for Gaussian Splatting material plugin.
// Loads Halo_Believe.splat (same data as scene 125) and applies a material
// plugin that overrides the final fragment color at CUSTOM_FRAGMENT_MAIN_END.
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader";
import { GaussianSplattingMaterial } from "@babylonjs/core/Materials/GaussianSplatting/gaussianSplattingMaterial";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import "@babylonjs/loaders/SPLAT/splatFileLoader";

const SPLAT_URL = "https://raw.githubusercontent.com/CedricGuillemet/dump/master/Halo_Believe.splat";

class SomeWorkingGsPlugin extends MaterialPluginBase {
    constructor(material: GaussianSplattingMaterial) {
        super(material, "someGsPlugin", 208, { GS_PLUGIN: true }, true, true);
        this._enable(true);
    }

    override isCompatible(shaderLanguage: ShaderLanguage): boolean {
        return shaderLanguage === ShaderLanguage.WGSL || shaderLanguage === ShaderLanguage.GLSL;
    }

    override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Record<string, string> | null {
        if (shaderType === "fragment") {
            if (shaderLanguage === ShaderLanguage.WGSL) {
                return {
                    CUSTOM_FRAGMENT_MAIN_END: `fragmentOutputs.color = vec4<f32>(1.0, 0.0, 0.0, 0.05);`,
                };
            }
            return {
                CUSTOM_FRAGMENT_MAIN_END: `gl_FragColor = vec4(1.0, 0.0, 0.0, 0.05);`,
            };
        }
        return null;
    }

    override getClassName(): string {
        return "SomeGsPlugin";
    }
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true });
    await engine.initAsync();

    const scene = new Scene(engine);
    scene.clearColor = new Color4(0, 0, 0, 1);

    const cam = new ArcRotateCamera("cam", 4.57, 1.29, 6, new Vector3(0, 0, 0), scene);
    cam.minZ = 0.1;
    cam.maxZ = 100;
    cam.attachControl(canvas, true);

    await ImportMeshAsync(SPLAT_URL, scene);
    const splat = scene.meshes[0]!;
    new SomeWorkingGsPlugin(splat.material as GaussianSplattingMaterial);

    await scene.whenReadyAsync();
    engine.runRenderLoop(() => scene.render());
    window.addEventListener("resize", () => engine.resize());

    const start = performance.now();
    while ((splat as unknown as { _canPostToWorker: boolean })._canPostToWorker !== true && performance.now() - start < 5_000) {
        await new Promise<void>((r) => setTimeout(r, 16));
    }
    await new Promise<void>((resolve) => scene.onAfterRenderObservable.addOnce(() => resolve()));

    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
});
