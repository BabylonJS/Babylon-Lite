/** Scene 263 - NPE 'Emitters - Sphere' graph. Converted from a classic ParticleSystem (createSphereEmitter(3))
 * via BABYLON.ConvertToNodeParticleSystemSetAsync (mirrors Babylon.js visual test 'Particles - Emitters - Sphere',
 * playground #O9966G#0; emit rate reduced for a cleaner frozen frame). Checked-in scene data; excluded from
 * bundle-size accounting like the *-nme.ts payloads. */
export const SCENE263_NPE_JSON = {
  "tags": null,
  "name": "npe",
  "editorData": null,
  "customType": "BABYLON.NodeParticleSystemSet",
  "blocks": [
    {
      "customType": "BABYLON.SystemBlock",
      "id": 43,
      "name": "particles",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "particle",
          "inputName": "particle",
          "targetBlockId": 39,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "emitRate",
          "valueType": "number",
          "value": 150
        },
        {
          "name": "texture",
          "inputName": "texture",
          "targetBlockId": 44,
          "targetConnectionName": "texture",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "translationPivot",
          "valueType": "BABYLON.Vector2",
          "value": [
            0,
            0
          ]
        },
        {
          "name": "textureMask",
          "valueType": "BABYLON.Color4",
          "value": [
            1,
            1,
            1,
            1
          ]
        },
        {
          "name": "targetStopDuration",
          "valueType": "number",
          "value": 0
        },
        {
          "name": "onStart"
        },
        {
          "name": "onEnd"
        }
      ],
      "outputs": [
        {
          "name": "system"
        }
      ],
      "capacity": 2000,
      "manualEmitCount": -1,
      "blendMode": 0,
      "updateSpeed": 0.005,
      "preWarmCycles": 0,
      "preWarmStepOffset": 1,
      "isBillboardBased": true,
      "billBoardMode": 7,
      "isLocal": false,
      "disposeOnStop": false,
      "doNoStart": false,
      "renderingGroupId": 0,
      "startDelay": 0,
      "customShader": null
    },
    {
      "customType": "BABYLON.UpdatePositionBlock",
      "id": 39,
      "name": "Position Update",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "particle",
          "inputName": "particle",
          "targetBlockId": 34,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "position",
          "inputName": "position",
          "targetBlockId": 40,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        }
      ],
      "outputs": [
        {
          "name": "output"
        }
      ]
    },
    {
      "customType": "BABYLON.UpdateColorBlock",
      "id": 34,
      "name": "Color update",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "particle",
          "inputName": "particle",
          "targetBlockId": 27,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "color",
          "inputName": "color",
          "targetBlockId": 38,
          "targetConnectionName": "color",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        }
      ],
      "outputs": [
        {
          "name": "output"
        }
      ]
    },
    {
      "customType": "BABYLON.SphereShapeBlock",
      "id": 27,
      "name": "Sphere Shape",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "particle",
          "inputName": "particle",
          "targetBlockId": 4,
          "targetConnectionName": "particle",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "radius",
          "valueType": "number",
          "value": 1,
          "inputName": "radius",
          "targetBlockId": 28,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "radiusRange",
          "valueType": "number",
          "value": 1,
          "inputName": "radiusRange",
          "targetBlockId": 29,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "directionRandomizer",
          "valueType": "number",
          "value": 0,
          "inputName": "directionRandomizer",
          "targetBlockId": 30,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "direction1"
        },
        {
          "name": "direction2"
        }
      ],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "isHemispheric": false
    },
    {
      "customType": "BABYLON.CreateParticleBlock",
      "id": 4,
      "name": "Create Particle",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "emitPower",
          "valueType": "number",
          "value": 1,
          "inputName": "emitPower",
          "targetBlockId": 8,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "lifeTime",
          "valueType": "number",
          "value": 1,
          "inputName": "lifeTime",
          "targetBlockId": 5,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "color",
          "valueType": "BABYLON.Color4",
          "value": [
            1,
            1,
            1,
            1
          ],
          "inputName": "color",
          "targetBlockId": 23,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "colorDead",
          "valueType": "BABYLON.Color4",
          "value": [
            0,
            0,
            0,
            0
          ],
          "inputName": "colorDead",
          "targetBlockId": 26,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "scale",
          "valueType": "BABYLON.Vector2",
          "value": [
            1,
            1
          ],
          "inputName": "scale",
          "targetBlockId": 14,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "angle",
          "valueType": "number",
          "value": 0,
          "inputName": "angle",
          "targetBlockId": 17,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "size",
          "valueType": "number",
          "value": 1,
          "inputName": "size",
          "targetBlockId": 11,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        }
      ],
      "outputs": [
        {
          "name": "particle"
        }
      ]
    },
    {
      "customType": "BABYLON.ParticleRandomBlock",
      "id": 8,
      "name": "Random Emit Power",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "min",
          "valueType": "number",
          "value": 0,
          "inputName": "min",
          "targetBlockId": 9,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "max",
          "valueType": "number",
          "value": 1,
          "inputName": "max",
          "targetBlockId": 10,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        }
      ],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "lockMode": 1
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 9,
      "name": "Min Emit Power",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 2,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "number",
      "value": 1
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 10,
      "name": "Max Emit Power",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 2,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "number",
      "value": 3
    },
    {
      "customType": "BABYLON.ParticleRandomBlock",
      "id": 5,
      "name": "Random Lifetime",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "min",
          "valueType": "number",
          "value": 0,
          "inputName": "min",
          "targetBlockId": 6,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "max",
          "valueType": "number",
          "value": 1,
          "inputName": "max",
          "targetBlockId": 7,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        }
      ],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "lockMode": 1
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 6,
      "name": "Min Lifetime",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 2,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "number",
      "value": 0.3
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 7,
      "name": "Max Lifetime",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 2,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "number",
      "value": 1.5
    },
    {
      "customType": "BABYLON.ParticleLerpBlock",
      "id": 23,
      "name": "Lerp color",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "left",
          "inputName": "left",
          "targetBlockId": 24,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "right",
          "inputName": "right",
          "targetBlockId": 25,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "gradient",
          "valueType": "number",
          "value": 0,
          "inputName": "gradient",
          "targetBlockId": 20,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        }
      ],
      "outputs": [
        {
          "name": "output"
        }
      ]
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 24,
      "name": "Color 1",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 128,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "BABYLON.Color4",
      "value": [
        0.7,
        0.8,
        1,
        1
      ]
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 25,
      "name": "Color 2",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 128,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "BABYLON.Color4",
      "value": [
        0.2,
        0.5,
        1,
        1
      ]
    },
    {
      "customType": "BABYLON.ParticleRandomBlock",
      "id": 20,
      "name": "Random color step",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "min",
          "valueType": "number",
          "value": 0,
          "inputName": "min",
          "targetBlockId": 21,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "max",
          "valueType": "number",
          "value": 1,
          "inputName": "max",
          "targetBlockId": 22,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        }
      ],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "lockMode": 1
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 21,
      "name": "Min",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 2,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "number",
      "value": 0
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 22,
      "name": "Max",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 2,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "number",
      "value": 1
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 26,
      "name": "Dead Color",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 128,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "BABYLON.Color4",
      "value": [
        0,
        0,
        0.2,
        0
      ]
    },
    {
      "customType": "BABYLON.ParticleRandomBlock",
      "id": 14,
      "name": "Random Scale",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "min",
          "valueType": "number",
          "value": 0,
          "inputName": "min",
          "targetBlockId": 15,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "max",
          "valueType": "number",
          "value": 1,
          "inputName": "max",
          "targetBlockId": 16,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        }
      ],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "lockMode": 1
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 15,
      "name": "Min Scale",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 4,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "BABYLON.Vector2",
      "value": [
        1,
        1
      ]
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 16,
      "name": "Max Scale",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 4,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "BABYLON.Vector2",
      "value": [
        1,
        1
      ]
    },
    {
      "customType": "BABYLON.ParticleRandomBlock",
      "id": 17,
      "name": "Random Rotation",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "min",
          "valueType": "number",
          "value": 0,
          "inputName": "min",
          "targetBlockId": 18,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "max",
          "valueType": "number",
          "value": 1,
          "inputName": "max",
          "targetBlockId": 19,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        }
      ],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "lockMode": 1
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 18,
      "name": "Min Rotation",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 2,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "number",
      "value": 0
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 19,
      "name": "Max Rotation",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 2,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "number",
      "value": 0
    },
    {
      "customType": "BABYLON.ParticleRandomBlock",
      "id": 11,
      "name": "Random size",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "min",
          "valueType": "number",
          "value": 0,
          "inputName": "min",
          "targetBlockId": 12,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "max",
          "valueType": "number",
          "value": 1,
          "inputName": "max",
          "targetBlockId": 13,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        }
      ],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "lockMode": 1
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 12,
      "name": "Min size",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 2,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "number",
      "value": 0.1
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 13,
      "name": "Max size",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 2,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "number",
      "value": 0.5
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 28,
      "name": "Radius",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 2,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "number",
      "value": 3
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 29,
      "name": "Radius Range",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 2,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "number",
      "value": 1
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 30,
      "name": "Direction Randomizer",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 2,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "number",
      "value": 0
    },
    {
      "customType": "BABYLON.ParticleConverterBlock",
      "id": 38,
      "name": "Compose Color",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "color "
        },
        {
          "name": "xyz ",
          "inputName": "xyz ",
          "targetBlockId": 35,
          "targetConnectionName": "xyz",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "xy "
        },
        {
          "name": "zw "
        },
        {
          "name": "x "
        },
        {
          "name": "y "
        },
        {
          "name": "z "
        },
        {
          "name": "w ",
          "inputName": "w ",
          "targetBlockId": 36,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        }
      ],
      "outputs": [
        {
          "name": "color"
        },
        {
          "name": "xyz"
        },
        {
          "name": "xy"
        },
        {
          "name": "zw"
        },
        {
          "name": "x"
        },
        {
          "name": "y"
        },
        {
          "name": "z"
        },
        {
          "name": "w"
        }
      ]
    },
    {
      "customType": "BABYLON.ParticleConverterBlock",
      "id": 35,
      "name": "Decompose Color",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "color ",
          "inputName": "color ",
          "targetBlockId": 31,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "xyz "
        },
        {
          "name": "xy "
        },
        {
          "name": "zw "
        },
        {
          "name": "x "
        },
        {
          "name": "y "
        },
        {
          "name": "z "
        },
        {
          "name": "w "
        }
      ],
      "outputs": [
        {
          "name": "color"
        },
        {
          "name": "xyz"
        },
        {
          "name": "xy"
        },
        {
          "name": "zw"
        },
        {
          "name": "x"
        },
        {
          "name": "y"
        },
        {
          "name": "z"
        },
        {
          "name": "w"
        }
      ]
    },
    {
      "customType": "BABYLON.ParticleMathBlock",
      "id": 31,
      "name": "Add Color",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "left",
          "inputName": "left",
          "targetBlockId": 32,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "right",
          "inputName": "right",
          "targetBlockId": 33,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        }
      ],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "operation": 0
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 32,
      "name": "Color",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 128,
      "contextualValue": 5,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 33,
      "name": "Scaled Color Step",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 128,
      "contextualValue": 23,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true
    },
    {
      "customType": "BABYLON.ParticleMathBlock",
      "id": 36,
      "name": "Alpha >= 0",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "left",
          "inputName": "left",
          "targetBlockId": 35,
          "targetConnectionName": "w",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "right",
          "inputName": "right",
          "targetBlockId": 37,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        }
      ],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "operation": 4
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 37,
      "name": "Zero",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 2,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "number",
      "value": 0
    },
    {
      "customType": "BABYLON.ParticleMathBlock",
      "id": 40,
      "name": "Add Position",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "left",
          "inputName": "left",
          "targetBlockId": 41,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "right",
          "inputName": "right",
          "targetBlockId": 42,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        }
      ],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "operation": 0
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 41,
      "name": "Position",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 8,
      "contextualValue": 1,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 42,
      "name": "Scaled Direction",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 8,
      "contextualValue": 6,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true
    },
    {
      "customType": "BABYLON.ParticleTextureSourceBlock",
      "id": 44,
      "name": "Texture",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "texture"
        }
      ],
      "url": "textures/flare.png",
      "serializedCachedData": false,
      "invertY": true
    }
  ]
};
