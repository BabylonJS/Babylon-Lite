import { Animation } from "@babylonjs/core/Animations/animation";
import "@babylonjs/core/Animations/animatable";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";

const FRAME_RATE = 10;
const END_FRAME = 2 * FRAME_RATE;
const BACKGROUND = "#1f2433";
const TRACK = "#596274";
const BOX = "#f2b84b";

interface AnimatedTarget {
    position: Vector3;
}

function resizeCanvas(canvas: HTMLCanvasElement): void {
    const width = Math.max(1, Math.floor(canvas.clientWidth));
    const height = Math.max(1, Math.floor(canvas.clientHeight));
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }
}

function draw(canvas: HTMLCanvasElement, target: AnimatedTarget): void {
    resizeCanvas(canvas);
    canvas.dataset.animatedX = target.position.x.toFixed(4);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        throw new Error("Scene 153 requires a 2D canvas context");
    }

    const w = canvas.width;
    const h = canvas.height;
    const y = h * 0.5;
    const centerX = w * 0.5;
    const scale = w * 0.18;
    const x = centerX + target.position.x * scale;
    const size = Math.max(28, Math.min(w, h) * 0.09);

    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = TRACK;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(centerX - 2 * scale, y);
    ctx.lineTo(centerX + 2 * scale, y);
    ctx.stroke();

    ctx.fillStyle = BOX;
    ctx.fillRect(x - size * 0.5, y - size * 0.5, size, size);
}

(async function () {
    const __initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = new NullEngine();
    const scene = new Scene(engine);
    new FreeCamera("camera", Vector3.Zero(), scene);
    const target: AnimatedTarget = { position: new Vector3(-2, 0, 0) };

    const xSlide = new Animation("standaloneXSlide", "position.x", FRAME_RATE, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
    xSlide.setKeys([
        { frame: 0, value: -2 },
        { frame: FRAME_RATE, value: 2 },
        { frame: END_FRAME, value: -2 },
    ]);
    const animatable = scene.beginDirectAnimation(target, [xSlide], 0, END_FRAME, true);

    engine.getDeltaTime = function () {
        return 16;
    };
    scene.useConstantAnimationDeltaTime = true;

    const seekTime = parseFloat(new URLSearchParams(window.location.search).get("seekTime") || "");
    if (Number.isFinite(seekTime)) {
        animatable.goToFrame(seekTime * FRAME_RATE);
        animatable.pause();
        draw(canvas, target);
        canvas.dataset.animationFrozen = "true";
    } else {
        scene.onAfterRenderObservable.add(() => draw(canvas, target));
        engine.runRenderLoop(() => scene.render());
    }

    window.addEventListener("resize", () => draw(canvas, target));
    draw(canvas, target);
    canvas.dataset.drawCalls = "0";
    canvas.dataset.initMs = String(performance.now() - __initStart);
    canvas.dataset.ready = "true";
})().catch(console.error);
