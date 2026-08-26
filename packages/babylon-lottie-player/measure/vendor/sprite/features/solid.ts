import { type LottieFeature } from "./feature";
import { SolidLayerFeature } from "./layers/solidLayer";

const SolidLottieFeature = {
    id: "solid",
    layerTypes: [1],
    solidLayer: SolidLayerFeature,
} as const satisfies LottieFeature;

export default SolidLottieFeature;
