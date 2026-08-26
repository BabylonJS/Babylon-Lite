// Shapes-only Lottie render worker entry — runs INSIDE the worker. Wires the shapes-only player
// factory (fill renderer alone: shapes, solids, gradients, strokes, masks, morphs) into the shared
// dispatcher. It is the target of `new Worker(new URL("../worker/shapes.worker.js", import.meta.url))` from
// the shapes client; a bundler emits it as its own worker chunk.
//
// Because this module imports only `createShapePlayer`, its graph never reaches the text or image
// renderers (nor the babylon-lite-gl texture path they pull in), so the shapes worker chunk stays
// minimal — the worker counterpart of the `@babylonjs/lottie-player/shapes` entry, for splashscreens.

import { createShapePlayer } from "../player/shapes-player.js";
import { runLottieWorker } from "./dispatch.js";

runLottieWorker(createShapePlayer);
