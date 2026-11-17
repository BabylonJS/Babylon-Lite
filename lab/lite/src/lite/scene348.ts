import { reportSsaoSceneError, runSsaoScene } from "../shared/ssao-scene.js";

runSsaoScene().catch(reportSsaoSceneError);
