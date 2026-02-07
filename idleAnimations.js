/**
 * Idle Animation System
 * Generates procedural AnimationClips for natural idle movements
 * These integrate with the AnimationMixer for proper fade in/out support
 */

import * as THREE from './lib/three.module.js';
import { DEBUG_PREFIX } from './constants.js';

/**
 * Generate a procedural idle animation clip
 * @param {VRM} vrm - The VRM instance
 * @param {Object} movementConfig - Configuration for the movement
 * @param {string} movementConfig.type - Movement type ('head', 'body', 'hips', etc.)
 * @param {number} movementConfig.duration - Duration in milliseconds
 * @param {Object} movementConfig.rotations - Map of bone names to rotation deltas {x, y, z}
 * @param {string} clipName - Name for the animation clip
 * @returns {THREE.AnimationClip} The generated animation clip
 */
export function generateIdleAnimationClip(vrm, movementConfig, clipName = 'naturalIdle') {
    const tracks = [];
    const duration = movementConfig.duration / 1000; // Convert to seconds
    const rampDuration = 3.5; // 3.5 seconds ramp up/down
    const holdDuration = duration - (rampDuration * 2);
    
    // Generate tracks for each bone
    for (const [boneName, rotation] of Object.entries(movementConfig.rotations)) {
        const bone = vrm.humanoid?.getNormalizedBoneNode(boneName);
        if (!bone) continue;
        
        const track = generateBoneTrack(bone, boneName, rotation, rampDuration, holdDuration);
        if (track) {
            tracks.push(track);
        }
    }
    
    if (tracks.length === 0) {
        console.warn(DEBUG_PREFIX, 'No valid bone tracks generated for idle animation:', clipName);
        return null;
    }
    
    return new THREE.AnimationClip(clipName, duration, tracks);
}

/**
 * Generate a quaternion keyframe track for a single bone
 * @param {THREE.Bone} bone - The bone to animate
 * @param {string} boneName - Name of the bone (VRM humanoid name)
 * @param {Object} rotationDelta - Euler rotation delta {x, y, z} in radians
 * @param {number} rampDuration - Ramp up/down duration in seconds
 * @param {number} holdDuration - Hold duration in seconds
 * @returns {THREE.QuaternionKeyframeTrack} The generated track
 */
function generateBoneTrack(bone, boneName, rotationDelta, rampDuration, holdDuration) {
    if (!bone || !bone.name) {
        console.warn(DEBUG_PREFIX, 'Invalid bone for track generation:', boneName);
        return null;
    }
    
    const baseQuat = bone.quaternion.clone();
    const baseEuler = new THREE.Euler().setFromQuaternion(baseQuat);
    
    // Calculate target rotation
    const targetEuler = new THREE.Euler(
        baseEuler.x + (rotationDelta.x || 0),
        baseEuler.y + (rotationDelta.y || 0),
        baseEuler.z + (rotationDelta.z || 0)
    );
    const targetQuat = new THREE.Quaternion().setFromEuler(targetEuler);
    
    // Create keyframes with easeInOutCubic interpolation
    const times = [0, rampDuration, rampDuration + holdDuration, rampDuration * 2 + holdDuration];
    const values = [];
    
    // Start at base
    values.push(baseQuat.x, baseQuat.y, baseQuat.z, baseQuat.w);
    
    // Ramp up to target
    values.push(targetQuat.x, targetQuat.y, targetQuat.z, targetQuat.w);
    
    // Hold at target
    values.push(targetQuat.x, targetQuat.y, targetQuat.z, targetQuat.w);
    
    // Ramp down to base
    values.push(baseQuat.x, baseQuat.y, baseQuat.z, baseQuat.w);
    
    // Track path: use the actual Three.js bone node name, not the VRM humanoid name
    const trackPath = bone.name + '.quaternion';
    return new THREE.QuaternionKeyframeTrack(trackPath, times, values);
}

/**
 * Movement definitions converted to rotation configurations
 * These generate procedural animations instead of manipulating bones directly
 */
