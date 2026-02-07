import * as THREE from './lib/three.module.js';
import { GLTFLoader } from './lib/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from './lib/jsm/loaders/FBXLoader.js';
import { OrbitControls } from './lib/jsm/controls/OrbitControls.js';
import { VRMALoader } from './lib/jsm/loaders/VRMALoader.js';
import { VRMLoaderPlugin, VRMUtils } from './lib/three-vrm.module.js';
import { loadBVHAnimation, loadMixamoAnimation, loadMMDAnimation } from './animationLoader.js';
import { MMDLoader } from './lib/jsm/loaders/MMDLoader.js';

import { getRequestHeaders, saveSettings, saveSettingsDebounced, sendMessageAsUser } from '../../../../script.js';
import { getContext, extension_settings, getApiUrl, doExtrasFetch, modules } from '../../../extensions.js';

import {
    MODULE_NAME,
    DEBUG_PREFIX,
    VRM_CANVAS_ID,
    FALLBACK_EXPRESSION,
    ANIMATION_FADE_TIME,
    SPRITE_DIV,
    VN_MODE_DIV,
    HITBOXES
} from "./constants.js";

import {
    currentChatMembers,
    getExpressionLabel
} from './utils.js';

import {
    delay
} from '../../../utils.js';

import {
    animations_files
} from './ui.js';

import {
    IDLE_MOVEMENT_CONFIGS,
    getIdleAnimationClip
} from './idleAnimations.js';

export {
    loadScene,
    loadAllModels,
    setModel,
    unloadModel,
    getVRM,
    setExpression,
    setMotion,
    setMotionSequence,
    setCursorPosition,
    setCursorTracking,
    playAnimationSequence,
    clearAnimationSequence,
    updateExpression,
    talk,
  updateModel,
  current_avatars,
  renderer,
  camera,
  VRM_CONTAINER_NAME,
  clearModelCache,
  clearAnimationCache,
  setLight,
  setBackground,
  cursorBasePoses
}

const VRM_CONTAINER_NAME = "VRM_CONTAINER";
const VRM_COLLIDER_NAME = "VRM_COLLIDER"

// Avatars
let current_avatars = {} // contain loaded avatar variables

// Caches
let models_cache = {};
let animations_cache = {};
let tts_lips_sync_job_id = 0;

// 3D Scene
let renderer = undefined;
let scene = undefined;
let camera = undefined;
let light = undefined;

// gltf and vrm
let currentInstanceId = 0;
let modelId = 0;
let clock = undefined;
const lookAtTarget = new THREE.Object3D();
const IDLE_ANIMS = ["idle", "breathe", "nod", "shrug", "think", "relax", "glance"];

// VRMA idle animation files cache
let vrmaIdleFiles = [];
let vrmaIdleCache = {}; // Cache loaded VRMA clips

const naturalIdleTimers = {};
const proceduralState = {};
const activeIdleAnimations = {}; // Track active procedural idle animations

// Store base bone poses to restore after VRMA animations
const vrmaBoneBasePoses = {};

// Track last idle animation completion time for cooldown
const lastIdleCompletionTime = {};

// Store base bone poses for cursor tracking
const cursorBasePoses = {};

let cursorTrackingEnabled = false;
let cursorPosition = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
let cursorTarget = new THREE.Object3D();
let blendedTarget = new THREE.Object3D();
let cursorTiltState = {};

// Cursor tracking functions
function setCursorPosition(x, y) {
  cursorPosition.x = x;
  cursorPosition.y = y;
}

function setCursorTracking(enabled) {
  cursorTrackingEnabled = enabled;
}

const activeNaturalMovements = {};

function applyNaturalMovementWithSlerp(vrm, boneName, movementConfig, character, modelId) {
    const bone = vrm.humanoid?.getNormalizedBoneNode(boneName);
    if (!bone) return;

    const startTime = Date.now();
    const baseQuat = bone.quaternion.clone();
    const baseEuler = new THREE.Euler().setFromQuaternion(baseQuat);
    const targetEuler = new THREE.Euler(
        baseEuler.x + movementConfig.x,
        baseEuler.y + movementConfig.y,
        baseEuler.z + movementConfig.z
    );
    const targetQuat = new THREE.Quaternion().setFromEuler(targetEuler);

    const rampDuration = 3500;
    const holdDuration = 5000;
    const totalDuration = rampDuration * 2 + holdDuration;

    function updateMovement() {
        if (current_avatars[character]?.vrm !== vrm ||
            current_avatars[character]?.["id"] !== modelId) {
            return;
        }

        const now = Date.now();
        const elapsed = now - startTime;

        if (elapsed >= totalDuration) {
            bone.quaternion.slerp(baseQuat, 0.03);
            if (bone.quaternion.angleTo(baseQuat) > 0.001) {
                requestAnimationFrame(updateMovement);
            } else {
                bone.quaternion.copy(baseQuat);
                delete activeNaturalMovements[character];
            }
            return;
        }

        let t = 0;
        if (elapsed < rampDuration) {
            t = easeInOutCubic(elapsed / rampDuration);
            bone.quaternion.slerpQuaternions(baseQuat, targetQuat, t);
        } else if (elapsed < rampDuration + holdDuration) {
            bone.quaternion.copy(targetQuat);
        } else {
            const rampDownElapsed = elapsed - rampDuration - holdDuration;
            t = easeInOutCubic(rampDownElapsed / rampDuration);
            bone.quaternion.slerpQuaternions(targetQuat, baseQuat, t);
        }

        requestAnimationFrame(updateMovement);
    }

    activeNaturalMovements[character] = updateMovement;
    updateMovement();
}

function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Helper to apply brief expressions during idle movements
function applyIdleExpression(vrm, character, expressionName, intensity = 0.7, duration = 2000, useClassifiedMapping = true) {
    if (!vrm.expressionManager) return;

    let finalExpression = expressionName;
    let finalIntensity = intensity;

    // Check if this is a winking expression - set flag to prevent automatic blink interference
    const isWinking = expressionName === 'blinkLeft' || expressionName === 'blinkRight';
    if (isWinking && current_avatars[character]) {
        current_avatars[character].winking = true;
        current_avatars[character].customWinking = true;
    }

    // Check if expressionName is a classified emotion and get mapping
    if (useClassifiedMapping) {
        const model_path = extension_settings.vrm.character_model_mapping[character];
        if (model_path && extension_settings.vrm.model_settings[model_path]) {
            const modelSettings = extension_settings.vrm.model_settings[model_path];
            if (modelSettings.classify_mapping && modelSettings.classify_mapping[expressionName]) {
                const mapping = modelSettings.classify_mapping[expressionName];
                if (mapping.expression && mapping.expression !== 'none') {
                    finalExpression = mapping.expression;
                }
                // Use intensity from mapping if available
                if (mapping.intensity !== undefined) {
                    finalIntensity = mapping.intensity;
                }
            }
        }
    }

    // Check for custom blend shape mapping
    const blendShapeMapping = getBlendShapeMapping(character, finalExpression);
    if (blendShapeMapping && blendShapeMapping.blendShapes) {
        applyCustomBlendShapeGroupIdle(vrm, character, finalExpression, blendShapeMapping, finalIntensity, duration, isWinking);
        return;
    }

    const startTime = Date.now();
    const rampDuration = duration * 0.3;
    const holdDuration = duration * 0.4;

    function updateExpression() {
        if (!current_avatars[character]) return;

        const elapsed = Date.now() - startTime;

        if (elapsed >= duration) {
            // Explicitly reset expression to 0 for blink-type expressions
            vrm.expressionManager.setValue(finalExpression, 0);
            // Clear winking state - let eyes return to neutral
            if (isWinking && current_avatars[character]) {
                vrm.expressionManager.setValue('blinkLeft', 0);
                vrm.expressionManager.setValue('blinkRight', 0);
                current_avatars[character].winking = false;
                current_avatars[character].customWinking = false;
            }
            return;
        }

        let amplitude = 0;
        if (elapsed < rampDuration) {
            amplitude = easeInOutCubic(elapsed / rampDuration);
        } else if (elapsed < rampDuration + holdDuration) {
            amplitude = 1;
        } else {
            amplitude = 1 - easeInOutCubic((elapsed - rampDuration - holdDuration) / (duration - rampDuration - holdDuration));
        }

        vrm.expressionManager.setValue(finalExpression, finalIntensity * amplitude);
        requestAnimationFrame(updateExpression);
    }

    updateExpression();
}

// Helper to apply custom blend shape groups during idle animations
function applyCustomBlendShapeGroupIdle(vrm, character, expressionName, blendMapping, intensity = 1.0, duration = 2000, isWinking = false) {
    if (!vrm || !vrm.expressionManager) return;

    // Set winking flag if this is a wink expression
    if (isWinking && current_avatars[character]) {
        current_avatars[character].winking = true;
        current_avatars[character].customWinking = true;
    }

    const startTime = Date.now();
    const rampDuration = duration * 0.3;
    const holdDuration = duration * 0.4;
    const blendShapes = blendMapping.blendShapes || {};

    function updateBlendShapes() {
        if (!current_avatars[character]) return;

        const elapsed = Date.now() - startTime;

        if (elapsed >= duration) {
            // Explicitly reset all blend shapes to 0
            for (const blendShapeName in blendShapes) {
                vrm.expressionManager.setValue(blendShapeName, 0);
            }
            // Clear winking state - let eyes return to neutral
            if (current_avatars[character]) {
                vrm.expressionManager.setValue('blinkLeft', 0);
                vrm.expressionManager.setValue('blinkRight', 0);
                current_avatars[character].winking = false;
                current_avatars[character].customWinking = false;
            }
            return;
        }

        let amplitude = 0;
        if (elapsed < rampDuration) {
            amplitude = easeInOutCubic(elapsed / rampDuration);
        } else if (elapsed < rampDuration + holdDuration) {
            amplitude = 1;
        } else {
            amplitude = 1 - easeInOutCubic((elapsed - rampDuration - holdDuration) / (duration - rampDuration - holdDuration));
        }

        for (const [blendShapeName, weight] of Object.entries(blendShapes)) {
            const adjustedIntensity = Math.min(1.0, Math.max(0.0, weight * intensity * amplitude));
            vrm.expressionManager.setValue(blendShapeName, adjustedIntensity);
        }

        requestAnimationFrame(updateBlendShapes);
    }

    updateBlendShapes();
}

// Helper to apply subtle model Y rotation during idle movements
function applyModelRotation(vrm, character, modelId, targetYaw, duration = 7000) {
    const objectContainer = current_avatars[character]?.["objectContainer"];
    if (!objectContainer) return;
    
    const startYaw = objectContainer.rotation.y;
    const startTime = Date.now();
    const rampDuration = duration * 0.3;
    const holdDuration = duration * 0.4;
    const totalDuration = duration;
    
    function updateRotation() {
        if (current_avatars[character]?.["id"] !== modelId) return;
        
        const elapsed = Date.now() - startTime;
        
        if (elapsed >= totalDuration) {
            // Return to base
            objectContainer.rotation.y += (startYaw - objectContainer.rotation.y) * 0.03;
            if (Math.abs(objectContainer.rotation.y - startYaw) > 0.001) {
                requestAnimationFrame(updateRotation);
            }
            return;
        }
        
        let amplitude = 0;
        if (elapsed < rampDuration) {
            amplitude = easeInOutCubic(elapsed / rampDuration);
        } else if (elapsed < rampDuration + holdDuration) {
            amplitude = 1;
        } else {
            amplitude = 1 - easeInOutCubic((elapsed - rampDuration - holdDuration) / rampDuration);
        }
        
        const currentTarget = startYaw + (targetYaw * amplitude);
        objectContainer.rotation.y += (currentTarget - objectContainer.rotation.y) * 0.04;
        
        requestAnimationFrame(updateRotation);
    }
    
    updateRotation();
}

// Helper to get available blend shape names from VRM model
function getAvailableBlendShapeNames(vrm) {
    if (!vrm || !vrm.blendShapeProxy) return [];

    const blendShapeNames = [];
    const expressionMap = vrm.expressionManager?.expressionMap || {};

    for (const expressionName in expressionMap) {
        blendShapeNames.push(expressionName);
    }

    return blendShapeNames;
}

// Helper to apply custom blend shape mapping
function applyCustomBlendShape(vrm, blendShapeName, intensity = 1.0) {
    if (!vrm || !vrm.expressionManager) return;

    const expressionMap = vrm.expressionManager.expressionMap;
    if (!expressionMap[blendShapeName]) {
        console.debug(DEBUG_PREFIX, 'Blend shape not found:', blendShapeName);
        return;
    }

    vrm.expressionManager.setValue(blendShapeName, intensity);
}

// Helper to apply custom blend shape mapping with multiple blend shapes
function applyCustomBlendShapeGroup(character, vrm, blendShapeGroup, intensity = 1.0) {
    if (!vrm || !vrm.expressionManager) return;

    const model_path = extension_settings.vrm.character_model_mapping[character];
    if (!model_path) return;

    const modelSettings = extension_settings.vrm.model_settings[model_path];
    const blendMapping = modelSettings?.blend_shape_mapping?.[blendShapeGroup];
    
    if (!blendMapping || !blendMapping.blendShapes) return;

    for (const [blendShapeName, weight] of Object.entries(blendMapping.blendShapes)) {
        const adjustedIntensity = Math.min(1.0, Math.max(0.0, weight * intensity));
        applyCustomBlendShape(vrm, blendShapeName, adjustedIntensity);
    }
}

// Helper to get blend shape mapping for an expression name
function getBlendShapeMapping(character, expressionName) {
    const model_path = extension_settings.vrm.character_model_mapping[character];
    if (!model_path) return null;
    
    const modelSettings = extension_settings.vrm.model_settings[model_path];
    if (!modelSettings?.blend_shape_mapping) return null;
    
    return modelSettings.blend_shape_mapping[expressionName] || null;
}

// Helper to reset all blend shapes to 0
function resetAllBlendShapes(vrm) {
    if (!vrm || !vrm.expressionManager) return;

    const expressionMap = vrm.expressionManager.expressionMap;
    for (const expressionName in expressionMap) {
        vrm.expressionManager.setValue(expressionName, 0.0);
    }
}

