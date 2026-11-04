/** Scene 262 - NPE 'Basic Properties - Size' graph. Converted from a classic ParticleSystem via
 * BABYLON.ConvertToNodeParticleSystemSetAsync (mirrors Babylon.js visual test #MP4MLC#0).
 * Checked-in scene data; excluded from bundle-size accounting like the *-nme.ts payloads. */
export const SCENE262_NPE_JSON = {
  "tags": null,
  "name": "npe",
  "editorData": null,
  "customType": "BABYLON.NodeParticleSystemSet",
  "blocks": [
    {
      "customType": "BABYLON.SystemBlock",
      "id": 44,
      "name": "particles",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "particle",
          "inputName": "particle",
          "targetBlockId": 40,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "emitRate",
          "valueType": "number",
          "value": 10
        },
        {
          "name": "texture",
          "inputName": "texture",
          "targetBlockId": 45,
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
      "updateSpeed": 0.01,
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
      "id": 40,
      "name": "Position Update",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "particle",
          "inputName": "particle",
          "targetBlockId": 35,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "position",
          "inputName": "position",
          "targetBlockId": 41,
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
      "id": 35,
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
          "targetBlockId": 39,
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
      "customType": "BABYLON.BoxShapeBlock",
      "id": 27,
      "name": "Box Shape",
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
          "name": "direction1",
          "valueType": "BABYLON.Vector3",
          "value": [
            0,
            1,
            0
          ],
          "inputName": "direction1",
          "targetBlockId": 28,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "direction2",
          "valueType": "BABYLON.Vector3",
          "value": [
            0,
            1,
            0
          ],
          "inputName": "direction2",
          "targetBlockId": 29,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "minEmitBox",
          "valueType": "BABYLON.Vector3",
          "value": [
            -0.5,
            -0.5,
            -0.5
          ],
          "inputName": "minEmitBox",
          "targetBlockId": 30,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "maxEmitBox",
          "valueType": "BABYLON.Vector3",
          "value": [
            0.5,
            0.5,
            0.5
          ],
          "inputName": "maxEmitBox",
          "targetBlockId": 31,
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
      "value": 1
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
      "value": 1
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
      "value": 1
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
        1,
        1,
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
        1,
        1,
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
        0,
        1
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
      "value": 0.05
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
      "value": 0.75
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 28,
      "name": "Direction 1",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 8,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "BABYLON.Vector3",
      "value": [
        0,
        1,
        0
      ]
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 29,
      "name": "Direction 2",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 8,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "BABYLON.Vector3",
      "value": [
        0,
        1,
        0
      ]
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 30,
      "name": "Min Emit Box",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 8,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "BABYLON.Vector3",
      "value": [
        -0.5,
        -0.5,
        -0.5
      ]
    },
    {
      "customType": "BABYLON.ParticleInputBlock",
      "id": 31,
      "name": "Max Emit Box",
      "visibleOnFrame": false,
      "inputs": [],
      "outputs": [
        {
          "name": "output"
        }
      ],
      "type": 8,
      "contextualValue": 0,
      "systemSource": 0,
      "min": 0,
      "max": 0,
      "groupInInspector": "",
      "displayInInspector": true,
      "valueType": "BABYLON.Vector3",
      "value": [
        0.5,
        0.5,
        0.5
      ]
    },
    {
      "customType": "BABYLON.ParticleConverterBlock",
      "id": 39,
      "name": "Compose Color",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "color "
        },
        {
          "name": "xyz ",
          "inputName": "xyz ",
          "targetBlockId": 36,
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
          "targetBlockId": 37,
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
      "id": 36,
      "name": "Decompose Color",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "color ",
          "inputName": "color ",
          "targetBlockId": 32,
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
      "id": 32,
      "name": "Add Color",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "left",
          "inputName": "left",
          "targetBlockId": 33,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "right",
          "inputName": "right",
          "targetBlockId": 34,
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
      "id": 33,
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
      "id": 34,
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
      "id": 37,
      "name": "Alpha >= 0",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "left",
          "inputName": "left",
          "targetBlockId": 36,
          "targetConnectionName": "w",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "right",
          "inputName": "right",
          "targetBlockId": 38,
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
      "id": 38,
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
      "id": 41,
      "name": "Add Position",
      "visibleOnFrame": false,
      "inputs": [
        {
          "name": "left",
          "inputName": "left",
          "targetBlockId": 42,
          "targetConnectionName": "output",
          "isExposedOnFrame": true,
          "exposedPortPosition": -1
        },
        {
          "name": "right",
          "inputName": "right",
          "targetBlockId": 43,
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
      "id": 42,
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
      "id": 43,
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
      "id": 45,
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

