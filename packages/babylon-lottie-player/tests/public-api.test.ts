import { describe, expect, it } from "vitest";
import * as full from "../src/index.js";
import * as shapes from "../src/shapes.js";
import * as standalone from "../src/standalone.js";

const common = ["disposeWorkerPlayer", "playWorkerAnimationAsync"];

describe("public worker entries", () => {
    it("exports only the full bundler worker API from the package root", () => {
        expect(Object.keys(full).sort()).toEqual([...common, "createLottieWorkerPlayer"].sort());
    });

    it("exports only the shapes bundler worker API from /shapes", () => {
        expect(Object.keys(shapes).sort()).toEqual([...common, "createShapeWorkerPlayer"].sort());
    });

    it("exports one generic explicit-worker-source API", () => {
        expect(Object.keys(standalone).sort()).toEqual([...common, "createLottieWorkerPlayer"].sort());
    });
});
