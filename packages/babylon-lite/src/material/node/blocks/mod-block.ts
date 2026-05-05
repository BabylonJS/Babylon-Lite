import { binaryEmitter } from "./_math-factory.js";

export const emitter = binaryEmitter("ModBlock", (l, r) => `${l} % ${r}`);
