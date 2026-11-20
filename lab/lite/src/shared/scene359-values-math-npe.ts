/** Scene 359 - NPE values and math graph. A sprite-sheet fountain whose motion, colour, size, and sprite cell are
 * computed entirely by the value/math block family: Trigonometry (step-scaled Sin wobble), NLerp + SmoothStep + NumberMath Pow
 * (normalized colour ramp), VectorMath Distance/Dot + Clamp + Step (size), an Int-left Math block whose `| 0`
 * truncation quantizes size into age bands, and UpdateSpriteCellIndex driven by FloatToInt, the sprite-cell
 * contextual sources, and an Int NumberMath Modulo. Checked-in scene data; excluded from bundle-size accounting. */

/** Number of deterministic simulation steps before the frame is frozen. */
export const SCENE359_STEPS = 150;

/** Serialized Scene 359 graph. */
export const SCENE359_NPE_JSON = {
    name: "Scene 359 values and math",
    customType: "BABYLON.NodeParticleSystemSet",
    blocks: [
        {
            customType: "BABYLON.SystemBlock",
            id: 1,
            name: "Values math system",
            capacity: 300,
            manualEmitCount: -1,
            blendMode: 0,
            updateSpeed: 0.02,
            preWarmCycles: 0,
            preWarmStepOffset: 1,
            isBillboardBased: true,
            billBoardMode: 7,
            isLocal: false,
            inputs: [
                {
                    name: "particle",
                    inputName: "particle",
                    targetBlockId: 8,
                    targetConnectionName: "output",
                },
                {
                    name: "emitRate",
                    valueType: "number",
                    value: 50,
                },
                {
                    name: "texture",
                    inputName: "texture",
                    targetBlockId: 9,
                    targetConnectionName: "texture",
                },
                {
                    name: "targetStopDuration",
                    valueType: "number",
                    value: 0,
                },
            ],
            outputs: [
                {
                    name: "system",
                },
            ],
        },
        {
            customType: "BABYLON.CreateParticleBlock",
            id: 2,
            name: "Create particle",
            inputs: [
                {
                    name: "emitPower",
                    valueType: "number",
                    value: 1,
                },
                {
                    name: "lifeTime",
                    valueType: "number",
                    value: 2,
                },
                {
                    name: "color",
                    valueType: "BABYLON.Color4",
                    value: [1, 1, 1, 1],
                },
                {
                    name: "colorDead",
                    valueType: "BABYLON.Color4",
                    value: [0, 0, 0, 0],
                },
                {
                    name: "scale",
                    valueType: "BABYLON.Vector2",
                    value: [1, 1],
                },
                {
                    name: "angle",
                    valueType: "number",
                    value: 0,
                },
                {
                    name: "size",
                    valueType: "number",
                    value: 0.3,
                },
            ],
            outputs: [
                {
                    name: "particle",
                },
            ],
        },
        {
            customType: "BABYLON.PointShapeBlock",
            id: 3,
            name: "Fountain point",
            inputs: [
                {
                    name: "particle",
                    inputName: "particle",
                    targetBlockId: 2,
                    targetConnectionName: "particle",
                },
                {
                    name: "direction1",
                    valueType: "BABYLON.Vector3",
                    value: [-0.9, 1.7, -0.4],
                },
                {
                    name: "direction2",
                    valueType: "BABYLON.Vector3",
                    value: [0.9, 2.3, 0.4],
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.SetupSpriteSheetBlock",
            id: 4,
            name: "Sprite sheet",
            inputs: [
                {
                    name: "particle",
                    inputName: "particle",
                    targetBlockId: 3,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
            width: 64,
            height: 64,
            start: 0,
            end: 9,
            spriteCellChangeSpeed: 1,
            loop: true,
            randomStartCell: false,
        },
        {
            customType: "BABYLON.UpdatePositionBlock",
            id: 5,
            name: "Wobbled position",
            inputs: [
                {
                    name: "particle",
                    inputName: "particle",
                    targetBlockId: 4,
                    targetConnectionName: "output",
                },
                {
                    name: "position",
                    inputName: "position",
                    targetBlockId: 41,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.UpdateColorBlock",
            id: 6,
            name: "Normalized colour ramp",
            inputs: [
                {
                    name: "particle",
                    inputName: "particle",
                    targetBlockId: 5,
                    targetConnectionName: "output",
                },
                {
                    name: "color",
                    inputName: "color",
                    targetBlockId: 50,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.UpdateSizeBlock",
            id: 7,
            name: "Banded size",
            inputs: [
                {
                    name: "particle",
                    inputName: "particle",
                    targetBlockId: 6,
                    targetConnectionName: "output",
                },
                {
                    name: "size",
                    inputName: "size",
                    targetBlockId: 69,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.UpdateSpriteCellIndexBlock",
            id: 8,
            name: "Math sprite cell",
            inputs: [
                {
                    name: "particle",
                    inputName: "particle",
                    targetBlockId: 7,
                    targetConnectionName: "output",
                },
                {
                    name: "cellIndex",
                    inputName: "cellIndex",
                    targetBlockId: 76,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleTextureSourceBlock",
            id: 9,
            name: "Texture",
            inputs: [],
            outputs: [
                {
                    name: "texture",
                },
            ],
            url: "textures/player.png",
            serializedCachedData: false,
            invertY: true,
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 20,
            name: "Position",
            type: 8,
            contextualValue: 1,
            systemSource: 0,
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 21,
            name: "Scaled direction",
            type: 8,
            contextualValue: 6,
            systemSource: 0,
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 22,
            name: "Direction",
            type: 8,
            contextualValue: 2,
            systemSource: 0,
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 23,
            name: "Age",
            type: 2,
            contextualValue: 3,
            systemSource: 0,
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 24,
            name: "Age gradient",
            type: 2,
            contextualValue: 8,
            systemSource: 0,
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 25,
            name: "Sprite cell start",
            type: 1,
            contextualValue: 17,
            systemSource: 0,
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 26,
            name: "Sprite cell end",
            type: 1,
            contextualValue: 18,
            systemSource: 0,
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 29,
            name: "Direction scale",
            type: 2,
            contextualValue: 32,
            systemSource: 0,
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 27,
            name: "Origin",
            type: 8,
            contextualValue: 0,
            systemSource: 0,
            valueType: "BABYLON.Vector3",
            value: [0, 0, 0],
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 28,
            name: "Right axis",
            type: 8,
            contextualValue: 0,
            systemSource: 0,
            valueType: "BABYLON.Vector3",
            value: [1, 0, 0],
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleMathBlock",
            id: 40,
            name: "Step position",
            operation: 0,
            inputs: [
                {
                    name: "left",
                    inputName: "left",
                    targetBlockId: 20,
                    targetConnectionName: "output",
                },
                {
                    name: "right",
                    inputName: "right",
                    targetBlockId: 21,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleMathBlock",
            id: 42,
            name: "Wobble phase",
            operation: 2,
            inputs: [
                {
                    name: "left",
                    inputName: "left",
                    targetBlockId: 23,
                    targetConnectionName: "output",
                },
                {
                    name: "right",
                    inputName: "right",
                    targetBlockId: 46,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 46,
            name: "Wobble frequency",
            type: 2,
            contextualValue: 0,
            systemSource: 0,
            valueType: "number",
            value: 7,
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleTrigonometryBlock",
            id: 43,
            name: "Wobble sin",
            operation: 1,
            inputs: [
                {
                    name: "input",
                    inputName: "input",
                    targetBlockId: 42,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleMathBlock",
            id: 47,
            name: "Scaled wobble",
            operation: 2,
            inputs: [
                {
                    name: "left",
                    inputName: "left",
                    targetBlockId: 43,
                    targetConnectionName: "output",
                },
                {
                    name: "right",
                    inputName: "right",
                    targetBlockId: 29,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 45,
            name: "Wobble axis",
            type: 8,
            contextualValue: 0,
            systemSource: 0,
            valueType: "BABYLON.Vector3",
            value: [0.6, 0, 0.3],
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleMathBlock",
            id: 44,
            name: "Wobble offset",
            operation: 2,
            inputs: [
                {
                    name: "left",
                    inputName: "left",
                    targetBlockId: 45,
                    targetConnectionName: "output",
                },
                {
                    name: "right",
                    inputName: "right",
                    targetBlockId: 47,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleMathBlock",
            id: 41,
            name: "Wobbled position",
            operation: 0,
            inputs: [
                {
                    name: "left",
                    inputName: "left",
                    targetBlockId: 40,
                    targetConnectionName: "output",
                },
                {
                    name: "right",
                    inputName: "right",
                    targetBlockId: 44,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 51,
            name: "Warm",
            type: 128,
            contextualValue: 0,
            systemSource: 0,
            valueType: "BABYLON.Color4",
            value: [1, 0.55, 0.15, 1],
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 52,
            name: "Cool",
            type: 128,
            contextualValue: 0,
            systemSource: 0,
            valueType: "BABYLON.Color4",
            value: [0.2, 0.45, 1, 1],
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 54,
            name: "Ramp exponent",
            type: 2,
            contextualValue: 0,
            systemSource: 0,
            valueType: "number",
            value: 0.7,
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleNumberMathBlock",
            id: 53,
            name: "Ramp pow",
            operation: 1,
            inputs: [
                {
                    name: "left",
                    inputName: "left",
                    targetBlockId: 24,
                    targetConnectionName: "output",
                },
                {
                    name: "right",
                    inputName: "right",
                    targetBlockId: 54,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleSmoothStepBlock",
            id: 55,
            name: "Ramp smooth step",
            inputs: [
                {
                    name: "value",
                    inputName: "value",
                    targetBlockId: 53,
                    targetConnectionName: "output",
                },
                {
                    name: "edge0",
                    valueType: "number",
                    value: 0.15,
                },
                {
                    name: "edge1",
                    valueType: "number",
                    value: 0.85,
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleNLerpBlock",
            id: 50,
            name: "Colour nlerp",
            inputs: [
                {
                    name: "left",
                    inputName: "left",
                    targetBlockId: 51,
                    targetConnectionName: "output",
                },
                {
                    name: "right",
                    inputName: "right",
                    targetBlockId: 52,
                    targetConnectionName: "output",
                },
                {
                    name: "gradient",
                    inputName: "gradient",
                    targetBlockId: 55,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleVectorMathBlock",
            id: 60,
            name: "Emitter distance",
            operation: 1,
            inputs: [
                {
                    name: "left",
                    inputName: "left",
                    targetBlockId: 20,
                    targetConnectionName: "output",
                },
                {
                    name: "right",
                    inputName: "right",
                    targetBlockId: 27,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 62,
            name: "Distance scale",
            type: 2,
            contextualValue: 0,
            systemSource: 0,
            valueType: "number",
            value: 0.14,
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleMathBlock",
            id: 61,
            name: "Scaled distance",
            operation: 2,
            inputs: [
                {
                    name: "left",
                    inputName: "left",
                    targetBlockId: 60,
                    targetConnectionName: "output",
                },
                {
                    name: "right",
                    inputName: "right",
                    targetBlockId: 62,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleClampBlock",
            id: 63,
            name: "Distance clamp",
            inputs: [
                {
                    name: "value",
                    inputName: "value",
                    targetBlockId: 61,
                    targetConnectionName: "output",
                },
                {
                    name: "min",
                    valueType: "number",
                    value: 0.12,
                },
                {
                    name: "max",
                    valueType: "number",
                    value: 0.32,
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 64,
            name: "Band count",
            type: 1,
            contextualValue: 0,
            systemSource: 0,
            valueType: "number",
            value: 3,
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleMathBlock",
            id: 65,
            name: "Age band",
            operation: 2,
            inputs: [
                {
                    name: "left",
                    inputName: "left",
                    targetBlockId: 64,
                    targetConnectionName: "output",
                },
                {
                    name: "right",
                    inputName: "right",
                    targetBlockId: 24,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 66,
            name: "Band step",
            type: 2,
            contextualValue: 0,
            systemSource: 0,
            valueType: "number",
            value: 0.07,
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleMathBlock",
            id: 67,
            name: "Band size",
            operation: 2,
            inputs: [
                {
                    name: "left",
                    inputName: "left",
                    targetBlockId: 65,
                    targetConnectionName: "output",
                },
                {
                    name: "right",
                    inputName: "right",
                    targetBlockId: 66,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleMathBlock",
            id: 68,
            name: "Base size",
            operation: 0,
            inputs: [
                {
                    name: "left",
                    inputName: "left",
                    targetBlockId: 63,
                    targetConnectionName: "output",
                },
                {
                    name: "right",
                    inputName: "right",
                    targetBlockId: 67,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleVectorMathBlock",
            id: 70,
            name: "Rightward",
            operation: 0,
            inputs: [
                {
                    name: "left",
                    inputName: "left",
                    targetBlockId: 22,
                    targetConnectionName: "output",
                },
                {
                    name: "right",
                    inputName: "right",
                    targetBlockId: 28,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleStepBlock",
            id: 71,
            name: "Rightward step",
            inputs: [
                {
                    name: "value",
                    inputName: "value",
                    targetBlockId: 70,
                    targetConnectionName: "output",
                },
                {
                    name: "edge",
                    valueType: "number",
                    value: 0,
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 72,
            name: "Rightward boost",
            type: 2,
            contextualValue: 0,
            systemSource: 0,
            valueType: "number",
            value: 0.4,
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleMathBlock",
            id: 73,
            name: "Boost",
            operation: 2,
            inputs: [
                {
                    name: "left",
                    inputName: "left",
                    targetBlockId: 71,
                    targetConnectionName: "output",
                },
                {
                    name: "right",
                    inputName: "right",
                    targetBlockId: 72,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 74,
            name: "Base factor",
            type: 2,
            contextualValue: 0,
            systemSource: 0,
            valueType: "number",
            value: 0.8,
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleMathBlock",
            id: 75,
            name: "Size factor",
            operation: 0,
            inputs: [
                {
                    name: "left",
                    inputName: "left",
                    targetBlockId: 73,
                    targetConnectionName: "output",
                },
                {
                    name: "right",
                    inputName: "right",
                    targetBlockId: 74,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleMathBlock",
            id: 69,
            name: "Banded size",
            operation: 2,
            inputs: [
                {
                    name: "left",
                    inputName: "left",
                    targetBlockId: 68,
                    targetConnectionName: "output",
                },
                {
                    name: "right",
                    inputName: "right",
                    targetBlockId: 75,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 80,
            name: "Frame rate",
            type: 2,
            contextualValue: 0,
            systemSource: 0,
            valueType: "number",
            value: 12,
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleMathBlock",
            id: 81,
            name: "Frame float",
            operation: 2,
            inputs: [
                {
                    name: "left",
                    inputName: "left",
                    targetBlockId: 23,
                    targetConnectionName: "output",
                },
                {
                    name: "right",
                    inputName: "right",
                    targetBlockId: 80,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleFloatToIntBlock",
            id: 82,
            name: "Frame int",
            operation: 2,
            inputs: [
                {
                    name: "input",
                    inputName: "input",
                    targetBlockId: 81,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleMathBlock",
            id: 83,
            name: "Offset frame",
            operation: 0,
            inputs: [
                {
                    name: "left",
                    inputName: "left",
                    targetBlockId: 25,
                    targetConnectionName: "output",
                },
                {
                    name: "right",
                    inputName: "right",
                    targetBlockId: 82,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleInputBlock",
            id: 84,
            name: "One",
            type: 1,
            contextualValue: 0,
            systemSource: 0,
            valueType: "number",
            value: 1,
            inputs: [],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleMathBlock",
            id: 85,
            name: "Cell count",
            operation: 0,
            inputs: [
                {
                    name: "left",
                    inputName: "left",
                    targetBlockId: 26,
                    targetConnectionName: "output",
                },
                {
                    name: "right",
                    inputName: "right",
                    targetBlockId: 84,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
        {
            customType: "BABYLON.ParticleNumberMathBlock",
            id: 76,
            name: "Wrapped cell",
            operation: 0,
            inputs: [
                {
                    name: "left",
                    inputName: "left",
                    targetBlockId: 83,
                    targetConnectionName: "output",
                },
                {
                    name: "right",
                    inputName: "right",
                    targetBlockId: 85,
                    targetConnectionName: "output",
                },
            ],
            outputs: [
                {
                    name: "output",
                },
            ],
        },
    ],
};
