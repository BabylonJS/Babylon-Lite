// Full Lottie render worker entry — runs INSIDE the worker. Wires the full player factory (fill +
// text + image, activated from the document's layer kinds) into the shared dispatcher. This module is the
// target of `new Worker(new URL("../worker/full.worker.js", import.meta.url))` from the main-thread client;
// a bundler emits it as its own worker chunk.
//
// Importing `createLottiePlayer` pulls in every renderer — correct for the full worker, which must
// render any supported animation (the non-worker player is only for testing/measurement).

import { createLottiePlayer, resolveImageAssetUrls } from "../player/full-player.js";
import { runLottieWorker } from "./dispatch.js";

runLottieWorker(createLottiePlayer, resolveImageAssetUrls);
