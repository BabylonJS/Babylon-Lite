import { type LottieFeature } from "./feature";
import { ShapeLayerFeature } from "./layers/shapeLayer";

const ShapeLottieFeature = {
    id: "shape",
    layerTypes: [4],
    shapeLayer: ShapeLayerFeature,
} as const satisfies LottieFeature;

export default ShapeLottieFeature;
