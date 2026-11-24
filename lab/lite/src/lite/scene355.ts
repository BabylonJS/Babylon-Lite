import { enableOrthographicCamera } from "babylon-lite";
import { reportSsaoSceneError, runSsaoScene } from "../shared/ssao-scene.js";

runSsaoScene((camera) => {
    enableOrthographicCamera(camera, { halfHeight: 0.6 });
}).catch(reportSsaoSceneError);
