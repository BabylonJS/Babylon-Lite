import { LocalPlayer } from "@babylonjs/lottie-player";
import Lottie from "lottie-web";
import { createLottieWorkerPlayer, playWorkerAnimationAsync } from "../../dist/standalone.js";
import type { LottieFile } from "../../src/animation/lottie-raw.js";

const params = new URLSearchParams(location.search);
const fixture = params.get("fixture") ?? "strokes-and-fills.json";
const playerKind = params.get("player") ?? "shapes";
const referenceKind = params.get("reference") ?? "babylon";
const loop = params.get("loop") !== "false";
const urlSource = params.get("urlSource") === "true";
const missingImage = params.get("missingImage") === "true";
const stage = document.getElementById("stage") as HTMLDivElement;

function setState(state: "ready" | "error"): void {
    stage.dataset.state = state;
}

const fixtureUrl = `/fixtures/${fixture}`;
const response = await fetch(fixtureUrl);
const animation = (await response.json()) as LottieFile;
if (missingImage && animation.assets?.[0]) {
    animation.assets[0].u = "";
    animation.assets[0].p = "/fixtures/images/missing.png";
    animation.assets[0].e = 0;
}

if (playerKind === "reference") {
    if (referenceKind === "lottie-web") {
        const reference = Lottie.loadAnimation({
            container: stage,
            renderer: "canvas",
            loop,
            autoplay: true,
            ...(urlSource ? { path: fixtureUrl } : { animationData: animation }),
        });
        const readyEvent = animation.assets?.some((asset) => asset.p) ? "loaded_images" : loop ? "DOMLoaded" : "complete";
        reference.addEventListener(readyEvent, () => setState("ready"));
    } else {
        const player = new LocalPlayer();
        await player.playAnimationAsync({
            container: stage,
            animationSource: animation as never,
            variables: null,
            configuration: {
                backgroundColor: { r: 0, g: 0, b: 0, a: 0 },
                loopAnimation: loop,
            },
            onFirstRender: () => setState("ready"),
        });
    }
} else {
    const worker = playerKind === "full" ? "/workers/full.worker.js" : "/workers/shapes.worker.js";
    const player = createLottieWorkerPlayer({ workerUrl: worker });
    await playWorkerAnimationAsync(player, {
        container: stage,
        animationSource: urlSource ? fixtureUrl : animation,
        loop,
        onFirstRender: () => {
            if (loop) {
                setState("ready");
            } else {
                setTimeout(() => setState("ready"), ((animation.op - animation.ip) / animation.fr) * 1000 + 100);
            }
        },
        onError: () => setState("error"),
    });
}