const NATURAL_MOVEMENTS = {
  slowHeadTurn: {
    type: 'head',
    duration: 12000,
    description: 'slow head turn',
    action: (vrm, character, modelId) => {
      const direction = Math.random() > 0.5 ? 1 : -1;
      const angleY = (Math.random() * 0.35 + 0.17) * direction;
      const angleX = (Math.random() * 0.16 - 0.08);
      const angleZ = (Math.random() * 0.1 - 0.05) * direction;

      // Head movement
      const headConfig = {
        x: angleX,
        y: angleY,
        z: angleZ
      };
      applyNaturalMovementWithSlerp(vrm, "head", headConfig, character, modelId);

      // Neck follows with natural follow-through
      const neck = vrm.humanoid?.getNormalizedBoneNode("neck");
      if (neck) {
        setTimeout(() => {
          const neckConfig = {
            x: angleX * 0.5,
            y: angleY * 0.42,
            z: angleZ * 0.6
          };
          applyNaturalMovementWithSlerp(vrm, "neck", neckConfig, character, modelId);
        }, 200);
      }

      // More pronounced model rotation to follow head
      const modelRotation = direction * (Math.random() * 0.1 + 0.08);
      applyModelRotation(vrm, character, modelId, modelRotation, 10000);
    }
  },
  headTilt: {
    type: 'head',
    duration: 12000,
    description: 'curious head tilt',
    action: (vrm, character, modelId) => {
      const direction = Math.random() > 0.5 ? 1 : -1;
      // More exaggerated tilt
      const angleZ = (Math.random() * 0.35 + 0.27) * direction;
      const angleX = (Math.random() * 0.12 - 0.06);
      const angleY = (Math.random() * 0.16 - 0.08) * direction;

      // Apply to head
      const headConfig = {
        x: angleX,
        y: angleY,
        z: angleZ
      };
      applyNaturalMovementWithSlerp(vrm, "head", headConfig, character, modelId);

      // Add neck follow with more natural movement
      const neck = vrm.humanoid?.getNormalizedBoneNode("neck");
      if (neck) {
        setTimeout(() => {
          const neckConfig = {
            x: angleX * 0.5,
            y: angleY * 0.35,
            z: angleZ * 0.57
          };
          applyNaturalMovementWithSlerp(vrm, "neck", neckConfig, character, modelId);
        }, 200);
      }

      // 30% chance to wink during head tilt
      if (Math.random() > 0.7) {
        const winkEye = direction > 0 ? 'blinkLeft' : 'blinkRight';
        setTimeout(() => {
          applyIdleExpression(vrm, character, winkEye, 0.8, 1500);
        }, 1000);
      }
      // 40% chance for curious smile
      else if (Math.random() > 0.6) {
        setTimeout(() => {
          applyIdleExpression(vrm, character, 'happy', 0.4, 2000);
        }, 500);
      }
    }
  },
  slowGlance: {
    type: 'head',
    duration: 10000,
    description: 'casual glance',
    action: (vrm, character, modelId) => {
      const directionX = Math.random() > 0.5 ? 1 : -1;
      const directionY = Math.random() > 0.5 ? 1 : -1;

      const angleX = (Math.random() * 0.14 + 0.05) * directionX;
      const angleY = (Math.random() * 0.28 + 0.13) * directionY;
      const angleZ = (Math.random() * 0.16 - 0.08);

      // More noticeable model rotation with glance
      const modelRotation = directionY * (Math.random() * 0.07 + 0.05);
      applyModelRotation(vrm, character, modelId, modelRotation, 9000);

      // 50% chance for curious expression
      if (Math.random() > 0.5) {
        setTimeout(() => applyIdleExpression(vrm, character, 'surprised', 0.5, 2000), 400);
      }

      // Head glance - more pronounced
      const headConfig = {
        x: angleX,
        y: angleY,
        z: angleZ
      };
      applyNaturalMovementWithSlerp(vrm, "head", headConfig, character, modelId);

      // Neck follows naturally
      const neck = vrm.humanoid?.getNormalizedBoneNode("neck");
      if (neck) {
        setTimeout(() => {
          const neckConfig = {
            x: angleX * 0.5,
            y: angleY * 0.54,
            z: angleZ * 0.5
          };
          applyNaturalMovementWithSlerp(vrm, "neck", neckConfig, character, modelId);
        }, 300);
      }

      // Spine twist for more natural look
      const spine = vrm.humanoid?.getNormalizedBoneNode("spine");
      if (spine) {
        setTimeout(() => {
          const spineConfig = {
            x: angleX * 0.25,
            y: angleY * 0.43,
            z: angleZ * 0.38
          };
          applyNaturalMovementWithSlerp(vrm, "spine", spineConfig, character, modelId);
        }, 500);
      }
    }
  },
  lookAround: {
    type: 'head',
    duration: 16000,
    description: 'looking around',
    action: (vrm, character, modelId) => {
      // Model rotation that follows to look pattern - more dynamic
      const modelRotation1 = 0.09;
      const modelRotation2 = -0.08;

      setTimeout(() => applyModelRotation(vrm, character, modelId, modelRotation1, 4500), 500);
      setTimeout(() => applyModelRotation(vrm, character, modelId, modelRotation2, 4500), 7000);

      // 60% chance for slight smile during look
      if (Math.random() > 0.4) {
        setTimeout(() => applyIdleExpression(vrm, character, 'happy', 0.45, 1800), 300);
      }

      const directions = [
        { x: 0.12, y: 0.32, duration: 3500 },
        { x: 0.05, y: 0.08, duration: 2500 },
        { x: 0.1, y: -0.28, duration: 3500 },
        { x: 0.02, y: -0.06, duration: 3000 }
      ];

            let currentStep = 0;
            const head = vrm.humanoid?.getNormalizedBoneNode("head");
            if (!head) return;
            const baseEuler = new THREE.Euler().setFromQuaternion(head.quaternion.clone());

            function doStep() {
                if (currentStep >= directions.length ||
                    current_avatars[character]?.vrm !== vrm ||
                    current_avatars[character]?.["id"] !== modelId) {
                    return;
                }

                const step = directions[currentStep];
                const startTime = Date.now();
                const startQuat = head.quaternion.clone();
                const targetEuler = new THREE.Euler(
                    baseEuler.x + step.x,
                    baseEuler.y + step.y,
                    baseEuler.z
                );
                const targetQuat = new THREE.Quaternion().setFromEuler(targetEuler);

                function animateStep() {
                    if (current_avatars[character]?.vrm !== vrm) return;
                    const elapsed = Date.now() - startTime;
                    const progress = Math.min(elapsed / step.duration, 1);
                    const eased = easeInOutCubic(progress);

                    head.quaternion.slerpQuaternions(startQuat, targetQuat, eased);

                    if (progress < 1) {
                        requestAnimationFrame(animateStep);
                    } else {
                        currentStep++;
                        if (currentStep < directions.length) {
                            setTimeout(doStep, 1200);
                        } else {
                            const returnStart = Date.now();
                            const returnDuration = 2500;
                            const holdQuat = head.quaternion.clone();
                            const baseQuat = new THREE.Quaternion().setFromEuler(baseEuler);

                            function returnToBase() {
                                const returnElapsed = Date.now() - returnStart;
                                const returnProgress = Math.min(returnElapsed / returnDuration, 1);
                                head.quaternion.slerpQuaternions(holdQuat, baseQuat, easeInOutCubic(returnProgress));

                                if (returnProgress < 1) {
                                    requestAnimationFrame(returnToBase);
                                }
                            }
                            returnToBase();
                        }
                    }
                }

                animateStep();
            }

            doStep();
        }
    },
    shoulderShrug: {
        type: 'body',
        duration: 6000,
        description: 'shoulder shrug',
        action: (vrm, character, modelId) => {
            const bothShoulders = Math.random() > 0.6;
            const leftShoulder = vrm.humanoid?.getNormalizedBoneNode("leftShoulder");
            const rightShoulder = vrm.humanoid?.getNormalizedBoneNode("rightShoulder");

            if (!leftShoulder && !rightShoulder) return;

            const shrugAmount = Math.random() * 0.12 + 0.06;
            const startTime = Date.now();
            const baseLeft = leftShoulder?.quaternion.clone();
            const baseRight = rightShoulder?.quaternion.clone();

            const rampDuration = 2500;
            const holdDuration = 4000;
            const totalDuration = rampDuration * 2 + holdDuration;

            function animateShrug() {
                if (current_avatars[character]?.vrm !== vrm ||
                    current_avatars[character]?.["id"] !== modelId) {
                    return;
                }

                const elapsed = Date.now() - startTime;

                if (elapsed >= totalDuration) {
                    if (leftShoulder && baseLeft) {
                        leftShoulder.quaternion.slerp(baseLeft, 0.03);
                    }
                    if (rightShoulder && baseRight && bothShoulders) {
                        rightShoulder.quaternion.slerp(baseRight, 0.03);
                    }

                    const stillMoving = (leftShoulder && baseLeft && leftShoulder.quaternion.angleTo(baseLeft) > 0.001) ||
                                       (rightShoulder && baseRight && bothShoulders && rightShoulder.quaternion.angleTo(baseRight) > 0.001);

                    if (stillMoving) {
                        requestAnimationFrame(animateShrug);
                    }
                    return;
                }

                let amplitude = 0;
                if (elapsed < rampDuration) {
                    amplitude = easeInOutCubic(elapsed / rampDuration);
                } else if (elapsed < rampDuration + holdDuration) {
                    amplitude = 1;
                } else {
                    amplitude = 1 - easeInOutCubic((elapsed - rampDuration - holdDuration) / rampDuration);
                }

                const shrugEuler = new THREE.Euler(-shrugAmount * amplitude, 0, 0);
                const shrugQuat = new THREE.Quaternion().setFromEuler(shrugEuler);

                if (leftShoulder && baseLeft) {
                    const targetQuat = baseLeft.clone().multiply(shrugQuat);
                    leftShoulder.quaternion.slerp(targetQuat, 0.04);
                }
                if (rightShoulder && baseRight && bothShoulders) {
                    const targetQuat = baseRight.clone().multiply(shrugQuat);
                    rightShoulder.quaternion.slerp(targetQuat, 0.04);
                }

                requestAnimationFrame(animateShrug);
            }

            animateShrug();
        }
    },
    armStretch: {
        type: 'body',
        duration: 8000,
        description: 'arm stretch',
        action: (vrm, character, modelId) => {
            const side = Math.random() > 0.5 ? "left" : "right";
            const upperArm = vrm.humanoid?.getNormalizedBoneNode(`${side}UpperArm`);
            const lowerArm = vrm.humanoid?.getNormalizedBoneNode(`${side}LowerArm`);

            if (!upperArm) return;

            const startTime = Date.now();
            const baseUpper = upperArm.quaternion.clone();
            const baseLower = lowerArm?.quaternion.clone();

            const rampDuration = 3000;
            const holdDuration = 5000;
            const totalDuration = rampDuration * 2 + holdDuration;

            function animateStretch() {
                if (current_avatars[character]?.vrm !== vrm ||
                    current_avatars[character]?.["id"] !== modelId) {
                    return;
                }

                const elapsed = Date.now() - startTime;

                if (elapsed >= totalDuration) {
                    upperArm.quaternion.slerp(baseUpper, 0.03);
                    if (lowerArm && baseLower) {
                        lowerArm.quaternion.slerp(baseLower, 0.03);
                    }

                    const stillMoving = upperArm.quaternion.angleTo(baseUpper) > 0.001 ||
                                       (lowerArm && baseLower && lowerArm.quaternion.angleTo(baseLower) > 0.001);

                    if (stillMoving) {
                        requestAnimationFrame(animateStretch);
                    }
                    return;
                }

                let amplitude = 0;
                if (elapsed < rampDuration) {
                    amplitude = easeInOutCubic(elapsed / rampDuration);
                } else if (elapsed < rampDuration + holdDuration) {
                    amplitude = 1;
                } else {
                    amplitude = 1 - easeInOutCubic((elapsed - rampDuration - holdDuration) / rampDuration);
                }

                const stretchEuler = new THREE.Euler(
                    -0.2 * amplitude,
                    0,
                    (side === "left" ? 0.25 : -0.25) * amplitude
                );
                const stretchQuat = new THREE.Quaternion().setFromEuler(stretchEuler);
                const targetUpper = baseUpper.clone().multiply(stretchQuat);

                upperArm.quaternion.slerp(targetUpper, 0.04);

                if (lowerArm && baseLower) {
                    const elbowBend = new THREE.Quaternion().setFromEuler(
                        new THREE.Euler(-0.12 * amplitude, 0, 0)
                    );
                    const targetLower = baseLower.clone().multiply(elbowBend);
                    lowerArm.quaternion.slerp(targetLower, 0.04);
                }

                requestAnimationFrame(animateStretch);
            }

            animateStretch();
        }
    },
  weightShift: {
    type: 'body',
    duration: 10000,
    description: 'weight shift with spine twist',
    action: (vrm, character, modelId) => {
      const direction = Math.random() > 0.5 ? 1 : -1;

      // More pronounced model rotation with weight shift
      const modelRotation = direction * (Math.random() * 0.1 + 0.08);
      applyModelRotation(vrm, character, modelId, modelRotation, 9000);

      // Spine: shift + twist - much more visible
      const spineConfig = {
        x: Math.random() * 0.06 - 0.03,
        y: (Math.random() * 0.22 + 0.1) * direction,
        z: (Math.random() * 0.2 + 0.05) * direction
      };
      applyNaturalMovementWithSlerp(vrm, "spine", spineConfig, character, modelId);

      // Upper chest follows for more natural movement
      const upperChest = vrm.humanoid?.getNormalizedBoneNode("upperChest");
      if (upperChest) {
        setTimeout(() => {
          const chestConfig = {
            x: Math.random() * 0.04 - 0.02,
            y: (Math.random() * 0.1 + 0.05) * direction,
            z: (Math.random() * 0.12 + 0.04) * direction
          };
          applyNaturalMovementWithSlerp(vrm, "upperChest", chestConfig, character, modelId);
        }, 200);
      }

      // Hips: counter-rotation for balance
      const hips = vrm.humanoid?.getNormalizedBoneNode("hips");
      if (hips) {
        setTimeout(() => {
          const hipsConfig = {
            x: Math.random() * 0.06 - 0.03,
            y: -(Math.random() * 0.12 + 0.05) * direction,
            z: (Math.random() * 0.15 + 0.05) * direction
          };
          applyNaturalMovementWithSlerp(vrm, "hips", hipsConfig, character, modelId);
        }, 350);
      }

      // 40% chance for thoughtful expression
      if (Math.random() > 0.6) {
        setTimeout(() => applyIdleExpression(vrm, character, 'neutral', 0.5, 1500), 800);
      }
    }
  },
  neckStretch: {
    type: 'neck',
    duration: 10000,
    description: 'neck stretch',
    action: (vrm, character, modelId) => {
      const directionX = Math.random() > 0.5 ? 1 : -1;
      const directionY = Math.random() > 0.5 ? 1 : -1;
      const directionZ = Math.random() > 0.5 ? 1 : -1;

      // Neck tilt - more pronounced stretching motion
      const neckConfig = {
        x: (Math.random() * 0.12 + 0.06) * directionX,
        y: (Math.random() * 0.25 + 0.05) * directionY,
        z: (Math.random() * 0.4 + 0.15) * directionZ
      };
      applyNaturalMovementWithSlerp(vrm, "neck", neckConfig, character, modelId);

      // Head follows for natural stretching
      const head = vrm.humanoid?.getNormalizedBoneNode("head");
      if (head) {
        setTimeout(() => {
          const headConfig = {
            x: neckConfig.x * 0.7,
            y: neckConfig.y * 0.6,
            z: neckConfig.z * 0.8
          };
          applyNaturalMovementWithSlerp(vrm, "head", headConfig, character, modelId);
        }, 200);
      }

      // 50% chance for expression during stretch
      if (Math.random() > 0.5) {
        setTimeout(() => applyIdleExpression(vrm, character, 'surprised', 0.55, 2200), 500);
      }
    }
  },
  subtleNod: {
    type: 'head',
    duration: 8000,
    description: 'subtle nod',
    action: (vrm, character, modelId) => {
      const direction = Math.random() > 0.5 ? 1 : -1;
      // More pronounced nod with slight natural variation
      const headConfig = {
        x: Math.random() * 0.14 + 0.08,
        y: (Math.random() * 0.05) * direction,
        z: (Math.random() * 0.03) * direction
      };
      applyNaturalMovementWithSlerp(vrm, "head", headConfig, character, modelId);

      // Neck follows naturally
      const neck = vrm.humanoid?.getNormalizedBoneNode("neck");
      if (neck) {
        setTimeout(() => {
          const neckConfig = {
            x: headConfig.x * 0.55,
            y: headConfig.y * 0.6,
            z: headConfig.z * 0.5
          };
          applyNaturalMovementWithSlerp(vrm, "neck", neckConfig, character, modelId);
        }, 200);
      }

      // 70% chance for gentle smile during nod
      if (Math.random() > 0.3) {
        setTimeout(() => applyIdleExpression(vrm, character, 'happy', 0.5, 1500), 1000);
      }
    }
  },
  hipShift: {
    type: 'hips',
    duration: 11000,
    description: 'hip shift with rotation',
    action: (vrm, character, modelId) => {
      const direction = Math.random() > 0.5 ? 1 : -1;

      // Model rotation with hip shift - more dynamic
      const modelRotation = direction * (Math.random() * 0.08 + 0.08);
      applyModelRotation(vrm, character, modelId, modelRotation, 9500);

      // Hip tilt + rotation for more dynamic movement
      const hipConfig = {
        x: (Math.random() * 0.08 - 0.04),
        y: (Math.random() * 0.25 + 0.1) * direction,
        z: (Math.random() * 0.22 + 0.12) * direction
      };
      applyNaturalMovementWithSlerp(vrm, "hips", hipConfig, character, modelId);

      // Upper chest counter-movement for balance
      const upperChest = vrm.humanoid?.getNormalizedBoneNode("upperChest");
      if (upperChest) {
        setTimeout(() => {
          const chestConfig = {
            x: (Math.random() * 0.05 - 0.025),
            y: (Math.random() * 0.08 + 0.04) * direction,
            z: (Math.random() * 0.08 + 0.04) * direction
          };
          applyNaturalMovementWithSlerp(vrm, "upperChest", chestConfig, character, modelId);
        }, 250);
      }

      // Spine counter-movement for balance
      const spine = vrm.humanoid?.getNormalizedBoneNode("spine");
      if (spine) {
        setTimeout(() => {
          const spineConfig = {
            x: (Math.random() * 0.08 - 0.04),
            y: -(Math.random() * 0.15 + 0.08) * direction,
            z: -(Math.random() * 0.12 + 0.07) * direction
          };
          applyNaturalMovementWithSlerp(vrm, "spine", spineConfig, character, modelId);
        }, 400);
      }

      // 40% chance for curious expression
      if (Math.random() > 0.6) {
        setTimeout(() => applyIdleExpression(vrm, character, 'surprised', 0.6, 2200), 700);
      }
    }
  },
  feminineHipSway: {
    type: 'hips',
    duration: 14000,
    description: 'feminine hip sway',
    action: (vrm, character, modelId) => {
      const swayAmount = Math.random() * 0.25 + 0.22;
      const direction = Math.random() > 0.5 ? 1 : -1;

      // Model sways with hips - more pronounced
      const modelRotation = direction * (Math.random() * 0.08 + 0.06);
      applyModelRotation(vrm, character, modelId, modelRotation, 12000);

      // Hip sway with rotation - more dynamic
      const hipConfig = {
        x: (Math.random() * 0.08 - 0.04),
        y: Math.random() * 0.15,
        z: swayAmount
      };
      applyNaturalMovementWithSlerp(vrm, "hips", hipConfig, character, modelId);

      // Upper chest follows for more graceful movement
      const upperChest = vrm.humanoid?.getNormalizedBoneNode("upperChest");
      if (upperChest) {
        setTimeout(() => {
          const chestConfig = {
            x: (Math.random() * 0.06 - 0.03),
            y: -(Math.random() * 0.12 + 0.05),
            z: -swayAmount * 0.35
          };
          applyNaturalMovementWithSlerp(vrm, "upperChest", chestConfig, character, modelId);
        }, 200);
      }

      // Spine follows with delay
      const spine = vrm.humanoid?.getNormalizedBoneNode("spine");
      if (spine) {
        setTimeout(() => {
          const spineConfig = {
            x: (Math.random() * 0.06 - 0.03),
            y: -(Math.random() * 0.1),
            z: -swayAmount * 0.52
          };
          applyNaturalMovementWithSlerp(vrm, "spine", spineConfig, character, modelId);
        }, 400);
      }

      // Neck slight movement for elegance
      const neck = vrm.humanoid?.getNormalizedBoneNode("neck");
      if (neck) {
        setTimeout(() => {
          const neckConfig = {
            x: (Math.random() * 0.04 - 0.02),
            y: -(Math.random() * 0.08),
            z: (Math.random() * 0.1 - 0.05)
          };
          applyNaturalMovementWithSlerp(vrm, "neck", neckConfig, character, modelId);
        }, 600);
      }

      // 70% chance for pleasant expression
      if (Math.random() > 0.3) {
        setTimeout(() => applyIdleExpression(vrm, character, 'happy', 0.5, 2200), 1200);
      }
    }
  },
  coyHeadTilt: {
    type: 'head',
    duration: 11000,
    description: 'coy head tilt',
    action: (vrm, character, modelId) => {
      const direction = Math.random() > 0.5 ? 1 : -1;
      // More pronounced coy tilt with slight angle variation
      const headConfig = {
        x: Math.random() * 0.1 + 0.1,
        y: (Math.random() * 0.12) * direction,
        z: -(Math.random() * 0.16 + 0.22) * direction
      };
      applyNaturalMovementWithSlerp(vrm, "head", headConfig, character, modelId);

      // Neck follows for more natural movement
      const neck = vrm.humanoid?.getNormalizedBoneNode("neck");
      if (neck) {
        setTimeout(() => {
          const neckConfig = {
            x: headConfig.x * 0.53,
            y: headConfig.y * 0.5,
            z: headConfig.z * 0.58
          };
          applyNaturalMovementWithSlerp(vrm, "neck", neckConfig, character, modelId);
        }, 200);
      }

      // 70% chance for shy or cute expression
      const expression = Math.random() > 0.3 ? 'relaxed' : 'shy';
      setTimeout(() => applyIdleExpression(vrm, character, expression, 0.65, 2500), 1200);
    }
  },
  chestLift: {
    type: 'chest',
    duration: 9000,
    description: 'chest lift',
    action: (vrm, character, modelId) => {
      const upperChest = vrm.humanoid?.getNormalizedBoneNode("upperChest") || vrm.humanoid?.getNormalizedBoneNode("chest");
      if (!upperChest) return;
      const boneName = upperChest.name;

      // Chest actually lifts now - positive X rotation pushes chest forward
      const chestConfig = {
        x: Math.random() * 0.1 + 0.18,
        y: Math.random() * 0.06 - 0.03,
        z: Math.random() * 0.05 - 0.025
      };
      applyNaturalMovementWithSlerp(vrm, boneName, chestConfig, character, modelId);

      // Spine follows naturally
      const spine = vrm.humanoid?.getNormalizedBoneNode("spine");
      if (spine) {
        setTimeout(() => {
          const spineConfig = {
            x: chestConfig.x * 0.55,
            y: chestConfig.y * 0.5,
            z: chestConfig.z * 0.5
          };
          applyNaturalMovementWithSlerp(vrm, "spine", spineConfig, character, modelId);
        }, 250);
      }

      // Neck slight adjustment for natural lift
      const neck = vrm.humanoid?.getNormalizedBoneNode("neck");
      if (neck) {
        setTimeout(() => {
          const neckConfig = {
            x: -chestConfig.x * 0.35,
            y: 0,
            z: 0
          };
          applyNaturalMovementWithSlerp(vrm, "neck", neckConfig, character, modelId);
        }, 400);
      }

      // 60% chance for confident or proud expression
      if (Math.random() > 0.4) {
        const expression = Math.random() > 0.5 ? 'happy' : 'relaxed';
        setTimeout(() => applyIdleExpression(vrm, character, expression, 0.65, 2000), 1800);
      }
    }
  },
};