export const IDLE_MOVEMENT_CONFIGS = {
  slowHeadTurn: {
    type: 'head',
    duration: 12000,
    description: 'slow head turn',
    rotations: {
      head: { x: 0.08, y: 0.35, z: 0.05 },
      neck: { x: 0.04, y: 0.15, z: 0.03 }
    },
    applyModelRotation: true,
    modelRotationRange: { min: 0.08, max: 0.18 }
  },
  headTilt: {
    type: 'head',
    duration: 12000,
    description: 'curious head tilt',
    rotations: {
      head: { x: 0.06, y: 0.08, z: 0.35 },
      neck: { x: 0.03, y: 0.05, z: 0.2 }
    },
    expressionChance: 0.5,
    expressions: ['happy', 'blinkLeft', 'blinkRight'],
    applyModelRotation: false
  },
  slowGlance: {
    type: 'head',
    duration: 10000,
    description: 'casual glance',
    rotations: {
      head: { x: 0.12, y: 0.28, z: 0.08 },
      neck: { x: 0.06, y: 0.15, z: 0.04 },
      spine: { x: 0.03, y: 0.12, z: 0.05 }
    },
    expressionChance: 0.5,
    expressions: ['surprised'],
    applyModelRotation: true,
    modelRotationRange: { min: 0.05, max: 0.12 }
  },
  lookAround: {
    type: 'head',
    duration: 16000,
    description: 'looking around',
    rotations: {
      head: { x: 0.1, y: 0.25, z: 0.05 }
    },
    multiStage: true,
    stages: [
      { rotations: { head: { x: 0.12, y: 0.32, z: 0.04 } }, duration: 3500 },
      { rotations: { head: { x: 0.05, y: 0.08, z: 0.02 } }, duration: 2500 },
      { rotations: { head: { x: 0.1, y: -0.28, z: -0.03 } }, duration: 3500 },
      { rotations: { head: { x: 0.02, y: -0.06, z: 0.01 } }, duration: 3000 }
    ],
    expressionChance: 0.6,
    expressions: ['happy'],
    applyModelRotation: true,
    modelRotationRange: { min: 0.06, max: 0.12 }
  },
  weightShift: {
    type: 'body',
    duration: 10000,
    description: 'weight shift with spine twist',
    rotations: {
      spine: { x: 0.08, y: 0.22, z: 0.15 },
      hips: { x: 0.06, y: -0.12, z: 0.12 },
      upperChest: { x: 0.04, y: 0.1, z: 0.08 }
    },
    expressionChance: 0.4,
    expressions: ['neutral'],
    applyModelRotation: true,
    modelRotationRange: { min: 0.08, max: 0.18 }
  },
  neckStretch: {
    type: 'neck',
    duration: 10000,
    description: 'neck stretch',
    rotations: {
      neck: { x: 0.12, y: 0.25, z: 0.35 },
      head: { x: 0.08, y: 0.15, z: 0.28 }
    },
    expressionChance: 0.5,
    expressions: ['surprised'],
    applyModelRotation: false
  },
  subtleNod: {
    type: 'head',
    duration: 8000,
    description: 'subtle nod',
    rotations: {
      head: { x: 0.22, y: 0.05, z: 0.03 },
      neck: { x: 0.12, y: 0.03, z: 0.02 }
    },
    expressionChance: 0.7,
    expressions: ['happy'],
    applyModelRotation: false
  },
  hipShift: {
    type: 'hips',
    duration: 11000,
    description: 'hip shift with rotation',
    rotations: {
      hips: { x: 0.1, y: 0.25, z: 0.22 },
      spine: { x: 0.08, y: -0.15, z: -0.12 },
      upperChest: { x: 0.05, y: 0.08, z: 0.06 }
    },
    expressionChance: 0.4,
    expressions: ['surprised'],
    applyModelRotation: true,
    modelRotationRange: { min: 0.08, max: 0.16 }
  },
  torsoSway: {
    type: 'torso',
    duration: 12000,
    description: 'torso sway with twist',
    rotations: {
      spine: { x: 0.1, y: 0.28, z: 0.12 },
      upperChest: { x: 0.08, y: 0.18, z: 0.1 },
      hips: { x: 0.05, y: -0.1, z: 0.08 }
    },
    expressionChance: 0.5,
    expressions: ['surprised', 'relaxed'],
    applyModelRotation: true,
    modelRotationRange: { min: 0.08, max: 0.18 }
  },
  feminineHipSway: {
    type: 'hips',
    duration: 14000,
    description: 'feminine hip sway',
    rotations: {
      hips: { x: 0.08, y: 0.15, z: 0.35 },
      spine: { x: 0.06, y: -0.1, z: -0.18 },
      upperChest: { x: 0.08, y: -0.12, z: -0.12 },
      neck: { x: 0.04, y: -0.08, z: 0.1 }
    },
    expressionChance: 0.7,
    expressions: ['happy'],
    applyModelRotation: true,
    modelRotationRange: { min: 0.06, max: 0.14 }
  },
  coyHeadTilt: {
    type: 'head',
    duration: 11000,
    description: 'coy head tilt',
    rotations: {
      head: { x: 0.15, y: 0.12, z: -0.38 },
      neck: { x: 0.08, y: 0.06, z: -0.22 }
    },
    expressionChance: 0.7,
    expressions: ['relaxed', 'shy'],
    applyModelRotation: false
  },
  chestLift: {
    type: 'chest',
    duration: 9000,
    description: 'chest lift',
    rotations: {
      upperChest: { x: 0.22, y: 0.08, z: 0.05 },
      spine: { x: 0.12, y: 0.06, z: 0.04 },
      neck: { x: -0.08, y: 0.04, z: 0.03 }
    },
    expressionChance: 0.6,
    expressions: ['happy', 'relaxed'],
    applyModelRotation: false
  }
};

