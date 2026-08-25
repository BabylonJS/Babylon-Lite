import { ThinEngine } from "@babylonjs/core/Engines/thinEngine.js";
import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer.js";
import { HtmlElementTexture } from "@babylonjs/core/Materials/Textures/htmlElementTexture.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
// Side-effect import: HtmlElementTexture wraps a canvas via createDynamicTexture +
// updateDynamicTexture (engine.dynamicTexture extension).
import "@babylonjs/core/Engines/Extensions/engine.dynamicTexture.js";

/**
 * Babylon.js reference for GL Scene 6 — HTML-Element Texture.
 *
 * Reproduces lab/gl/src/scene6.ts (which uses @babylonjs/lite-gl's
 * createHtmlElementTexture + updateHtmlElementTexture) with Babylon's
 * `HtmlElementTexture`, so the parity harness can diff the two pixel-for-pixel.
 *
 * Why this matches lite-gl exactly:
 *  - Geometry / UV / context / size: identical to the scene1 reference (default
 *    EffectRenderer fullscreen quad, postprocess vUV, opaque buffer, hwScaling=1).
 *  - Surface: the SAME 512×512 2D canvas, drawn by a byte-identical drawSurface()
 *    (including the "Lite GL" title). Both pages run in the same browser, so the
 *    Canvas2D rasterisation (gradients, text, AA) is identical.
 *  - Sampling: BILINEAR (LINEAR min+mag, no mipmaps) + CLAMP wrap, matching
 *    lite-gl's createHtmlElementTexture. (Babylon textures default to WRAP, which
 *    would differ from lite at the very edge pixels under LINEAR filtering, so we
 *    force CLAMP.)
 *  - Orientation: lite-gl uploads the canvas with invertY=FALSE (canvas top row →
 *    texture t=0) and the scene6 fragment flips V (`1.0 - vUv.y`) to display it
 *    upright. Babylon's `HtmlElementTexture.update()` uploads a canvas with
 *    invertY=TRUE (canvas top row → texture t=1), so this reference samples the
 *    texture DIRECTLY (no in-shader flip). invertY=true + direct sampling is the
 *    exact mirror of invertY=false + flipped sampling: both map screen-top to
 *    canvas-top, producing the SAME upright image.
 *
 * Determinism: ?seekTime=<seconds> repaints the surface at t=seekTime, re-uploads
 * the texture, renders exactly ONE frame, then stamps dataset.animationFrozen and
 * stops the loop.
 */

const TAU = Math.PI * 2;
const SURFACE_SIZE = 512;

// ES1.00 form of scene6's fragment, WITHOUT the in-shader V-flip (see header).
const FRAGMENT_SHADER = `
precision highp float;
varying vec2 vUV;
uniform sampler2D uTex;
void main(void) {
    // Babylon's HtmlElementTexture uploads the canvas with invertY=true, so the
    // canvas top row is at t=1 — sample directly to display it upright (the exact
    // mirror of lite-gl's invertY=false upload + (1.0 - vUv.y) flip).
    vec3 c = texture2D(uTex, vUV).rgb;
    gl_FragColor = vec4(c, 1.0);
}`;

/** Parse the parity harness's `?seekTime=<seconds>` query param (null when absent). */
function parseSeekTime(): number | null {
    const raw = new URLSearchParams(window.location.search).get("seekTime");
    if (raw === null) {
        return null;
    }
    const seconds = Number.parseFloat(raw);
    return Number.isFinite(seconds) ? seconds : null;
}

(function () {
    const initStart = performance.now();
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

    const engine = new ThinEngine(canvas, false, { alpha: false, premultipliedAlpha: false, stencil: false }, false);

    // Offscreen 2D canvas that backs the dynamic texture (same as scene6).
    const surface = document.createElement("canvas");
    surface.width = SURFACE_SIZE;
    surface.height = SURFACE_SIZE;
    const ctx = surface.getContext("2d");
    if (ctx === null) {
        throw new Error("babylon-ref-scene6: 2D context unavailable for the dynamic texture");
    }

    /** Repaint the offscreen 2D canvas for time `t` — byte-identical to scene6. */
    function drawSurface(t: number): void {
        if (ctx === null) {
            return;
        }
        const bg = ctx.createLinearGradient(0, 0, 0, SURFACE_SIZE);
        bg.addColorStop(0, "#10203a");
        bg.addColorStop(1, "#241033");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, SURFACE_SIZE, SURFACE_SIZE);

        // Faint reference grid.
        ctx.strokeStyle = "rgba(255,255,255,0.06)";
        ctx.lineWidth = 1;
        for (let i = 0; i <= SURFACE_SIZE; i += 32) {
            ctx.beginPath();
            ctx.moveTo(i, 0);
            ctx.lineTo(i, SURFACE_SIZE);
            ctx.moveTo(0, i);
            ctx.lineTo(SURFACE_SIZE, i);
            ctx.stroke();
        }

        // Orbiting colour discs.
        for (let i = 0; i < 6; i++) {
            const x = 256 + 150 * Math.cos(t * 0.7 + i * 1.05);
            const y = 320 + 120 * Math.sin(t * 0.9 + i * 1.05);
            ctx.beginPath();
            ctx.arc(x, y, 34, 0, TAU);
            ctx.fillStyle = "hsl(" + ((((i * 60 + t * 40) % 360) + 360) % 360) + ", 80%, 60%)";
            ctx.fill();
        }

        // Rotating sweep hand to make the animation (and orientation) obvious.
        ctx.save();
        ctx.translate(256, 340);
        ctx.rotate(t * 1.2);
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, -120);
        ctx.stroke();
        ctx.restore();

        // Title near the TOP — verifies upright orientation in the thumbnail.
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 72px sans-serif";
        ctx.fillText("Lite GL", 256, 96 + 6 * Math.sin(t * 2));
        ctx.font = "26px sans-serif";
        ctx.fillStyle = "#9fb4ff";
        ctx.fillText("html-texture", 256, 152);
    }

    const startMs = performance.now();
    drawSurface(0);

    // BILINEAR (LINEAR/LINEAR, no mipmaps), CLAMP wrap to match lite-gl exactly.
    const tex = new HtmlElementTexture("gl-scene6-html-texture-ref", surface, {
        engine,
        scene: null,
        generateMipMaps: false,
        samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
    });
    tex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    tex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;

    const renderer = new EffectRenderer(engine);
    const wrapper = new EffectWrapper({
        engine,
        name: "gl-scene6-html-texture-ref",
        fragmentShader: FRAGMENT_SHADER,
        samplers: ["uTex"],
        useShaderStore: false,
    });

    wrapper.onApplyObservable.add(() => {
        wrapper.effect.setTexture("uTex", tex);
    });

    const seekTime = parseSeekTime();
    let firstFrameDrawn = false;
    wrapper.effect.executeWhenCompiled(() => {
        engine.runRenderLoop(() => {
            engine.resize();
            const t = seekTime !== null ? seekTime : (performance.now() - startMs) / 1000;
            drawSurface(t);
            // Re-upload the canvas. invertY=true (Babylon's canvas default) puts
            // the canvas top row at texture t=1 — see the fragment header.
            tex.update(true);
            renderer.render(wrapper);
            if (!firstFrameDrawn) {
                firstFrameDrawn = true;
                canvas.dataset.drawCalls = "1";
                canvas.dataset.initMs = String(performance.now() - initStart);
                canvas.dataset.ready = "true";
                if (seekTime !== null) {
                    canvas.dataset.animationFrozen = "true";
                    engine.stopRenderLoop();
                }
            }
        });
    });

    window.addEventListener("resize", () => engine.resize());
})();