// debug
const gridHelper = new THREE.GridHelper( 20, 20 );
const axesHelper = new THREE.AxesHelper( 10 );

function updateCursorTracking() {
  if (!cursorTrackingEnabled || !camera || !renderer) return;
  
  const ndcX = (cursorPosition.x / window.innerWidth) * 2 - 1;
  const ndcY = -(cursorPosition.y / window.innerHeight) * 2 + 1;
  
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  
   const distance = 5.0;  // Far enough for natural eye movement range
  const targetPos = new THREE.Vector3();
  targetPos.copy(camera.position).add(raycaster.ray.direction.multiplyScalar(distance));
  
  cursorTarget.position.copy(targetPos);
}

function applyCursorTiltAndShift(vrm, character) {
  const upperChest = vrm.humanoid?.getNormalizedBoneNode("upperChest");
  const objectContainer = current_avatars[character]?.["objectContainer"];

  if (!upperChest || !objectContainer) return;

  // Initialize state
  if (!cursorTiltState[character]) {
    cursorTiltState[character] = {
      currentYaw: 0,
      currentPitch: 0,
      modelCurrentYaw: 0,
      modelCurrentPitch: 0,
      neckCurrentYaw: 0,
      neckCurrentPitch: 0
    };
    // Store base poses when cursor tracking starts
    if (!cursorBasePoses[character]) {
      cursorBasePoses[character] = {};
    }
    cursorBasePoses[character]["upperChest"] = upperChest.quaternion.clone();
    const neck = vrm.humanoid?.getNormalizedBoneNode("neck");
    if (neck) {
      cursorBasePoses[character]["neck"] = neck.quaternion.clone();
    }
  }

  const state = cursorTiltState[character];

  const cursorX = (cursorPosition.x / window.innerWidth) * 2 - 1;
  const cursorY = -(cursorPosition.y / window.innerHeight) * 2 + 1;

  // HIERARCHY: Eyes > Head > Neck > Upper Body > Lower Body

  // MODEL Y ROTATION (Lower body horizontal) - Moderate turn
  const targetModelYaw = cursorX * 0.20;
  state.modelCurrentYaw += (targetModelYaw - state.modelCurrentYaw) * 0.04;
  // Clamp model yaw to prevent drift
  state.modelCurrentYaw = Math.max(-0.35, Math.min(0.35, state.modelCurrentYaw));
  objectContainer.rotation.y += (targetModelYaw - state.modelCurrentYaw) * 0.04;
  // Clamp actual rotation
  objectContainer.rotation.y = Math.max(-0.35, Math.min(0.35, objectContainer.rotation.y));

  // MODEL X ROTATION (Lower body pitch) - Bend forward when looking down (reduced)
  const targetModelPitch = cursorY * 0.08;
  state.modelCurrentPitch += (targetModelPitch - state.modelCurrentPitch) * 0.03;
  // Clamp model pitch to prevent drift
  state.modelCurrentPitch = Math.max(-0.25, Math.min(0.25, state.modelCurrentPitch));
  objectContainer.rotation.x += (targetModelPitch - state.modelCurrentPitch) * 0.03;
  // Clamp actual rotation
  objectContainer.rotation.x = Math.max(-0.25, Math.min(0.25, objectContainer.rotation.x));

  // UPPER CHEST - Moderate head/chest tracking (reduced pitch to prevent excessive leaning)
  const targetYaw = cursorX * 0.18;
  const targetPitch = cursorY * 0.12;

  // Smooth interpolation towards target with limits to prevent drift
  state.currentYaw += (targetYaw - state.currentYaw) * 0.08;
  state.currentPitch += (targetPitch - state.currentPitch) * 0.08;
  
  // Clamp cursor offsets to prevent excessive accumulation
  state.currentYaw = Math.max(-0.4, Math.min(0.4, state.currentYaw));
  state.currentPitch = Math.max(-0.5, Math.min(0.5, state.currentPitch));

  // Apply cursor rotation relative to base pose (not additively)
  const baseChestQuat = cursorBasePoses[character]?.["upperChest"] || upperChest.quaternion.clone();
  const cursorEuler = new THREE.Euler(state.currentPitch, state.currentYaw, -state.currentYaw * 0.15);
  const cursorQuat = new THREE.Quaternion().setFromEuler(cursorEuler);
  upperChest.quaternion.copy(baseChestQuat).multiply(cursorQuat);

  // Neck rotation - add extra movement between chest and head
  const neck = vrm.humanoid?.getNormalizedBoneNode("neck");
  if (neck) {
    const neckTargetYaw = cursorX * 0.25;
    const neckTargetPitch = cursorY * 0.08;

    state.neckCurrentYaw += (neckTargetYaw - state.neckCurrentYaw) * 0.12;
    state.neckCurrentPitch += (neckTargetPitch - state.neckCurrentPitch) * 0.12;
    
    // Clamp neck offsets to prevent excessive accumulation
    state.neckCurrentYaw = Math.max(-0.6, Math.min(0.6, state.neckCurrentYaw));
    state.neckCurrentPitch = Math.max(-0.7, Math.min(0.7, state.neckCurrentPitch));

    // Apply cursor rotation relative to base pose
    const baseNeckQuat = cursorBasePoses[character]?.["neck"] || neck.quaternion.clone();
    const neckCursorEuler = new THREE.Euler(state.neckCurrentPitch, state.neckCurrentYaw, -state.neckCurrentYaw * 0.1);
    const neckCursorQuat = new THREE.Quaternion().setFromEuler(neckCursorEuler);
    neck.quaternion.copy(baseNeckQuat).multiply(neckCursorQuat);
  }

  // Eyes are handled by VRM's built-in lookAt.target - no manual bone manipulation
}

function resetCursorTilt(vrm, character) {
  if (!cursorTiltState[character]) return;

  const state = cursorTiltState[character];
  const objectContainer = current_avatars[character]?.["objectContainer"];

  let allReset = true;

  // Smoothly return cursor offsets to zero
  // Model rotations
  if (objectContainer) {
    const modelYawDelta = -state.modelCurrentYaw * 0.03;
    const modelPitchDelta = -state.modelCurrentPitch * 0.02;

    objectContainer.rotation.y += modelYawDelta;
    objectContainer.rotation.x += modelPitchDelta;

    state.modelCurrentYaw *= 0.97;
    state.modelCurrentPitch *= 0.97;

    if (Math.abs(state.modelCurrentYaw) > 0.001 || Math.abs(state.modelCurrentPitch) > 0.001) {
      allReset = false;
    }
  }

  // Upper chest - return to base pose
  const upperChest = vrm.humanoid?.getNormalizedBoneNode("upperChest");
  if (upperChest) {
    state.currentYaw *= 0.96;
    state.currentPitch *= 0.96;

    // Return to base pose
    const baseChestQuat = cursorBasePoses[character]?.["upperChest"];
    if (baseChestQuat) {
      const cursorEuler = new THREE.Euler(state.currentPitch, state.currentYaw, -state.currentYaw * 0.15);
      const cursorQuat = new THREE.Quaternion().setFromEuler(cursorEuler);
      upperChest.quaternion.copy(baseChestQuat).multiply(cursorQuat);
    } else {
      // Fallback if no base pose stored
      const yawDelta = -state.currentYaw * 0.04;
      const pitchDelta = -state.currentPitch * 0.04;
      const deltaEuler = new THREE.Euler(pitchDelta, yawDelta, -yawDelta * 0.15);
      const deltaQuat = new THREE.Quaternion().setFromEuler(deltaEuler);
      upperChest.quaternion.multiply(deltaQuat);
    }

    if (Math.abs(state.currentYaw) > 0.001 || Math.abs(state.currentPitch) > 0.001) {
      allReset = false;
    }
  }

  // Neck - return to base pose
  const neck = vrm.humanoid?.getNormalizedBoneNode("neck");
  if (neck) {
    state.neckCurrentYaw *= 0.96;
    state.neckCurrentPitch *= 0.96;

    // Return to base pose
    const baseNeckQuat = cursorBasePoses[character]?.["neck"];
    if (baseNeckQuat) {
      const neckCursorEuler = new THREE.Euler(state.neckCurrentPitch, state.neckCurrentYaw, -state.neckCurrentYaw * 0.1);
      const neckCursorQuat = new THREE.Quaternion().setFromEuler(neckCursorEuler);
      neck.quaternion.copy(baseNeckQuat).multiply(neckCursorQuat);
    } else {
      // Fallback if no base pose stored
      const neckYawDelta = -state.neckCurrentYaw * 0.04;
      const neckPitchDelta = -state.neckCurrentPitch * 0.04;
      const neckDeltaEuler = new THREE.Euler(neckPitchDelta, neckYawDelta, -neckYawDelta * 0.1);
      const neckDeltaQuat = new THREE.Quaternion().setFromEuler(neckDeltaEuler);
      neck.quaternion.multiply(neckDeltaQuat);
    }

    if (Math.abs(state.neckCurrentYaw) > 0.001 || Math.abs(state.neckCurrentPitch) > 0.001) {
      allReset = false;
    }
  }

  if (allReset) {
    delete cursorTiltState[character];
    // Clear base poses when fully reset
    if (cursorBasePoses[character]) {
      delete cursorBasePoses[character];
    }
  }
}