/**
 * Generate a multi-stage animation clip (e.g., lookAround with multiple positions)
 * @param {VRM} vrm - The VRM instance
 * @param {Object} config - Movement configuration
 * @returns {THREE.AnimationClip} The generated animation clip
 */
export function generateMultiStageAnimationClip(vrm, config) {
    const tracks = [];
    let maxDuration = 0;
    
    // Collect all bone names used across stages
    const allBones = new Set();
    config.stages.forEach(stage => {
        Object.keys(stage.rotations).forEach(bone => allBones.add(bone));
    });
    
    // Generate tracks for each bone
    for (const boneName of allBones) {
        const bone = vrm.humanoid?.getNormalizedBoneNode(boneName);
        if (!bone) continue;
        
        const baseQuat = bone.quaternion.clone();
        const baseEuler = new THREE.Euler().setFromQuaternion(baseQuat);
        
        const times = [0];
        const values = [baseQuat.x, baseQuat.y, baseQuat.z, baseQuat.w];
        
        let currentTime = 0;
        
        for (const stage of config.stages) {
            const stageDuration = stage.duration / 1000;
            const rotation = stage.rotations[boneName] || { x: 0, y: 0, z: 0 };
            
            // Target rotation
            const targetEuler = new THREE.Euler(
                baseEuler.x + (rotation.x || 0),
                baseEuler.y + (rotation.y || 0),
                baseEuler.z + (rotation.z || 0)
            );
            const targetQuat = new THREE.Quaternion().setFromEuler(targetEuler);
            
            // Transition to target
            currentTime += stageDuration;
            times.push(currentTime);
            values.push(targetQuat.x, targetQuat.y, targetQuat.z, targetQuat.w);
        }
        
        // Return to base
        const returnDuration = 2500 / 1000;
        currentTime += returnDuration;
        times.push(currentTime);
        values.push(baseQuat.x, baseQuat.y, baseQuat.z, baseQuat.w);
        
        // Track max duration across all bones
        if (currentTime > maxDuration) {
            maxDuration = currentTime;
        }
        
        // Use the actual Three.js bone node name, not the VRM humanoid name
        const trackPath = bone.name + '.quaternion';
        tracks.push(new THREE.QuaternionKeyframeTrack(trackPath, times, values));
    }
    
    if (tracks.length === 0) return null;
    
    return new THREE.AnimationClip(config.description.replace(/\s+/g, ''), maxDuration, tracks);
}

/**
 * Generate a random variation of a movement configuration
 * @param {Object} baseConfig - Base movement configuration
 * @returns {Object} Randomized configuration
 */
export function randomizeMovementConfig(baseConfig) {
    const config = JSON.parse(JSON.stringify(baseConfig)); // Deep copy
    
    // Randomize rotations
    for (const [boneName, rotation] of Object.entries(config.rotations)) {
        // Random direction
        const dirX = Math.random() > 0.5 ? 1 : -1;
        const dirY = Math.random() > 0.5 ? 1 : -1;
        const dirZ = Math.random() > 0.5 ? 1 : -1;
        
        // Apply randomization
        rotation.x = (rotation.x || 0) * dirX * (0.8 + Math.random() * 0.4);
        rotation.y = (rotation.y || 0) * dirY * (0.8 + Math.random() * 0.4);
        rotation.z = (rotation.z || 0) * dirZ * (0.8 + Math.random() * 0.4);
    }
    
    // Randomize model rotation if applicable
    if (config.applyModelRotation) {
        config.modelRotation = (
            config.modelRotationRange.min + 
            Math.random() * (config.modelRotationRange.max - config.modelRotationRange.min)
        ) * (Math.random() > 0.5 ? 1 : -1);
    }
    
    return config;
}

/**
 * Get or generate an idle animation clip for a character
 * Generates fresh each time to ensure proper randomization
 * @param {string} character - Character name
 * @param {VRM} vrm - The VRM instance
 * @param {string} movementKey - Key from IDLE_MOVEMENT_CONFIGS
 * @returns {Object} Object containing { clip, randomizedRotation }
 */
export function getIdleAnimationClip(character, vrm, movementKey) {
    const config = IDLE_MOVEMENT_CONFIGS[movementKey];
    if (!config) {
        console.warn(DEBUG_PREFIX, 'Unknown idle movement:', movementKey);
        return { clip: null, randomizedRotation: 0 };
    }
    
    const randomizedConfig = randomizeMovementConfig(config);
    
    let clip;
    if (randomizedConfig.multiStage) {
        clip = generateMultiStageAnimationClip(vrm, randomizedConfig);
    } else {
        clip = generateIdleAnimationClip(vrm, randomizedConfig, movementKey);
    }
    
    return {
        clip: clip,
        randomizedRotation: randomizedConfig.modelRotation || 0
    };
}