// animate
function animate() {
    requestAnimationFrame( animate );
    if (renderer !== undefined && scene !== undefined && camera !== undefined) {
        const deltaTime = clock.getDelta();

        if (cursorTrackingEnabled) {
            updateCursorTracking();
        }

        for(const character in current_avatars) {
            const vrm = current_avatars[character]["vrm"];
            const mixer = current_avatars[character]["animation_mixer"];
            
            // Set lookAt target before VRM update
            if (extension_settings.vrm.follow_camera) {
                if (cursorTrackingEnabled && extension_settings.vrm.follow_cursor) {
                    vrm.lookAt.target = cursorTarget;
                } else {
                    vrm.lookAt.target = lookAtTarget;
                }
            } else if (cursorTrackingEnabled && extension_settings.vrm.follow_cursor) {
                vrm.lookAt.target = cursorTarget;
            } else {
                vrm.lookAt.target = null;
            }

            vrm.update( deltaTime );
            mixer.update( deltaTime );
            
            // Apply cursor tracking AFTER mixer update so it adds on top of animations
            if (cursorTrackingEnabled && extension_settings.vrm.follow_cursor) {
                applyCursorTiltAndShift(vrm, character);
            } else {
                resetCursorTilt(vrm, character);
            }

            // Update control box
            const objectContainer = current_avatars[character]["objectContainer"];
            const hips = vrm.humanoid?.getNormalizedBoneNode("hips");
            hips.getWorldPosition(current_avatars[character]["collider"].position);
            //objectContainer.worldToLocal(current_avatars[character]["collider"].position);
            hips.getWorldQuaternion(current_avatars[character]["collider"].quaternion);
            current_avatars[character]["collider"].scale.copy(objectContainer.scale);
            current_avatars[character]["collider"].visible = extension_settings.vrm.show_grid;

    // Update hitbox
    for (const body_part in current_avatars[character]["hitboxes"]) {
      const bone = vrm.humanoid?.getNormalizedBoneNode(HITBOXES[body_part]["bone"]);
      if (bone !== null) {
        bone.getWorldPosition(current_avatars[character]["hitboxes"][body_part]["offsetContainer"].position);
        bone.getWorldQuaternion(current_avatars[character]["hitboxes"][body_part]["offsetContainer"].quaternion);
        current_avatars[character]["hitboxes"][body_part]["offsetContainer"].scale.copy(objectContainer.scale);
        current_avatars[character]["hitboxes"][body_part]["offsetContainer"].visible = extension_settings.vrm.show_grid;
      }
    }
        }
        // Show/hide helper grid
        gridHelper.visible = extension_settings.vrm.show_grid;
        axesHelper.visible = extension_settings.vrm.show_grid;

        renderer.render( scene, camera );
    }
}

animate();

async function loadScene() {
    clock = new THREE.Clock();
    current_avatars = {};
    models_cache = {};
    animations_cache = {};
    const instanceId = currentInstanceId + 1;
    currentInstanceId = instanceId;

    // Delete the canvas
    if (document.getElementById(VRM_CANVAS_ID) !== null) {
        document.getElementById(VRM_CANVAS_ID).remove();
        // Hide sprite divs
    }
    
    $('#' + SPRITE_DIV).addClass('vrm-hidden');
    $('#' + VN_MODE_DIV).addClass('vrm-hidden');

    if (!extension_settings.vrm.enabled) {
        $('#' + SPRITE_DIV).removeClass('vrm-hidden');
        $('#' + VN_MODE_DIV).removeClass('vrm-hidden');
        return
    }

    clock.start();

    // renderer
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias : true });
    renderer.setSize( window.innerWidth, window.innerHeight );
    renderer.setPixelRatio( window.devicePixelRatio );
    renderer.domElement.id = VRM_CANVAS_ID;
    document.body.appendChild( renderer.domElement );

    // camera
    camera = new THREE.PerspectiveCamera( 50.0, window.innerWidth / window.innerHeight, 0.1, 100.0 );
    //const camera = new THREE.PerspectiveCamera( 60, window.innerWidth / window.innerHeight, 1, 1000 );
    camera.position.set( 0.0, 1.0, 5.0 );

    // camera controls
    //const controls = new OrbitControls( camera, renderer.domElement );
    //controls.screenSpacePanning = true;
    //controls.target.set( 0.0, 1.0, 0.0 );
    //controls.update();

    // scene
    scene = new THREE.Scene();
    
    // Grid debuging helpers
    scene.add( gridHelper );
    scene.add( axesHelper );
    gridHelper.visible = extension_settings.vrm.show_grid;
    axesHelper.visible = extension_settings.vrm.show_grid;

    // light
    light = new THREE.DirectionalLight();
    light.position.set( 1.0, 1.0, 1.0 ).normalize();
    setLight(extension_settings.vrm.light_color, extension_settings.vrm.light_intensity);
    scene.add( light );

    // lookat target
    camera.add( lookAtTarget );
    camera.add( cursorTarget );
    camera.add( blendedTarget );

    //current_characters = currentChatMembers();
    //await loadAllModels(current_characters);

    //console.debug(DEBUG_PREFIX,"DEBUG",renderer);
}

async function loadAllModels(current_characters) {
    // Unload models
    for(const character in current_avatars) {
        await unloadModel(character);
    }

    if (extension_settings.vrm.enabled) {
        // Load new characters models
        for(const character of current_characters) {
            const model_path = extension_settings.vrm.character_model_mapping[character];
            if (model_path !== undefined) {
                console.debug(DEBUG_PREFIX,"Loading VRM model of",character,":",model_path);
                await setModel(character,model_path);
            }
        }
    }
}

async function setModel(character,model_path) {
    let model;
    // Model is cached
    if (models_cache[model_path] !== undefined) {
        model = models_cache[model_path];
        await initModel(model);
        console.debug(DEBUG_PREFIX,"Model loaded from cache:",model_path);
    }
    else {
        model = await loadModel(model_path);
    }

    await unloadModel(character);

    // Error occured
    if (model === null) {
        extension_settings.vrm.character_model_mapping[character] = undefined;
        return;
    }

    // Set as character model and start animations
    modelId++;
    current_avatars[character] = model;
    current_avatars[character]["id"] = modelId;
    current_avatars[character]["objectContainer"].name = VRM_CONTAINER_NAME+"_"+character;
    current_avatars[character]["collider"].name = VRM_COLLIDER_NAME+"_"+character;

    // Load default expression/motion
    const expression = extension_settings.vrm.model_settings[model_path]['animation_default']['expression'];
    const motion =  extension_settings.vrm.model_settings[model_path]['animation_default']['motion'];

    if (expression !== undefined && expression != "none") {
        console.debug(DEBUG_PREFIX,"Set default expression to",expression);
        await setExpression(character, expression);
    }
    if (motion !== undefined && motion != "none") {
        console.debug(DEBUG_PREFIX,"Set default motion to",motion);
        await setMotion(character, motion, true);
    }

    if (extension_settings.vrm.blink)
        blink(character, modelId);
    textTalk(character, modelId);
    naturalIdleMovement(character, modelId);
    current_avatars[character]["objectContainer"].visible = true;
    current_avatars[character]["collider"].visible = extension_settings.vrm.show_grid;
    
    scene.add(current_avatars[character]["objectContainer"]);
    scene.add(current_avatars[character]["collider"]);
    for(const hitbox in current_avatars[character]["hitboxes"])
        scene.add(current_avatars[character]["hitboxes"][hitbox]["offsetContainer"]);
}

async function unloadModel(character) {
    // unload existing model
    if (current_avatars[character] !== undefined) {
        console.debug(DEBUG_PREFIX,"Unloading avatar of",character);
        const container = current_avatars[character]["objectContainer"];
        const collider = current_avatars[character]["collider"];

        scene.remove(scene.getObjectByName(container.name));
        scene.remove(scene.getObjectByName(collider.name));
        for(const hitbox in current_avatars[character]["hitboxes"]) {
            console.debug(DEBUG_PREFIX,"REMOVING",current_avatars[character]["hitboxes"][hitbox]["offsetContainer"])
            scene.remove(scene.getObjectByName(current_avatars[character]["hitboxes"][hitbox]["offsetContainer"].name));
        }

        // unload animations
        current_avatars[character]["animation_mixer"].stopAllAction();
        if (current_avatars[character]["motion"]["animation"]  !== null) {
            current_avatars[character]["motion"]["animation"].stop();
            current_avatars[character]["motion"]["animation"].terminated = true;
            current_avatars[character]["motion"]["animation"] = null;
        }

        if (naturalIdleTimers[character]) {
            clearTimeout(naturalIdleTimers[character]);
            delete naturalIdleTimers[character];
        }

    if (activeNaturalMovements[character]) {
        delete activeNaturalMovements[character];
    }
    
  // Clear idle animation for this character
  if (activeIdleAnimations[character]) {
    if (activeIdleAnimations[character].isRunning && activeIdleAnimations[character].fadeOut) {
      activeIdleAnimations[character].fadeOut(ANIMATION_FADE_TIME);
    }
    delete activeIdleAnimations[character];
  }

  // Clear VRMA base poses for this character
  if (vrmaBoneBasePoses[character]) {
    delete vrmaBoneBasePoses[character];
  }

  // Clear idle completion time for this character
  if (lastIdleCompletionTime[character]) {
    delete lastIdleCompletionTime[character];
  }

  // Clear cursor base poses for this character
  if (cursorBasePoses[character]) {
    delete cursorBasePoses[character];
  }

  delete current_avatars[character];

        container.visible = false;
        collider.visible = false;
        if (!extension_settings.vrm.models_cache) {
            await container.traverse(obj => obj.dispose?.());
            await collider.traverse(obj => obj.dispose?.());
        }
    }
}

async function loadModel(model_path) { // Only cache the model if character=null
    // gltf and vrm
    const loader = new GLTFLoader();
    loader.crossOrigin = 'anonymous';

    loader.register( ( parser ) => {
        return new VRMLoaderPlugin( parser );
    } );

    let gltf;
    try {
        gltf = await loader.loadAsync(model_path,
            // called after loaded
            () => {
                console.debug(DEBUG_PREFIX,"Finished loading",model_path);
            },
            // called while loading is progressing
            ( progress ) => {
                const percent = Math.round(100.0 * ( progress.loaded / progress.total ));
                console.debug(DEBUG_PREFIX, 'Loading model...', percent, '%');
                $("#vrm_model_loading_percent").text(percent);
            },
            // called when loading has errors
            ( error ) => {
                console.debug(DEBUG_PREFIX,"Error when loading",model_path,":",error)
                toastr.error('Wrong avatar file:'+model_path, DEBUG_PREFIX + ' cannot load', { timeOut: 10000, extendedTimeOut: 20000, preventDuplicates: true });
                return;
            }
        );
    }
    catch (error) {
        console.debug(DEBUG_PREFIX,"Error when loading",model_path,":",error)
        toastr.error('Wrong avatar file:'+model_path, DEBUG_PREFIX + ' cannot load', { timeOut: 10000, extendedTimeOut: 20000, preventDuplicates: true });
        return null;
    }

    const vrm = gltf.userData.vrm;
    const vrmHipsY = vrm.humanoid?.getNormalizedBoneNode( 'hips' ).position.y;
    const vrmRootY = vrm.scene.position.y;
    const hipsHeight = Math.abs( vrmHipsY - vrmRootY ); // Used for offset center rotation and animation scaling

    // calling these functions greatly improves the performance
    VRMUtils.removeUnnecessaryVertices( gltf.scene );
    VRMUtils.removeUnnecessaryJoints( gltf.scene );

    // Disable frustum culling
    vrm.scene.traverse( ( obj ) => {
        obj.frustumCulled = false;
    } );

    // un-T-pose
    vrm.springBoneManager.reset();
    if (vrm.meta?.metaVersion === '1') {
        vrm.humanoid.getNormalizedBoneNode("rightUpperArm").rotation.z = -250;
        vrm.humanoid.getNormalizedBoneNode("rightLowerArm").rotation.z = 0.2;
        vrm.humanoid.getNormalizedBoneNode("leftUpperArm").rotation.z = 250;
        vrm.humanoid.getNormalizedBoneNode("leftLowerArm").rotation.z = -0.2;
    }
    else {
        vrm.humanoid.getNormalizedBoneNode("rightUpperArm").rotation.z = 250;
        vrm.humanoid.getNormalizedBoneNode("rightLowerArm").rotation.z = -0.2;
        vrm.humanoid.getNormalizedBoneNode("leftUpperArm").rotation.z = -250;
        vrm.humanoid.getNormalizedBoneNode("leftLowerArm").rotation.z = 0.2;
    }

    // Add vrm to scene
    VRMUtils.rotateVRM0(vrm); // rotate if the VRM is VRM0.0
    const scale = extension_settings.vrm.model_settings[model_path]["scale"];
    // Create a group to set model center as rotation/scaling origin
    const object_container = new THREE.Group(); // First container to scale/position center model
    object_container.visible = false;
    object_container.name = VRM_CONTAINER_NAME;
    object_container.model_path = model_path; // link to character for mouse controls
    object_container.scale.set(scale,scale,scale);
    object_container.position.y = 0.5; // offset to center model
    const verticalOffset = new THREE.Group(); // Second container to rotate center model
    verticalOffset.position.y = -hipsHeight; // offset model for rotate on "center"
    verticalOffset.add(vrm.scene)
    object_container.add(verticalOffset);
    //object_container.parent = scene;
    
    // Collider used to detect mouse click
    const boundingBox = new THREE.Box3(new THREE.Vector3(-0.5,-1.0,-0.5), new THREE.Vector3(0.5,1.0,0.5));
    const dimensions = new THREE.Vector3().subVectors( boundingBox.max, boundingBox.min );
    // make a BoxGeometry of the same size as Box3
    const boxGeo = new THREE.BoxGeometry(dimensions.x, dimensions.y, dimensions.z);
    // move new mesh center so it's aligned with the original object
    const matrix = new THREE.Matrix4().setPosition(dimensions.addVectors(boundingBox.min, boundingBox.max).multiplyScalar( 0.5 ));
    boxGeo.applyMatrix4(matrix);
    // make a mesh
    const collider = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial({
        visible: true,
        side: THREE.BackSide,
        wireframe: true,
        color:0xffff00
    }));
    collider.name = VRM_COLLIDER_NAME;
    collider.material.side = THREE.BackSide;
    //scene.add(collider);
    
    // Avatar dynamic settings
    const model = {
        "id": null,
        "model_path": model_path,
        "vrm": vrm, // the actual vrm object
        "hipsHeight": hipsHeight, // its original hips height, used for scaling loaded animation
        "objectContainer": object_container, // the actual 3d group containing the vrm scene, handle centered position/rotation/scaling
        "collider": collider,
        "expression": "none",
        "animation_mixer": new THREE.AnimationMixer(vrm.scene),
        "motion": {
            "name": "none",
            "animation": null
        },
        "talkEnd": 0,
        "hitboxes": {}
    };

    // Hit boxes
    if (extension_settings.vrm.hitboxes) {
        for(const body_part in HITBOXES)
        {
            const bone = vrm.humanoid.getNormalizedBoneNode(HITBOXES[body_part]["bone"])
            if (bone !== null) {
                const position = new THREE.Vector3();
                position.setFromMatrixPosition(bone.matrixWorld);
                console.debug(DEBUG_PREFIX,"Creating hitbox for",body_part,"at",position);

                const size = HITBOXES[body_part]["size"];
                const offset = HITBOXES[body_part]["offset"];

                // Collider used to detect mouse click
                const boundingBox = new THREE.Box3(new THREE.Vector3(-size.x,-size.y,-size.z), new THREE.Vector3(size.x,size.y,size.z));
                const dimensions = new THREE.Vector3().subVectors( boundingBox.max, boundingBox.min );
                // make a BoxGeometry of the same size as Box3
                const boxGeo = new THREE.BoxGeometry(dimensions.x, dimensions.y, dimensions.z);
                // move new mesh center so it's aligned with the original object
                const matrix = new THREE.Matrix4().setPosition(dimensions.addVectors(boundingBox.min, boundingBox.max).multiplyScalar( 0.5 ));
                boxGeo.applyMatrix4(matrix);
                // make a mesh
                const collider = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial({
                    visible: true,
                    side: THREE.BackSide,
                    wireframe: true,
                    color:HITBOXES[body_part]["color"]
                }));
                collider.name = body_part;
                if (vrm.meta?.metaVersion === '1')
                    collider.position.set(offset.x/hipsHeight,offset.y/hipsHeight,-offset.z/hipsHeight);
                else
                    collider.position.set(-offset.x/hipsHeight,offset.y/hipsHeight,offset.z/hipsHeight);
                // Create a offset container
                const offset_container = new THREE.Group(); // First container to scale/position center model
                offset_container.name = model_path+"_offsetContainer_hitbox_"+body_part;
                offset_container.visible = true;
                offset_container.add(collider);
                //scene.add(offset_container)

                //object_container.localToWorld(position);
                //position.add(new THREE.Vector3(offset.x,offset.y,offset.z));
                //collider.position.set(position.x,position.y,position.z);
                //scene.add(collider);

                model["hitboxes"][body_part] = {
                    "offsetContainer":offset_container,
                    "collider":collider
                }
            }
        }
    }

    //console.debug(DEBUG_PREFIX,vrm);

    // Cache model
    if (extension_settings.vrm.models_cache)
        models_cache[model_path] = model;

    await initModel(model);
    
    console.debug(DEBUG_PREFIX,"VRM fully loaded:",model_path);
    
    return model;
}

async function initModel(model) {
  const object_container = model["objectContainer"];
  const model_path = model["model_path"];

  object_container.scale.x = extension_settings.vrm.model_settings[model_path]['scale'];
  object_container.scale.y = extension_settings.vrm.model_settings[model_path]['scale'];
  object_container.scale.z = extension_settings.vrm.model_settings[model_path]['scale'];

  object_container.position.x = extension_settings.vrm.model_settings[model_path]['x'];
  object_container.position.y = extension_settings.vrm.model_settings[model_path]['y'];
  object_container.position.z = 0.0;

  object_container.rotation.x = extension_settings.vrm.model_settings[model_path]['rx'];
  object_container.rotation.y = extension_settings.vrm.model_settings[model_path]['ry'];
  object_container.rotation.z = 0.0;

  // Cache model animations
    if (extension_settings.vrm.animations_cache && animations_cache[model_path] === undefined) {
        animations_cache[model_path] = {};
        const animation_names = [extension_settings.vrm.model_settings[model_path]['animation_default']['motion']]
        for (const i in extension_settings.vrm.model_settings[model_path]['classify_mapping']) {
            animation_names.push(extension_settings.vrm.model_settings[model_path]['classify_mapping'][i]["motion"]);
        }

        let count = 0;
        for (const file of animations_files) {
            count++;
            for (const i of animation_names) {
                if(file.includes(i) && animations_cache[model_path][file] === undefined) {
                    console.debug(DEBUG_PREFIX,"Loading animation",file,count,"/",animations_files.length)
                    const clip = await loadAnimation(model["vrm"], model["hipsHeight"], file);
                    if (clip !== undefined)
                        animations_cache[model_path][file] = clip;
                }
            }
        }

        console.debug(DEBUG_PREFIX,"Cached animations:",animations_cache[model_path]);
    }
}

async function setExpression(character, value) {
    if (current_avatars[character] === undefined) {
        console.debug(DEBUG_PREFIX,"WARNING requested setExpression of character without vrm loaded:",character,"(loaded",current_avatars,")");
        return;
    }

    const vrm = current_avatars[character]["vrm"];
    const current_expression = current_avatars[character]["expression"];
    console.debug(DEBUG_PREFIX,"Switch expression of",character,"from",current_expression,"to",value);

    if (value == "none")
        value = "neutral";

    // Check if it's a custom blend shape group
    const blendShapeMapping = getBlendShapeMapping(character, value);

    if (blendShapeMapping && blendShapeMapping.blendShapes) {
        // Reset all expressions first
        resetAllBlendShapes(vrm);

        // Apply custom blend shape group
        const intensity = blendShapeMapping.intensity || 1.0;
        applyCustomBlendShapeGroup(character, vrm, value, intensity);
        current_avatars[character]["expression"] = value;
    } else {
        // Standard expression
        const expressionMap = vrm.expressionManager.expressionMap;
        if (expressionMap[value] === undefined) {
            console.debug(DEBUG_PREFIX, 'Expression not found:', value);
            value = "neutral";
        }

        // Reset all expressions
        for(const expression in vrm.expressionManager.expressionMap)
            vrm.expressionManager.setValue(expression, 0.0);

        vrm.expressionManager.setValue(value, 1.0);
        current_avatars[character]["expression"] = value;
    }
}

async function loadAnimation(vrm, hipsHeight, motion_file_path) {
    let clip;
    try {
        // Mixamo animation
        if (motion_file_path.endsWith(".fbx")) {
            clip = await loadMixamoAnimation(motion_file_path, vrm, hipsHeight);
        }
        else if (motion_file_path.endsWith(".bvh")) {
            clip = await loadBVHAnimation(motion_file_path, vrm, hipsHeight);
        }
        else if (motion_file_path.endsWith(".vmd")) {
            // MMD motion file
            clip = await loadMMDAnimation(motion_file_path, vrm, hipsHeight);
        }
        else if (motion_file_path.endsWith(".vrma")) {
            // VRMA (VRM Animation) file
            const vrmaLoader = new VRMALoader();
            const result = await vrmaLoader.loadAsync(motion_file_path, vrm);
            clip = result ? result.clip : null;
        }
        else {
            toastr.error('Wrong animation file format:' + motion_file_path, DEBUG_PREFIX + ' cannot play animation', { timeOut: 10000, extendedTimeOut: 20000, preventDuplicates: true });
            return null;
        }

        if (!clip) {
            toastr.error('Wrong animation file format:' + motion_file_path, DEBUG_PREFIX + ' cannot play animation', { timeOut: 10000, extendedTimeOut: 20000, preventDuplicates: true });
            return null;
        }
    }
    catch (error) {
        toastr.error('Wrong animation file format:' + motion_file_path, DEBUG_PREFIX + ' cannot play animation', { timeOut: 10000, extendedTimeOut: 20000, preventDuplicates: true });
        return null;
    }
    return clip;
}

async function setMotion(character, motion_file_path, loop=false, force=false, random=true ) {
    if (current_avatars[character] === undefined) {
        console.debug(DEBUG_PREFIX,"WARNING requested setMotion of character without vrm loaded:",character,"(loaded",current_avatars,")");
        return;
    }
    const model_path = extension_settings.vrm.character_model_mapping[character];
    const vrm = current_avatars[character]["vrm"];
    const hipsHeight = current_avatars[character]["hipsHeight"];

    // IMPORTANT: mixer might be undefined / invalid depending on load order or prior errors.
    let mixer = current_avatars[character]["animation_mixer"];

    const current_motion_name = current_avatars[character]["motion"]["name"];
    const current_motion_animation= current_avatars[character]["motion"]["animation"];
    let clip = undefined;

    console.debug(DEBUG_PREFIX,"Switch motion for",character,"from",current_motion_name,"to",motion_file_path,"loop=",loop,"force=",force,"random=",random);

    // Ensure VRM is actually present
    if (!vrm || !vrm.scene) {
        console.debug(DEBUG_PREFIX,"WARNING setMotion called but VRM/vrm.scene missing for character:",character,vrm);
        return;
    }

    // Ensure AnimationMixer exists and has a valid root
    // (The error you saw happens when mixer root is undefined and clipAction reads root.uuid.)
    if (!mixer || typeof mixer.clipAction !== 'function') {
        mixer = new THREE.AnimationMixer(vrm.scene);
        current_avatars[character]["animation_mixer"] = mixer;
        console.debug(DEBUG_PREFIX,"Created new AnimationMixer for",character);
    } else {
        // Some builds of three keep the root on _root; if it’s missing, recreate safely.
        // This is a pragmatic guard against mixer being created with an undefined root.
        if (!mixer._root) {
            mixer = new THREE.AnimationMixer(vrm.scene);
            current_avatars[character]["animation_mixer"] = mixer;
            console.debug(DEBUG_PREFIX,"Recreated AnimationMixer due to missing root for",character);
        }
    }

    // Disable current animation
    if (motion_file_path == "none") {
        if (current_motion_animation !== null) {
            current_motion_animation.fadeOut(ANIMATION_FADE_TIME);
            current_motion_animation.terminated = true;
        }
        current_avatars[character]["motion"]["name"] = "none";
        current_avatars[character]["motion"]["animation"] = null;
        return;
    }

    // Pick random animationX
    const filename = motion_file_path.replace(/\.[^/.]+$/, "").replace(/\d+$/, "");
    if (random) {
        let same_motion = []
        for(const i of animations_files) {
            if (i.replace(/\.[^/.]+$/, "").replace(/\d+$/, "") == filename)
            same_motion.push(i)
        }
        motion_file_path = same_motion[Math.floor(Math.random() * same_motion.length)];
        console.debug(DEBUG_PREFIX,"Picked a random animation among",same_motion,":",motion_file_path);
    }

  // new animation
  if (current_motion_name != motion_file_path || loop || force) {
    // Clear any natural idle timer to prevent it from interrupting the new animation
    if (naturalIdleTimers[character]) {
      clearTimeout(naturalIdleTimers[character]);
      delete naturalIdleTimers[character];
      console.debug(DEBUG_PREFIX,"Cleared natural idle timer for hitbox animation");
    }
    
    // Also fade out any current idle animation
    if (activeIdleAnimations[character]) {
      activeIdleAnimations[character].fadeOut(ANIMATION_FADE_TIME);
      delete activeIdleAnimations[character];
      console.debug(DEBUG_PREFIX,"Faded out idle animation for hitbox animation");
    }

    if (animations_cache[model_path] !== undefined && animations_cache[model_path][motion_file_path] !== undefined) {
      clip = animations_cache[model_path][motion_file_path];
    }
    else {
      clip = await loadAnimation(vrm, hipsHeight, motion_file_path);

      if (clip === null) {
        return;
      }

      if (extension_settings.vrm.animations_cache)
        animations_cache[model_path][motion_file_path] = clip;
    }

    // Guard: loadAnimation should return an AnimationClip, but be defensive
    if (!clip || typeof clip.duration !== 'number') {
      console.debug(DEBUG_PREFIX,"WARNING loadAnimation did not return a valid AnimationClip for",motion_file_path,clip);
      return;
    }

    // create AnimationAction for VRM
    const new_motion_animation = mixer.clipAction( clip );

    // Fade out current animation
    if ( current_motion_animation !== null ) {
      current_motion_animation.fadeOut( ANIMATION_FADE_TIME );
      current_motion_animation.terminated = true;
      console.debug(DEBUG_PREFIX,"Fade out previous animation");
    }

        // Fade in new animation
        new_motion_animation
            .reset()
            .setEffectiveTimeScale( 1 )
            .setEffectiveWeight( 1 )
            .fadeIn( ANIMATION_FADE_TIME )
            .play();
        new_motion_animation.terminated = false;
        console.debug(DEBUG_PREFIX,"Loading new animation",motion_file_path);

  current_avatars[character]["motion"]["name"] = motion_file_path;
  current_avatars[character]["motion"]["animation"] = new_motion_animation;
  
  // Restart natural idle if switching to an idle animation
  const motionNameBase = motion_file_path?.replace(/\.[^/.]+$/, "").replace(/\d+$/, "");
  const isIdleMotion = IDLE_ANIMS.some(idle => motionNameBase === idle) || motion_file_path === "none";
  if (isIdleMotion && extension_settings.vrm.natural_idle && loop) {
    console.debug(DEBUG_PREFIX, "Switched to idle animation, ensuring natural idle is active for", character);
    // Clear any existing timer and restart
    if (naturalIdleTimers[character]) {
      clearTimeout(naturalIdleTimers[character]);
      delete naturalIdleTimers[character];
    }
    const modelId = current_avatars[character]["id"];
    setTimeout(() => {
      naturalIdleMovement(character, modelId);
    }, ANIMATION_FADE_TIME * 2);
  }

    // Fade out animation after full loop
    if (!loop) {
      setTimeout(() => {
        if (!new_motion_animation.terminated) {
          setMotion(character, extension_settings.vrm.model_settings[model_path]["animation_default"]["motion"], true);
          // Restart natural idle system when returning to idle
          if (extension_settings.vrm.natural_idle) {
            const modelId = current_avatars[character]["id"];
            console.debug(DEBUG_PREFIX, "Animation ended, restarting natural idle for", character);
            naturalIdleMovement(character, modelId);
          }
        }
      }, clip.duration*1000 - ANIMATION_FADE_TIME*1000);
    }

    }
}

// Animation Sequence System
// Store for animation sequences per character
const animationSequences = {};
const sequencePlaybackState = {};

/**
 * Play a sequence of animations for a character
 * @param {string} character - Character name
 * @param {Array} sequence - Array of animation sequence items
 * @param {Object} options - Playback options
 * @param {boolean} options.loop - Whether to loop the entire sequence
 * @param {boolean} options.clearOnComplete - Whether to clear the sequence queue when done
 * @returns {Promise<boolean>} - Success status
 * 
 * Sequence item format:
 * {
 *   animation: string,      // Animation file path or name
 *   duration: number,     // How long to play (ms), or null for full animation
 *   wait: number,         // Wait time after animation before next (ms)
 *   expression: string,   // Expression to set during this animation
 *   loop: boolean,        // Whether to loop this specific animation
 *   transition: string    // Transition type: 'fade', 'cut', or 'crossfade'
 * }
 */
async function playAnimationSequence(character, sequence, options = {}) {
    if (current_avatars[character] === undefined) {
        console.warn(DEBUG_PREFIX, "Cannot play sequence - character not loaded:", character);
        return false;
    }

    if (!Array.isArray(sequence) || sequence.length === 0) {
        console.warn(DEBUG_PREFIX, "Invalid sequence provided for", character);
        return false;
    }

    // Store sequence and options
    animationSequences[character] = {
        items: sequence,
        currentIndex: -1,
        options: {
            loop: options.loop || false,
            clearOnComplete: options.clearOnComplete !== false,
            ...options
        }
    };

    console.debug(DEBUG_PREFIX, "Starting animation sequence for", character, "with", sequence.length, "items");
    
    // Start playing the sequence
    await playNextInSequence(character);
    return true;
}

/**
 * Play the next animation in a character's sequence
 * @param {string} character - Character name
 */
async function playNextInSequence(character) {
    const seqData = animationSequences[character];
    if (!seqData) return;

    seqData.currentIndex++;

    // Check if we've reached the end
    if (seqData.currentIndex >= seqData.items.length) {
        if (seqData.options.loop) {
            // Loop back to start
            seqData.currentIndex = 0;
            console.debug(DEBUG_PREFIX, "Looping sequence for", character);
        } else {
            // Sequence complete
            console.debug(DEBUG_PREFIX, "Sequence complete for", character);
            if (seqData.options.clearOnComplete) {
                delete animationSequences[character];
            }
            return;
        }
    }

    const item = seqData.items[seqData.currentIndex];
    const vrm = current_avatars[character]?.vrm;
    const model_path = extension_settings.vrm.character_model_mapping[character];

    if (!vrm || !model_path) {
        console.warn(DEBUG_PREFIX, "Cannot play sequence item - VRM or model path missing");
        return;
    }

    console.debug(DEBUG_PREFIX, "Playing sequence item", seqData.currentIndex + 1, "/", seqData.items.length, "for", character, ":", item);

    // Set expression if specified
    if (item.expression && item.expression !== "none") {
        await setExpression(character, item.expression);
    }

    // Resolve animation file path
    let animationFile = item.animation;

    // Handle 'none' animation - skip to next item after wait
    if (animationFile === 'none') {
        console.debug(DEBUG_PREFIX, "Skipping 'none' animation for", character);
        setTimeout(() => playNextInSequence(character), item.wait || 0);
        return;
    }

    if (!animationFile.includes('.')) {
        // Try to find matching animation file
        const fuse = new Fuse(animations_files);
        const results = fuse.search(animationFile);
        if (results.length > 0) {
            animationFile = results[0].item;
        }
    }

    if (!animationFile) {
        console.warn(DEBUG_PREFIX, "Animation not found:", item.animation);
        // Skip to next
        setTimeout(() => playNextInSequence(character), item.wait || 0);
        return;
    }

    // Determine transition type
    const transition = item.transition || 'fade';
    const isLoop = item.loop || false;

    // Play the animation
    // We need to handle the playback duration manually
    const hipsHeight = current_avatars[character]["hipsHeight"];
    let clip = null;

    // Load or get from cache
    if (animations_cache[model_path] !== undefined && animations_cache[model_path][animationFile] !== undefined) {
        clip = animations_cache[model_path][animationFile];
    } else {
        clip = await loadAnimation(vrm, hipsHeight, animationFile);
        if (clip && extension_settings.vrm.animations_cache) {
            animations_cache[model_path][animationFile] = clip;
        }
    }

    if (!clip || typeof clip.duration !== 'number') {
        console.warn(DEBUG_PREFIX, "Failed to load animation clip:", animationFile);
        setTimeout(() => playNextInSequence(character), item.wait || 0);
        return;
    }

    // Get mixer and play animation
    let mixer = current_avatars[character]["animation_mixer"];
    const current_motion_animation = current_avatars[character]["motion"]["animation"];

    // Ensure mixer exists
    if (!mixer || typeof mixer.clipAction !== 'function') {
        mixer = new THREE.AnimationMixer(vrm.scene);
        current_avatars[character]["animation_mixer"] = mixer;
    }

    // Create new animation action
    const new_motion_animation = mixer.clipAction(clip);

    // Handle transition
    if (current_motion_animation !== null) {
        if (transition === 'cut') {
            current_motion_animation.stop();
        } else if (transition === 'crossfade') {
            current_motion_animation.crossFadeTo(new_motion_animation, ANIMATION_FADE_TIME, false);
        } else {
            // default fade
            current_motion_animation.fadeOut(ANIMATION_FADE_TIME);
        }
        current_motion_animation.terminated = true;
    }

    // Start new animation
    new_motion_animation
        .reset()
        .setEffectiveTimeScale(1)
        .setEffectiveWeight(1)
        .fadeIn(transition === 'cut' ? 0 : ANIMATION_FADE_TIME)
        .play();
    new_motion_animation.terminated = false;

    // Update current motion tracking
    current_avatars[character]["motion"]["name"] = animationFile;
    current_avatars[character]["motion"]["animation"] = new_motion_animation;

    // Determine playback duration
    let playDuration;
    if (item.duration !== undefined && item.duration !== null) {
        // Use specified duration
        playDuration = item.duration;
    } else if (isLoop) {
        // Loop indefinitely (but we need to move on eventually, so use a long duration)
        playDuration = 10000; // 10 seconds max for loop items in sequences
    } else {
        // Use full animation duration
        playDuration = clip.duration * 1000;
    }

    // Schedule next item
    const waitTime = item.wait || 0;
    const totalTime = Math.max(0, playDuration - ANIMATION_FADE_TIME * 1000);

    setTimeout(() => {
        // Fade out current animation if not looping
        if (!isLoop && !new_motion_animation.terminated) {
            new_motion_animation.fadeOut(ANIMATION_FADE_TIME);
        }

        // Move to next after wait time
        setTimeout(() => {
            if (!new_motion_animation.terminated) {
                new_motion_animation.terminated = true;
            }
            playNextInSequence(character);
        }, waitTime + (isLoop ? 0 : ANIMATION_FADE_TIME * 1000));
    }, totalTime);
}

/**
 * Clear a character's animation sequence
 * @param {string} character - Character name
 */
function clearAnimationSequence(character) {
    if (animationSequences[character]) {
        delete animationSequences[character];
        console.debug(DEBUG_PREFIX, "Cleared animation sequence for", character);
    }
}

/**
 * Set and immediately play a motion sequence from a parsed string or array
 * @param {string} character - Character name
 * @param {string|Array} sequence - Sequence definition (string like "wave,wait:500,point" or array)
 * @param {Object} options - Playback options
 */
async function setMotionSequence(character, sequence, options = {}) {
    let parsedSequence;

    if (typeof sequence === 'string') {
        // Parse sequence string
        // Format: "animation1,animation2,wait:500,animation3:duration:2000"
        parsedSequence = parseSequenceString(sequence);
    } else if (Array.isArray(sequence)) {
        parsedSequence = sequence;
    } else {
        console.warn(DEBUG_PREFIX, "Invalid sequence format for", character);
        return false;
    }

    if (parsedSequence.length === 0) {
        console.warn(DEBUG_PREFIX, "Empty sequence for", character);
        return false;
    }

    return await playAnimationSequence(character, parsedSequence, options);
}

/**
 * Parse a sequence string into array format
 * @param {string} str - Sequence string
 * @returns {Array} Parsed sequence array
 */
function parseSequenceString(str) {
    const items = [];
    const parts = str.split(',').map(p => p.trim()).filter(p => p);

    for (const part of parts) {
        // Check for special commands
        if (part.startsWith('wait:')) {
            const waitTime = parseInt(part.split(':')[1]) || 500;
            items.push({ wait: waitTime, animation: 'none' });
            continue;
        }

        if (part.startsWith('expression:')) {
            const expr = part.split(':')[1];
            if (items.length > 0) {
                items[items.length - 1].expression = expr;
            }
            continue;
        }

        // Parse animation with optional parameters
        // Format: animationName[:duration:ms][:loop:true][:transition:fade]
        const params = part.split(':');
        const animation = params[0];
        
        const item = { animation };
        
        for (let i = 1; i < params.length; i += 2) {
            const key = params[i];
            const value = params[i + 1];
            
            if (!value) continue;
            
            switch (key) {
                case 'duration':
                    item.duration = parseInt(value);
                    break;
                case 'wait':
                    item.wait = parseInt(value);
                    break;
                case 'loop':
                    item.loop = value === 'true';
                    break;
                case 'transition':
                    item.transition = value;
                    break;
                case 'expression':
                    item.expression = value;
                    break;
            }
        }

        items.push(item);
    }

    return items;
}

async function updateExpression(chat_id) {
    const message = getContext().chat[chat_id];
    const character = message.name;
    const model_path = extension_settings.vrm.character_model_mapping[character];

    console.debug(DEBUG_PREFIX,'received new message :', message.mes);

    if (message.is_user)
        return;

    if (model_path === undefined) {
        console.debug(DEBUG_PREFIX, 'No model assigned to', character);
        return;
    }

    const expression = await getExpressionLabel(message.mes);
    let model_expression = extension_settings.vrm.model_settings[model_path]['classify_mapping'][expression]['expression'];
    let model_motion = extension_settings.vrm.model_settings[model_path]['classify_mapping'][expression]['motion'];
    let sequence = extension_settings.vrm.model_settings[model_path]['classify_mapping'][expression]['sequence'];

    console.debug(DEBUG_PREFIX,'Detected expression in message:',expression);

    // Fallback animations
    if (model_expression == 'none') {
        console.debug(DEBUG_PREFIX,'Expression is none, applying default expression', model_expression);
        model_expression = extension_settings.vrm.model_settings[model_path]['animation_default']['expression'];
    }

    // Check if sequence is defined and non-empty, use it instead of single motion
    if (sequence && sequence.trim()) {
        console.debug(DEBUG_PREFIX,'Using sequence for expression:', expression, sequence);
        // Don't fall back to default motion if sequence is set
    } else if (model_motion == 'none') {
        console.debug(DEBUG_PREFIX,'Motion is none, playing default motion', model_motion);
        model_motion = extension_settings.vrm.model_settings[model_path]['animation_default']['motion'];
    }

    console.debug(DEBUG_PREFIX,'Playing expression',expression,':', model_expression, model_motion, sequence);

    await setExpression(character, model_expression);
    
    // Play sequence if defined, otherwise play single motion
    if (sequence && sequence.trim()) {
        await setMotionSequence(character, sequence, { loop: false });
    } else {
        await setMotion(character, model_motion);
    }
}


// Scan for VRMA idle animation files
async function scanVRMAIdleFiles() {
  if (vrmaIdleFiles.length > 0) return; // Already scanned

  // Try to discover VRMA files in the extension directory
  // In SillyTavern, extensions are served from /scripts/extensions/[type]/[name]/
  const possibleFiles = [
    'FanningSelfOff_Idle.vrma',
    'FullBodyStretch_Idle.vrma',
    'Impatient_Idle.vrma',
    'InspectHands_Idle.vrma',
    'KickingGround_Idle.vrma',
    'LookBehind_Idle.vrma',
    'Sigh_Idle.vrma',
    'Yawn_Stretch_Idle.vrma'
  ];

  // Build full paths - Extension-VRM folder is at /scripts/extensions/third-party/Extension-VRM/
  const basePath = '/scripts/extensions/third-party/Extension-VRM/';

  for (const file of possibleFiles) {
    vrmaIdleFiles.push(`${basePath}${file}`);
  }

  console.debug(DEBUG_PREFIX, "Found VRMA idle files:", vrmaIdleFiles);
}

// Load a VRMA idle animation
async function loadVRMAIdleAnimation(vrm, hipsHeight, vrmaPath) {
  if (vrmaIdleCache[vrmaPath]) {
    return vrmaIdleCache[vrmaPath];
  }
  
  const vrmaLoader = new VRMALoader();
  const result = await vrmaLoader.loadAsync(vrmaPath, vrm);
  
  if (result && result.clip) {
    vrmaIdleCache[vrmaPath] = result.clip;
    return result.clip;
  }
  
  return null;
}

async function naturalIdleMovement(character, modelId) {
  console.debug(DEBUG_PREFIX, "naturalIdleMovement called for", character, "modelId:", modelId);
  
  if (current_avatars[character] === undefined || current_avatars[character]["id"] != modelId) {
    console.debug(DEBUG_PREFIX, "naturalIdleMovement - character not found or wrong model ID, returning");
    delete naturalIdleTimers[character];
    return;
  }

  const vrm = current_avatars[character]["vrm"];
  const motionName = current_avatars[character]["motion"]["name"];
  const model_path = extension_settings.vrm.character_model_mapping[character];
  const defaultMotion = extension_settings.vrm.model_settings[model_path]["animation_default"]["motion"];
  let mixer = current_avatars[character]["animation_mixer"];

  const motionNameBase = motionName?.replace(/\.[^/.]+$/, "").replace(/\d+$/, "");
  const defaultMotionBase = defaultMotion?.replace(/\.[^/.]+$/, "").replace(/\d+$/, "");

  const isIdle = IDLE_ANIMS.some(idle => {
    return motionNameBase === idle;
  }) || (motionName === "none") || (motionNameBase === defaultMotionBase);

  console.debug(DEBUG_PREFIX, "naturalIdleMovement - motionName:", motionName, "isIdle:", isIdle, "natural_idle enabled:", extension_settings.vrm.natural_idle);

  if (!isIdle || !extension_settings.vrm.natural_idle) {
    console.debug(DEBUG_PREFIX, "naturalIdleMovement - not idle mode or natural_idle disabled, rescheduling");
    const delayTime = Math.floor(Math.random() * 20000) + 10000;
    naturalIdleTimers[character] = setTimeout(() => {
      naturalIdleMovement(character, modelId);
    }, delayTime);
    if (proceduralState[character]) delete proceduralState[character];
    return;
  }

  // Check cooldown - must wait 7-21 seconds after last idle animation completed
  const now = Date.now();
  const lastCompletion = lastIdleCompletionTime[character] || 0;
  const cooldownDuration = Math.floor(Math.random() * 14000) + 7000; // 7-21 seconds
  const timeSinceLastCompletion = now - lastCompletion;
  
  if (timeSinceLastCompletion < cooldownDuration) {
    const remainingCooldown = cooldownDuration - timeSinceLastCompletion;
    console.debug(DEBUG_PREFIX, "Natural idle on cooldown for", character, "- waiting", remainingCooldown, "ms");
    naturalIdleTimers[character] = setTimeout(() => {
      naturalIdleMovement(character, modelId);
    }, remainingCooldown);
    return;
  }

  // Ensure mixer exists
  if (!mixer || typeof mixer.clipAction !== 'function') {
    mixer = new THREE.AnimationMixer(vrm.scene);
    current_avatars[character]["animation_mixer"] = mixer;
  }

  // Scan for VRMA files on first run
  await scanVRMAIdleFiles();

  // Randomly choose between VRMA file (30% chance) and procedural animation (70% chance)
  const useVRMA = vrmaIdleFiles.length > 0 && Math.random() < 0.3;
  
  let clip = null;
  let clipDuration = 0;
  let isVRMA = false;
  let vrmaFileName = '';
  let movementConfig = null;
  let randomizedRotation = 0;
  
  if (useVRMA) {
    // Select random VRMA file
    const selectedVRMA = vrmaIdleFiles[Math.floor(Math.random() * vrmaIdleFiles.length)];
    const hipsHeight = current_avatars[character]["hipsHeight"];
    
    console.debug(DEBUG_PREFIX, "Loading VRMA idle animation:", selectedVRMA, "for", character);
    
    try {
      clip = await loadVRMAIdleAnimation(vrm, hipsHeight, selectedVRMA);
      if (clip) {
        clipDuration = clip.duration;
        isVRMA = true;
        vrmaFileName = selectedVRMA.split('/').pop();
        console.debug(DEBUG_PREFIX, "Loaded VRMA idle animation:", selectedVRMA, "duration:", clipDuration);
      }
    } catch (error) {
      console.warn(DEBUG_PREFIX, "Failed to load VRMA idle animation:", selectedVRMA, error);
    }
  }
  
  // Fall back to procedural animation if VRMA failed or wasn't selected
  if (!clip) {
    // Select random procedural movement
    const movementKeys = Object.keys(IDLE_MOVEMENT_CONFIGS);
    const selectedKey = movementKeys[Math.floor(Math.random() * movementKeys.length)];
    movementConfig = IDLE_MOVEMENT_CONFIGS[selectedKey];

    console.debug(DEBUG_PREFIX, "Natural idle animation:", selectedKey, "-", movementConfig?.description || "unknown", "for", character);

    // Generate animation clip for this character
    const result = getIdleAnimationClip(character, vrm, selectedKey);
    clip = result.clip;
    randomizedRotation = result.randomizedRotation;
    
    if (!clip) {
      console.warn(DEBUG_PREFIX, "Failed to generate idle animation clip:", selectedKey);
      const nextDelay = Math.floor(Math.random() * 20000) + 10000;
      naturalIdleTimers[character] = setTimeout(() => {
        naturalIdleMovement(character, modelId);
      }, nextDelay);
      return;
    }
    
    clipDuration = clip.duration;
  }

  // Fade out previous idle animation if exists
  const prevIdleAction = activeIdleAnimations[character];
  if (prevIdleAction && prevIdleAction.isRunning && prevIdleAction.isRunning()) {
    prevIdleAction.fadeOut(ANIMATION_FADE_TIME);
    console.debug(DEBUG_PREFIX, "Fade out previous idle animation");
  }

  // For VRMA files, store base bone poses before playing
  // This prevents accumulation of bone rotations over multiple VRMA plays
  if (isVRMA) {
    vrmaBoneBasePoses[character] = {};
    const bonesToTrack = ['hips', 'spine', 'upperChest', 'chest', 'neck', 'head'];
    for (const boneName of bonesToTrack) {
      const bone = vrm.humanoid?.getNormalizedBoneNode(boneName);
      if (bone) {
        vrmaBoneBasePoses[character][boneName] = bone.quaternion.clone();
      }
    }
  }

  // Create and play new idle animation
  const idleAction = mixer.clipAction(clip);
  idleAction
    .reset()
    .setLoop(THREE.LoopOnce) // Don't loop - play once
    .setEffectiveTimeScale(1)
    .setEffectiveWeight(1)
    .fadeIn(ANIMATION_FADE_TIME)
    .play();

  activeIdleAnimations[character] = idleAction;
  
  if (isVRMA) {
    console.debug(DEBUG_PREFIX, "Playing VRMA idle animation:", vrmaFileName, "duration:", clipDuration, "for", character);
  } else {
    console.debug(DEBUG_PREFIX, "Playing procedural idle animation:", movementConfig?.description, "duration:", clipDuration, "for", character);
  }

  // Apply model rotation if configured (procedural only)
  if (!isVRMA && movementConfig && movementConfig.applyModelRotation && randomizedRotation !== 0) {
    const objectContainer = current_avatars[character]?.["objectContainer"];
    if (objectContainer) {
      const targetYaw = randomizedRotation;
      const duration = movementConfig.duration || 10000;
      applyModelRotation(vrm, character, modelId, targetYaw, duration);
    }
  }

  // Apply expression if configured
  if (!isVRMA && movementConfig && movementConfig.expressionChance && Math.random() < movementConfig.expressionChance) {
    const expressions = movementConfig.expressions || ['happy'];
    const randomExpression = expressions[Math.floor(Math.random() * expressions.length)];
    const delay = Math.random() * 1000 + 500;
    setTimeout(() => {
      if (current_avatars[character]?.vrm === vrm) {
        applyIdleExpression(vrm, character, randomExpression, 0.5, 2000);
      }
    }, delay);
  }
  
  // VRMA files also get expressions (40% chance)
  if (isVRMA && Math.random() < 0.4) {
    const expressions = ['happy', 'relaxed', 'surprised'];
    const randomExpression = expressions[Math.floor(Math.random() * expressions.length)];
    const delay = Math.random() * 1000 + 500;
    setTimeout(() => {
      if (current_avatars[character]?.vrm === vrm) {
        applyIdleExpression(vrm, character, randomExpression, 0.5, 2000);
      }
    }, delay);
  }

  // Schedule next idle animation after this one completes
  const clipDurationMs = clipDuration * 1000;
  const pauseAfter = Math.floor(Math.random() * 3000) + 2000; // 2-5 second pause (shorter for smoother flow)

  // For VRMA files, use a longer fade-out and restore base poses
  // to prevent bone rotation accumulation and snapping
  const fadeOutDuration = isVRMA ? Math.min(1500, clipDurationMs * 0.25) : ANIMATION_FADE_TIME;

  // Schedule fade-out - for VRMA start fading before end to blend smoothly
  const fadeOutDelay = isVRMA ? Math.max(clipDurationMs - fadeOutDuration - 200, clipDurationMs * 0.75) : clipDurationMs + pauseAfter;

  // First timeout: fade out the current animation
  naturalIdleTimers[character] = setTimeout(() => {
    const currentAction = activeIdleAnimations[character];
    if (currentAction) {
      // For VRMA, stop the action after fade to prevent bone pose lingering
      if (isVRMA) {
        currentAction.fadeOut(fadeOutDuration);
        setTimeout(() => {
          currentAction.stop();
          // Restore base bone poses to prevent accumulation
          if (vrmaBoneBasePoses[character]) {
            for (const [boneName, baseQuat] of Object.entries(vrmaBoneBasePoses[character])) {
              const bone = vrm.humanoid?.getNormalizedBoneNode(boneName);
              if (bone) {
                bone.quaternion.copy(baseQuat);
              }
            }
            delete vrmaBoneBasePoses[character];
            console.debug(DEBUG_PREFIX, "Restored base bone poses after VRMA animation");
          }
        }, fadeOutDuration + 100);
        console.debug(DEBUG_PREFIX, "Fading out VRMA idle animation with pose restoration");
      } else {
        currentAction.fadeOut(fadeOutDuration);
        console.debug(DEBUG_PREFIX, "Fade out idle animation before next");
      }
    }

      // Record completion time and schedule next idle after cooldown
      // The cooldown is enforced in naturalIdleMovement itself
      const completionTime = Date.now();
      lastIdleCompletionTime[character] = completionTime;
      console.debug(DEBUG_PREFIX, "Idle animation completed for", character, "at", completionTime, "- starting cooldown");
      
      // Reset cursor base poses after idle animation completes
      // This prevents cursor tracking from using stale base poses
      if (cursorBasePoses[character]) {
        const vrm = current_avatars[character]?.["vrm"];
        if (vrm?.humanoid) {
          const upperChest = vrm.humanoid.getNormalizedBoneNode("upperChest");
          const neck = vrm.humanoid.getNormalizedBoneNode("neck");
          if (upperChest) {
            cursorBasePoses[character]["upperChest"] = upperChest.quaternion.clone();
          }
          if (neck) {
            cursorBasePoses[character]["neck"] = neck.quaternion.clone();
          }
          console.debug(DEBUG_PREFIX, "Reset cursor base poses after idle animation for", character);
        }
      }
      
      // Schedule next idle after fade completes (add extra time for VRMA pose restoration)
      const nextDelay = isVRMA ? fadeOutDuration + 200 + pauseAfter : 0;
      setTimeout(() => {
        naturalIdleMovement(character, modelId);
      }, nextDelay);

  }, fadeOutDelay);
}

// Blink
function blink(character, modelId) {
    const avatar = current_avatars[character];
    if (avatar?.vrm?.expressionManager) {
        // Check for winking state and clear it
        const blinkLeftVal = avatar.vrm.expressionManager.getValue('blinkLeft') || 0;
        const blinkRightVal = avatar.vrm.expressionManager.getValue('blinkRight') || 0;
        if (blinkLeftVal > 0.1 || blinkRightVal > 0.1) {
            avatar.vrm.expressionManager.setValue('blinkLeft', 0);
            avatar.vrm.expressionManager.setValue('blinkRight', 0);
            avatar.winking = false;
            avatar.customWinking = false;
        }
    }

    if (current_avatars[character] === undefined || current_avatars[character]["id"] != modelId) {
        console.debug(DEBUG_PREFIX,"Stopping blink model is no more loaded:",character,modelId)
        return;
    }

    const vrm = current_avatars[character]["vrm"];

    var blinktimeout = Math.floor(Math.random() * 250) + 50;
    setTimeout(() => {
            vrm.expressionManager.setValue("blink",0);
    }, blinktimeout);
    
    vrm.expressionManager.setValue("blink",1.0);

    var rand = Math.round((2 + Math.random() * 10) * 1000);
    setTimeout(function () {
            blink(character,modelId);
    }, rand);
}

// One run for each character
// Animate mouth if talkEnd is set to a future time
// Terminated when model is unset
// Overrided by tts lip sync option
async function textTalk(character, modelId) {
    const mouth_open_speed = 1.5;
    // Model still here
    while (current_avatars[character] !== undefined && current_avatars[character]["id"] == modelId) {
        //console.debug(DEBUG_PREFIX,"text talk loop:",character,modelId)
        
        // Overrided by lip sync option
        if (!extension_settings.vrm.tts_lips_sync) {
            const vrm = current_avatars[character]["vrm"]
            const talkEnd = current_avatars[character]["talkEnd"]
            let mouth_y = 0.0;
            if (talkEnd > Date.now()) {
                mouth_y = (Math.sin((talkEnd - Date.now())) + 1) / 2;
                // Neutralize all expression in case setExpression called in parrallele
                for(const expression in vrm.expressionManager.expressionMap)
                    vrm.expressionManager.setValue(expression, Math.min(0.25, vrm.expressionManager.getValue(expression)));
                vrm.expressionManager.setValue("aa",mouth_y);
            }
            else { // Restaure expression
                vrm.expressionManager.setValue(current_avatars[character]["expression"],1.0);
                vrm.expressionManager.setValue("aa",0.0);
            }
        }
        await delay(100 / mouth_open_speed);
    }

    console.debug(DEBUG_PREFIX,"Stopping text talk loop model is no more loaded:",character,modelId);
}

// Add text duration to current_avatars[character]["talkEnd"]
// Overrided by tts lip sync option
async function talk(chat_id) {
    // TTS lip sync overide
    if (extension_settings.vrm.tts_lips_sync)
        return;

    // No model for user or system
    if (getContext().chat[chat_id].is_user || getContext().chat[chat_id].is_system)
        return;

    const message = getContext().chat[chat_id]
    const text = message.mes;
    const character = message.name;

    console.debug(DEBUG_PREFIX,"Playing mouth animation for",character," message:",text);

    // No model loaded for character
    if(current_avatars[character] === undefined) {
        console.debug(DEBUG_PREFIX,"No model loaded, cannot animate talk")
        return;
    }

    current_avatars[character]["talkEnd"] = Date.now() + text.length * 50;
}

// handle window resizes
window.addEventListener( 'resize', onWindowResize, false );

function onWindowResize(){
    if (camera !== undefined && renderer !== undefined) {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();

        renderer.setSize( window.innerWidth, window.innerHeight );
    }
}

// Update a character model to fit the saved settings
async function updateModel(character) {
    if (current_avatars[character] !== undefined) {
        const object_container = current_avatars[character]["objectContainer"];
        const model_path = extension_settings.vrm.character_model_mapping[character];

        object_container.scale.x = extension_settings.vrm.model_settings[model_path]['scale'];
        object_container.scale.y = extension_settings.vrm.model_settings[model_path]['scale'];
        object_container.scale.z = extension_settings.vrm.model_settings[model_path]['scale'];

        object_container.position.x = extension_settings.vrm.model_settings[model_path]['x'];
        object_container.position.y = extension_settings.vrm.model_settings[model_path]['y'];
        object_container.position.z = extension_settings.vrm.model_settings[model_path]['z']; //0.0; // In case somehow it get away from 0

        object_container.rotation.x = extension_settings.vrm.model_settings[model_path]['rx'];
        object_container.rotation.y = extension_settings.vrm.model_settings[model_path]['ry'];
        object_container.rotation.z = extension_settings.vrm.model_settings[model_path]['rz']; //0.0; // In case somehow it get away from 0

        console.debug(DEBUG_PREFIX,"Updated model:",character)
        console.debug(DEBUG_PREFIX,"Scale:",object_container.scale)
        console.debug(DEBUG_PREFIX,"Position:",object_container.position)
        console.debug(DEBUG_PREFIX,"Rotation:",object_container.rotation)
    }
}

// Currently loaded character VRM accessor
function getVRM(character) {
    if (current_avatars[character] === undefined)
        return undefined;
    return current_avatars[character]["vrm"];
}

function clearModelCache() {
    models_cache = {};
    console.debug(DEBUG_PREFIX,"Cleared model cache");
}

function clearAnimationCache() {
    animations_cache = {};
    console.debug(DEBUG_PREFIX,"Cleared animation cache");
}

// Global state for lip sync cleanup between chunks
let currentLipSyncCleanup = null;

// Real-time lip sync using VoiceForge's shared analyser
// Much simpler than per-chunk analysis - just reads actual audio output
let realtimeLipSyncActive = false;
let realtimeLipSyncCharacter = null;
let realtimeLipSyncAnimationId = null;

const REALTIME_MOUTH_THRESHOLD = 22;  // Higher threshold - mouth only opens on clear audio
const REALTIME_MOUTH_BOOST = 8;
const REALTIME_VOWEL_DAMP = 60;
const REALTIME_VOWEL_MIN = 18;
const REALTIME_MOUTH_CUTOFF = 0.1;  // Snap to 0 below this threshold
const REALTIME_UPDATE_INTERVAL = 16; // ~60fps for smoother animation

// Per-viseme decay rates - very aggressive for snappy closure at 60fps
const VISEME_DECAY = {
    aa: 0.5,   // Open mouth - decay per frame at 60fps
    ee: 0.45,  // Spread lips - fast
    ih: 0.45,  // Similar to ee
    oh: 0.55,  // Round mouth - slightly slower
    ou: 0.5,   // Pucker
};

function startRealtimeLipSync(character) {
    if (realtimeLipSyncActive && realtimeLipSyncCharacter === character) {
        return; // Already running for this character
    }
    
    stopRealtimeLipSync(); // Stop any existing
    
    realtimeLipSyncActive = true;
    realtimeLipSyncCharacter = character;
    
    console.debug(DEBUG_PREFIX, "Starting real-time lip sync for", character);
    
    let lastUpdate = 0;
    
    function animate() {
        if (!realtimeLipSyncActive) return;
        
        const analyser = window.getVoiceForgeAnalyser?.();
        if (!analyser || current_avatars[character] === undefined) {
            realtimeLipSyncAnimationId = requestAnimationFrame(animate);
            return;
        }
        
        const now = Date.now();
        if (now - lastUpdate < REALTIME_UPDATE_INTERVAL) {
            realtimeLipSyncAnimationId = requestAnimationFrame(animate);
            return;
        }
        lastUpdate = now;
        
        const expressionMgr = current_avatars[character]["vrm"].expressionManager;
        
        // Get frequency data from VoiceForge's actual audio output
        const array = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(array);
        
        // Formant-based frequency band analysis
        // Based on typical speech formant frequencies:
        // - F1 (300-800Hz): Mouth openness
        // - F2 (800-2500Hz): Front/back tongue position (ee vs ou)
        const binCount = array.length;
        const sampleRate = 48000; // Typical audio sample rate
        const binHz = sampleRate / (binCount * 2);
        
        // Frequency bands based on formants
        const veryLowEnd = Math.floor(400 / binHz);    // 0-400Hz (ou/oh base)
        const lowEnd = Math.floor(800 / binHz);        // 400-800Hz (F1 - openness)
        const midEnd = Math.floor(1500 / binHz);       // 800-1500Hz (aa region)
        const highEnd = Math.floor(2500 / binHz);      // 1500-2500Hz (ee/ih F2)
        
        let veryLowSum = 0, lowSum = 0, midSum = 0, highSum = 0, totalSum = 0;
        for (let i = 0; i < Math.min(binCount, highEnd + 50); i++) {
            const val = array[i];
            totalSum += val;
            if (i < veryLowEnd) veryLowSum += val;
            else if (i < lowEnd) lowSum += val;
            else if (i < midEnd) midSum += val;
            else if (i < highEnd) highSum += val;
        }
        
        const veryLowAvg = veryLowSum / Math.max(1, veryLowEnd);
        const lowAvg = lowSum / Math.max(1, lowEnd - veryLowEnd);
        const midAvg = midSum / Math.max(1, midEnd - lowEnd);
        const highAvg = highSum / Math.max(1, highEnd - midEnd);
        const totalAvg = totalSum / Math.max(1, Math.min(binCount, highEnd + 50));
        const inputVolume = totalAvg;
        
        if (inputVolume > (REALTIME_MOUTH_THRESHOLD * 2)) {
            // Neutralize other expressions
            for (const expression in expressionMgr.expressionMap) {
                if (!['aa', 'ee', 'ih', 'oh', 'ou'].includes(expression)) {
                    expressionMgr.setValue(expression, Math.min(0.25, expressionMgr.getValue(expression)));
                }
            }
            
            // Calculate base mouth opening from F1 region (overall energy)
            const baseOpen = Math.min(1.0, ((totalAvg - REALTIME_VOWEL_MIN) / REALTIME_VOWEL_DAMP) * (REALTIME_MOUTH_BOOST / 10));
            
            // Determine viseme weights based on formant distribution
            const totalEnergy = veryLowAvg + lowAvg + midAvg + highAvg + 0.1;
            
            // ou (oo): Very low F2, pucker - dominant very low frequencies
            const ouWeight = (veryLowAvg * 1.5) / totalEnergy;
            // oh (oh): Low F2, round mouth - low frequencies
            const ohWeight = (lowAvg * 1.3 + veryLowAvg * 0.5) / totalEnergy;
            // aa (ah): Mid F1/F2, open mouth - mid frequencies dominant
            const aaWeight = (midAvg * 1.5 + lowAvg * 0.5) / totalEnergy;
            // ee (eh): Higher F2, spread - mid-high frequencies
            const eeWeight = (highAvg * 0.8 + midAvg * 0.4) / totalEnergy;
            // ih (ee): Highest F2, spread lips - high frequencies
            const ihWeight = (highAvg * 1.2) / totalEnergy;
            
            // Set viseme values directly for snappy response
            expressionMgr.setValue("ou", Math.min(1.0, baseOpen * ouWeight * 1.0));
            expressionMgr.setValue("oh", Math.min(1.0, baseOpen * ohWeight * 1.1));
            expressionMgr.setValue("aa", Math.min(1.0, baseOpen * aaWeight * 1.3));
            expressionMgr.setValue("ee", Math.min(1.0, baseOpen * eeWeight * 0.9));
            expressionMgr.setValue("ih", Math.min(1.0, baseOpen * ihWeight * 0.7));
        } else {
            // Decay mouth closed - per-viseme decay rates for natural movement
            const decayViseme = (name) => {
                const current = expressionMgr.getValue(name) || 0;
                const decayed = current * VISEME_DECAY[name];
                return decayed < REALTIME_MOUTH_CUTOFF ? 0 : decayed;
            };
            expressionMgr.setValue("aa", decayViseme("aa"));
            expressionMgr.setValue("ee", decayViseme("ee"));
            expressionMgr.setValue("ih", decayViseme("ih"));
            expressionMgr.setValue("oh", decayViseme("oh"));
            expressionMgr.setValue("ou", decayViseme("ou"));
        }
        
        realtimeLipSyncAnimationId = requestAnimationFrame(animate);
    }
    
    realtimeLipSyncAnimationId = requestAnimationFrame(animate);
}

function stopRealtimeLipSync() {
    if (realtimeLipSyncAnimationId) {
        cancelAnimationFrame(realtimeLipSyncAnimationId);
        realtimeLipSyncAnimationId = null;
    }
    
    // Close mouth
    if (realtimeLipSyncCharacter && current_avatars[realtimeLipSyncCharacter]) {
        const expressionMgr = current_avatars[realtimeLipSyncCharacter]["vrm"].expressionManager;
        expressionMgr.setValue("aa", 0);
        expressionMgr.setValue("ee", 0);
        expressionMgr.setValue("ih", 0);
        expressionMgr.setValue("oh", 0);
        expressionMgr.setValue("ou", 0);
    }
    
    realtimeLipSyncActive = false;
    realtimeLipSyncCharacter = null;
    console.debug(DEBUG_PREFIX, "Stopped real-time lip sync");
}

// Expose for VoiceForge to control
window.vrmStartLipSync = startRealtimeLipSync;
window.vrmStopLipSync = stopRealtimeLipSync;

// Generic API for any TTS provider to trigger lip sync
// Other TTS extensions can call: window.vrmLipSyncAudio(audioBlob, characterName)
window.vrmLipSyncAudio = async function(blob, character) {
    if (!extension_settings.vrm.tts_lips_sync) return;
    if (!blob || !character) return;
    
    await audioTalk(blob, character, { webAudio: false });
};

// Perform audio lip sync
// Overried text mouth movement
// 
// Parameters:
//   blob: Audio blob to analyze
//   character: Character name for VRM model lookup
//   options: Optional object with:
//     - webAudio: true if using Web Audio API for playback (VoiceForge gapless mode)
//     - startTime: When audio will start playing (audioContext.currentTime value)
//     - audioContext: Shared audio context from caller (for sync with Web Audio playback)
//
async function audioTalk(blob, character, options = {}) {
    // Option disable
    if (!extension_settings.vrm.tts_lips_sync)
        return;
    
    const useWebAudio = options.webAudio === true;
    
    // For Web Audio mode: use real-time lip sync from VoiceForge's shared analyser
    // Much simpler and more reliable than per-chunk analysis
    if (useWebAudio) {
        startRealtimeLipSync(character);
        return; // Real-time mode handles everything via animation loop
    }
    
    // Audio element mode: use legacy per-blob analysis
    if (currentLipSyncCleanup) {
        try {
            currentLipSyncCleanup();
        } catch (e) {
            console.debug(DEBUG_PREFIX, "Previous cleanup error (safe to ignore):", e.message);
        }
        currentLipSyncCleanup = null;
    }
    
    tts_lips_sync_job_id++;
    const job_id = tts_lips_sync_job_id;
    console.debug(DEBUG_PREFIX, "Received lipsync", blob, character, job_id, "(Audio Element mode)");

    // Track state - set up BEFORE any async work
    let sourceStarted = false;
    let endTalkCalled = false;
    let audioReady = false;
    let audioContext = null;
    let analyser = null;
    let source = null;
    let javascriptNode = null;
    let audioDuration = 0;
    let startTimestamp = 0;
    
    const mouththreshold = 8;   // Lower = responds to quieter audio (default 10)
    const mouthboost = 14;      // Higher = wider mouth opening (default 10)
    let lastUpdate = 0;
    const LIPS_SYNC_DELAY = 33;  // Faster updates for snappier lip sync (was 66ms = ~15fps, now ~30fps)
    const MOUTH_DECAY = 0.65;   // How fast mouth closes during silence (0-1, lower = faster close)
    
    // For Web Audio mode: track when this chunk SHOULD be playing
    const chunkStartTime = options.startTime || 0;  // audioContext time when chunk should start
    const contextTimeAtCreation = options.audioContext ? options.audioContext.currentTime : 0;
    
    // Decode audio in background (don't block)
    const setupAudio = async () => {
        try {
            // Use shared context if provided, otherwise create new one
            audioContext = options.audioContext || new(window.AudioContext || window.webkitAudioContext)();
            analyser = audioContext.createAnalyser();
            analyser.smoothingTimeConstant = 0.5;
            analyser.fftSize = 1024;

            const arrayBuffer = await blob.arrayBuffer();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            audioDuration = audioBuffer.duration;

            source = audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(analyser);

            // For Web Audio mode, don't connect to destination (VoiceForge handles actual playback)
            // Just use this for analysis
            javascriptNode = audioContext.createScriptProcessor(256, 1, 1);
            analyser.connect(javascriptNode);
            
            // Only connect to destination if we're not in Web Audio mode
            // In Web Audio mode, VoiceForge plays the audio, we just analyze
            if (!useWebAudio) {
                javascriptNode.connect(audioContext.destination);
            } else {
                // Create a silent destination for the script processor
                const silentGain = audioContext.createGain();
                silentGain.gain.value = 0;
                javascriptNode.connect(silentGain);
                silentGain.connect(audioContext.destination);
            }
            
            audioReady = true;
            
            // Set up source ended handler for clean termination
            // But NOT in Web Audio mode - chunks run in parallel and shouldn't terminate each other
            if (!useWebAudio) {
                source.onended = () => {
                    console.debug(DEBUG_PREFIX, "Lip sync source ended naturally");
                    if (!endTalkCalled) {
                        endTalk();
                    }
                };
            } else {
                // In Web Audio mode, just log when source ends (no termination)
                source.onended = () => {
                    console.debug(DEBUG_PREFIX, "Lip sync chunk analysis finished (Web Audio, not terminating)");
                };
            }
            
            // If audio already started playing, start the source now
            if (sourceStarted && !endTalkCalled) {
                // Always start immediately - time window checks in onAudioProcess handle timing
                source.start(0);
                javascriptNode.onaudioprocess = onAudioProcess;
                console.debug(DEBUG_PREFIX, "Lip sync (async) started, duration:", audioDuration.toFixed(2) + "s");
            }
        } catch (e) {
            console.debug(DEBUG_PREFIX, "Audio setup error:", e.message);
        }
    };
    
    // Start async setup but don't await
    setupAudio();

    var audio = document.getElementById("tts_audio");
    
    function endTalk() {
        // Prevent multiple calls
        if (endTalkCalled) return;
        endTalkCalled = true;
        
        // Clear global cleanup reference
        if (currentLipSyncCleanup === endTalk) {
            currentLipSyncCleanup = null;
        }
        
        try {
            if (source && sourceStarted) {
                source.stop(0);
            }
            if (source) source.disconnect();
            if (analyser) analyser.disconnect();
            if (javascriptNode) javascriptNode.disconnect();
            // Only close context if we created it (not shared)
            if (audioContext && !options.audioContext) audioContext.close();
        } catch (e) {
            // Ignore cleanup errors - nodes may already be disconnected
            console.debug(DEBUG_PREFIX, "Cleanup error (safe to ignore):", e.message);
        }
        
        // Only reset mouth visemes in audio element mode (single audio)
        // In Web Audio mode, another chunk might still be playing - don't reset
        if (!useWebAudio && current_avatars[character] !== undefined) {
            const expressionMgr = current_avatars[character]["vrm"].expressionManager;
            expressionMgr.setValue("aa", 0);
            expressionMgr.setValue("ee", 0);
            expressionMgr.setValue("ih", 0);
            expressionMgr.setValue("oh", 0);
            expressionMgr.setValue("ou", 0);
        }

        if (!useWebAudio) {
            audio.removeEventListener("play", startTalk);
            audio.removeEventListener("ended", endTalk);
        }
    }
    
    // Register this job's cleanup function globally
    currentLipSyncCleanup = endTalk;

    function startTalk() {
        if (sourceStarted || endTalkCalled) return; // Prevent double-start or start after cleanup
        sourceStarted = true;
        startTimestamp = Date.now();
        
        // If audio is ready, start the source and processing
        if (audioReady && source && !endTalkCalled) {
            try {
                // Always start immediately - we use time window checks in onAudioProcess
                // to determine when this chunk should actually animate
                source.start(0);
                javascriptNode.onaudioprocess = onAudioProcess;
                
                if (useWebAudio) {
                    console.debug(DEBUG_PREFIX, "Lip sync chunk started, window:", chunkStartTime.toFixed(2), "-", (chunkStartTime + audioDuration).toFixed(2) + "s");
                } else {
                    console.debug(DEBUG_PREFIX, "Lip sync source started, duration:", audioDuration.toFixed(2) + "s");
                }
            } catch (e) {
                console.debug(DEBUG_PREFIX, "Source start error:", e.message);
            }
        }
        // If not ready yet, setupAudio() will start it when done
        
        if (!useWebAudio) {
            audio.removeEventListener("play", startTalk);
        }
    }
    
    function onAudioProcess() {
        // Don't process if not ready or already ended
        if (!audioReady || !sourceStarted || endTalkCalled) {
            return;
        }
        
        // Check for termination conditions
        if (useWebAudio) {
            // In Web Audio mode, check if we're within this chunk's expected playback window
            // This prevents early chunks from interfering with later chunks' animation
            if (audioContext && audioDuration > 0) {
                const now = audioContext.currentTime;
                const chunkEnd = chunkStartTime + audioDuration;
                
                // Only animate if we're within this chunk's playback window (with small buffer)
                if (now < chunkStartTime - 0.1 || now > chunkEnd + 0.3) {
                    // Outside our window - don't animate, let other chunks handle it
                    return;
                }
            }
        } else {
            // In audio element mode, check audio state
            if (job_id != tts_lips_sync_job_id || audio.paused) {
                console.debug(DEBUG_PREFIX, "TTS lip sync job", job_id, "terminated");
                endTalk();
                return;
            }
        }

        var array = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(array);

        // Frequency band analysis for viseme selection
        // Split spectrum into bands for different mouth shapes
        const binCount = array.length;
        const lowEnd = Math.floor(binCount * 0.15);   // 0-15% = low frequencies (oh/ou)
        const midEnd = Math.floor(binCount * 0.4);    // 15-40% = mid frequencies (aa)
        const highEnd = Math.floor(binCount * 0.7);   // 40-70% = high frequencies (ee/ih)

        let lowSum = 0, midSum = 0, highSum = 0, totalSum = 0;
        for (let i = 0; i < binCount; i++) {
            totalSum += array[i];
            if (i < lowEnd) lowSum += array[i];
            else if (i < midEnd) midSum += array[i];
            else if (i < highEnd) highSum += array[i];
        }

        // Normalize by band size
        const lowAvg = lowSum / lowEnd;
        const midAvg = midSum / (midEnd - lowEnd);
        const highAvg = highSum / (highEnd - midEnd);
        const totalAvg = totalSum / binCount;

        var inputvolume = totalAvg * (audioContext.sampleRate / 48000); // Normalize threshold

        var voweldamp = 42;     // Lower = bigger movements (default 53)
        var vowelmin = 10;      // Lower = responds to quieter audio (default 12)

        if(lastUpdate < (Date.now() - LIPS_SYNC_DELAY)) {
            if (current_avatars[character] !== undefined) {
                const expressionMgr = current_avatars[character]["vrm"].expressionManager;

                if (inputvolume > (mouththreshold * 2)) {
                    // Neutralize other expressions only when we have audio to animate
                    for(const expression in expressionMgr.expressionMap) {
                        if (!['aa', 'ee', 'ih', 'oh', 'ou'].includes(expression)) {
                            expressionMgr.setValue(expression, Math.min(0.25, expressionMgr.getValue(expression)));
                        }
                    }

                    // Calculate base mouth opening
                    const baseOpen = Math.min(1.0, ((totalAvg - vowelmin) / voweldamp) * (mouthboost / 10));

                    // Determine dominant frequency band for viseme selection
                    const maxBand = Math.max(lowAvg, midAvg, highAvg);

                    if (maxBand > vowelmin) {
                        // Blend visemes based on frequency distribution
                        const lowWeight = lowAvg / (lowAvg + midAvg + highAvg + 0.1);
                        const midWeight = midAvg / (lowAvg + midAvg + highAvg + 0.1);
                        const highWeight = highAvg / (lowAvg + midAvg + highAvg + 0.1);

                        // Low frequencies = rounder mouth shapes (oh, ou)
                        // Mid frequencies = open mouth (aa)
                        // High frequencies = spread lips (ee, ih)

                        const ohValue = baseOpen * lowWeight * 1.2;
                        const ouValue = baseOpen * lowWeight * 0.8;
                        const aaValue = baseOpen * midWeight * 1.5;  // aa is primary
                        const eeValue = baseOpen * highWeight * 0.9;
                        const ihValue = baseOpen * highWeight * 0.6;

                        // Set all mouth visemes
                        expressionMgr.setValue("oh", Math.min(1.0, ohValue));
                        expressionMgr.setValue("ou", Math.min(1.0, ouValue));
                        expressionMgr.setValue("aa", Math.min(1.0, aaValue));
                        expressionMgr.setValue("ee", Math.min(1.0, eeValue));
                        expressionMgr.setValue("ih", Math.min(1.0, ihValue));
                    }
                }
                else {
                    // Silence detected - gradually close mouth (decay)
                    // This looks better than instant snap-shut, and handles gaps between chunks
                    const currentAa = expressionMgr.getValue("aa") || 0;
                    const currentEe = expressionMgr.getValue("ee") || 0;
                    const currentIh = expressionMgr.getValue("ih") || 0;
                    const currentOh = expressionMgr.getValue("oh") || 0;
                    const currentOu = expressionMgr.getValue("ou") || 0;

                    // Apply decay - mouth smoothly closes
                    expressionMgr.setValue("aa", currentAa * MOUTH_DECAY);
                    expressionMgr.setValue("ee", currentEe * MOUTH_DECAY);
                    expressionMgr.setValue("ih", currentIh * MOUTH_DECAY);
                    expressionMgr.setValue("oh", currentOh * MOUTH_DECAY);
                    expressionMgr.setValue("ou", currentOu * MOUTH_DECAY);
                }
            }
            lastUpdate = Date.now();
        }
    }

    if (useWebAudio) {
        // Web Audio mode: start immediately (VoiceForge handles actual playback timing)
        // The audio analysis runs in parallel with VoiceForge's scheduled playback
        startTalk();

        // Set up auto-end based on duration
        setupAudio().then(() => {
            if (audioDuration > 0 && !endTalkCalled) {
                setTimeout(() => {
                    if (!endTalkCalled && job_id === tts_lips_sync_job_id) {
                        endTalk();
                    }
                }, (audioDuration + 0.5) * 1000);
            }
        });
    } else {
        // Audio element mode: Set up event listeners IMMEDIATELY (synchronously) so they're ready when audio plays
        // The actual audio processing setup happens async in setupAudio()
        audio.addEventListener("play", startTalk, { once: true });
        audio.addEventListener("ended", endTalk, { once: true });
    }

    // TODO: restaure expression weight ?
}

window['vrmLipSync'] = audioTalk;

// color: any valid color format
// intensity: percent 0-100
function setLight(color,intensity) {

    light.color = new THREE.Color(color);
    light.intensity = intensity/100;
}

function setBackground(scenePath, scale, position, rotation) {

    if (background) {
        scene.remove(scene.getObjectByName(background.name));
    }

    if (scenePath.endsWith(".fbx")) {
        const fbxLoader = new FBXLoader()
        fbxLoader.load(
            scenePath,
        (object) => {
            // object.traverse(function (child) {
            //     if ((child as THREE.Mesh).isMesh) {
            //         // (child as THREE.Mesh).material = material
            //         if ((child as THREE.Mesh).material) {
            //             ((child as THREE.Mesh).material as THREE.MeshBasicMaterial).transparent = false
            //         }
            //     }
            // })
            // object.scale.set(.01, .01, .01)
            background = object;
            background.scale.set(scale, scale, scale);
            background.position.set(position.x,position.y,position.z);
            background.rotation.set(rotation.x,rotation.y,rotation.z);
            background.name = "background";
            scene.add(background);
        },
        (xhr) => {
            console.log((xhr.loaded / xhr.total) * 100 + '% loaded')
        },
        (error) => {
            console.log(error)
        }
        )
    }

    if (scenePath.endsWith(".gltf")) {
        const loader = new GLTFLoader();

        loader.load( scenePath, function ( gltf ) {

            background = gltf.scene;
            background.scale.set(scale, scale, scale);
            background.position.set(position.x,position.y,position.z);
            background.rotation.set(rotation.x,rotation.y,rotation.z);
            scene.add(background);

        }, undefined, function ( error ) {

            console.error( error );

        } );
    }
}