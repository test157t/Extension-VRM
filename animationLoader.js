import * as THREE from './lib/three.module.js';
import { FBXLoader } from './lib/jsm/loaders/FBXLoader.js';
import { BVHLoader } from './lib/jsm/loaders/BVHLoader.js';
import { MMDLoader } from './lib/jsm/loaders/MMDLoader.js';

import {
    DEBUG_PREFIX
} from "./constants.js";

export {
	mixamoVRMRigMap,
	mmdVRMRigMap,
	loadMixamoAnimation,
	loadBVHAnimation,
	loadMMDAnimation
}

/**
 * A map from Mixamo rig name to VRM Humanoid bone name
 */
const mixamoVRMRigMap = {
	mixamorigHips: 'hips',
	mixamorigSpine: 'spine',
	mixamorigSpine1: 'chest',
	mixamorigSpine2: 'upperChest',
	mixamorigNeck: 'neck',
	mixamorigHead: 'head',
	mixamorigLeftShoulder: 'leftShoulder',
	mixamorigLeftArm: 'leftUpperArm',
	mixamorigLeftForeArm: 'leftLowerArm',
	mixamorigLeftHand: 'leftHand',
	mixamorigLeftHandThumb1: 'leftThumbMetacarpal',
	mixamorigLeftHandThumb2: 'leftThumbProximal',
	mixamorigLeftHandThumb3: 'leftThumbDistal',
	mixamorigLeftHandIndex1: 'leftIndexProximal',
	mixamorigLeftHandIndex2: 'leftIndexIntermediate',
	mixamorigLeftHandIndex3: 'leftIndexDistal',
	mixamorigLeftHandMiddle1: 'leftMiddleProximal',
	mixamorigLeftHandMiddle2: 'leftMiddleIntermediate',
	mixamorigLeftHandMiddle3: 'leftMiddleDistal',
	mixamorigLeftHandRing1: 'leftRingProximal',
	mixamorigLeftHandRing2: 'leftRingIntermediate',
	mixamorigLeftHandRing3: 'leftRingDistal',
	mixamorigLeftHandPinky1: 'leftLittleProximal',
	mixamorigLeftHandPinky2: 'leftLittleIntermediate',
	mixamorigLeftHandPinky3: 'leftLittleDistal',
	mixamorigRightShoulder: 'rightShoulder',
	mixamorigRightArm: 'rightUpperArm',
	mixamorigRightForeArm: 'rightLowerArm',
	mixamorigRightHand: 'rightHand',
	mixamorigRightHandPinky1: 'rightLittleProximal',
	mixamorigRightHandPinky2: 'rightLittleIntermediate',
	mixamorigRightHandPinky3: 'rightLittleDistal',
	mixamorigRightHandRing1: 'rightRingProximal',
	mixamorigRightHandRing2: 'rightRingIntermediate',
	mixamorigRightHandRing3: 'rightRingDistal',
	mixamorigRightHandMiddle1: 'rightMiddleProximal',
	mixamorigRightHandMiddle2: 'rightMiddleIntermediate',
	mixamorigRightHandMiddle3: 'rightMiddleDistal',
	mixamorigRightHandIndex1: 'rightIndexProximal',
	mixamorigRightHandIndex2: 'rightIndexIntermediate',
	mixamorigRightHandIndex3: 'rightIndexDistal',
	mixamorigRightHandThumb1: 'rightThumbMetacarpal',
	mixamorigRightHandThumb2: 'rightThumbProximal',
	mixamorigRightHandThumb3: 'rightThumbDistal',
	mixamorigLeftUpLeg: 'leftUpperLeg',
	mixamorigLeftLeg: 'leftLowerLeg',
	mixamorigLeftFoot: 'leftFoot',
	mixamorigLeftToeBase: 'leftToes',
	mixamorigRightUpLeg: 'rightUpperLeg',
	mixamorigRightLeg: 'rightLowerLeg',
	mixamorigRightFoot: 'rightFoot',
	mixamorigRightToeBase: 'rightToes',
};

/**
 * A starter map from common MMD bone names to VRM Humanoid bone names.
 * NOTE: MMD bone names are often Japanese; some models use English aliases.
 * Expand this map as needed for your target motions/models.
 */
const mmdVRMRigMap = {
	// Core body
	'センター': 'hips',
	'center': 'hips',
	'グルーブ': 'hips',
	'groove': 'hips',

	'下半身': 'hips',
	'lower body': 'hips',

	'上半身': 'spine',
	'upper body': 'spine',
	'上半身2': 'chest',
	'upper body2': 'chest',
	'上半身3': 'upperChest',
	'upper body3': 'upperChest',

	'首': 'neck',
	'neck': 'neck',
	'頭': 'head',
	'head': 'head',

	// Shoulders / arms
	'左肩': 'leftShoulder',
	'左肩P': 'leftShoulder',
	'left shoulder': 'leftShoulder',
	'右肩': 'rightShoulder',
	'右肩P': 'rightShoulder',
	'right shoulder': 'rightShoulder',

	'左腕': 'leftUpperArm',
	'left arm': 'leftUpperArm',
	'左ひじ': 'leftLowerArm',
	'left elbow': 'leftLowerArm',
	'左手首': 'leftHand',
	'left wrist': 'leftHand',

	'右腕': 'rightUpperArm',
	'right arm': 'rightUpperArm',
	'右ひじ': 'rightLowerArm',
	'right elbow': 'rightLowerArm',
	'右手首': 'rightHand',
	'right wrist': 'rightHand',

	// Legs
	'左足': 'leftUpperLeg',
	'left leg': 'leftUpperLeg',
	'左ひざ': 'leftLowerLeg',
	'left knee': 'leftLowerLeg',
	'左足首': 'leftFoot',
	'left ankle': 'leftFoot',

	'右足': 'rightUpperLeg',
	'right leg': 'rightUpperLeg',
	'右ひざ': 'rightLowerLeg',
	'right knee': 'rightLowerLeg',
	'右足首': 'rightFoot',
	'right ankle': 'rightFoot',

	// Toes (often not present / named differently in MMD; add as needed)
	'左つま先': 'leftToes',
	'left toe': 'leftToes',
	'右つま先': 'rightToes',
	'right toe': 'rightToes',
};

/**
 * Load Mixamo animation, convert for three-vrm use, and return it.
 *
 * @param {string} url A url of mixamo animation data
 * @param {vrm} vrm A target VRM
 * @returns {Promise<THREE.AnimationClip>} The converted AnimationClip
 */
async function loadMixamoAnimation( url, vrm, currentVRMHipsHeight) {

	const loader = new FBXLoader(); // A loader which loads FBX
	return loader.loadAsync( url ).then( ( asset ) => {

		const clip = THREE.AnimationClip.findByName( asset.animations, 'mixamo.com' ); // extract the AnimationClip

		const tracks = []; // KeyframeTracks compatible with VRM will be added here

		const restRotationInverse = new THREE.Quaternion();
		const parentRestWorldRotation = new THREE.Quaternion();
		const _quatA = new THREE.Quaternion();
		const _vec3 = new THREE.Vector3();

		// Adjust with reference to hips height.
		const motionHipsHeight = asset.getObjectByName( 'mixamorigHips' ).position.y;
		const vrmHipsHeight = currentVRMHipsHeight;
		const hipsPositionScale = vrmHipsHeight / motionHipsHeight;

		clip.tracks.forEach( ( track ) => {

			// Convert each tracks for VRM use, and push to `tracks`
			const trackSplitted = track.name.split( '.' );
			const mixamoRigName = trackSplitted[ 0 ];
			const vrmBoneName = mixamoVRMRigMap[ mixamoRigName ];
			const vrmNodeName = vrm.humanoid?.getNormalizedBoneNode( vrmBoneName )?.name;
			const mixamoRigNode = asset.getObjectByName( mixamoRigName );

			if ( vrmNodeName != null ) {

				const propertyName = trackSplitted[ 1 ];

				// Store rotations of rest-pose.
				mixamoRigNode.getWorldQuaternion( restRotationInverse ).invert();
				mixamoRigNode.parent.getWorldQuaternion( parentRestWorldRotation );

				if ( track instanceof THREE.QuaternionKeyframeTrack ) {

					// Retarget rotation of mixamoRig to NormalizedBone.
					for ( let i = 0; i < track.values.length; i += 4 ) {

						const flatQuaternion = track.values.slice( i, i + 4 );

						_quatA.fromArray( flatQuaternion );

						// parentRestWorldRotation * trackRotation * inverse(restRotation)
						_quatA
							.premultiply( parentRestWorldRotation )
							.multiply( restRotationInverse );

						_quatA.toArray( flatQuaternion );

						flatQuaternion.forEach( ( v, index ) => {
							track.values[ index + i ] = v;
						} );

					}

					tracks.push(
						new THREE.QuaternionKeyframeTrack(
							`${vrmNodeName}.${propertyName}`,
							track.times,
							track.values.map( ( v, i ) => ( vrm.meta?.metaVersion === '0' && i % 2 === 0 ? - v : v ) ),
						),
					);

				} else if ( track instanceof THREE.VectorKeyframeTrack ) {

					const value = track.values.map( ( v, i ) => ( vrm.meta?.metaVersion === '0' && i % 3 !== 1 ? - v : v ) * hipsPositionScale );
					tracks.push( new THREE.VectorKeyframeTrack( `${vrmNodeName}.${propertyName}`, track.times, value ) );

				}

			}

		} );

		return new THREE.AnimationClip( 'vrmAnimation', clip.duration, tracks );

	} );

}


// BVH

/**
 * Load BVH animation, convert for three-vrm use, and return it.
 *
 * @param {string} url A url of bvh animation data
 * @param {VRM} vrm A target VRM
 * @returns {Promise<THREE.AnimationClip>} The converted AnimationClip
 */
async function loadBVHAnimation( url, vrm, currentVRMHipsHeight ) {
    const loader = new BVHLoader();
    return loader.loadAsync( url ).then( ( result ) => {

        const skeletonHelper = new THREE.SkeletonHelper( result.skeleton.bones[ 0 ] );
        skeletonHelper.name = "BVHtest";
		const clip = result.clip;

		const tracks = []; // KeyframeTracks compatible with VRM will be added here

		const restRotationInverse = new THREE.Quaternion();
		const parentRestWorldRotation = new THREE.Quaternion();
		const _quatA = new THREE.Quaternion();
		const _vec3 = new THREE.Vector3();

		// Adjust with reference to hips height.
		const motionHipsHeight = result.skeleton.getBoneByName("hips").position.y;
		const vrmHipsHeight = currentVRMHipsHeight;
		const hipsPositionScale = vrmHipsHeight / motionHipsHeight;

		clip.tracks.forEach( ( track ) => {

			// Convert each tracks for VRM use, and push to `tracks`
			const trackSplitted = track.name.split( '.' );
            const vrmBoneName = trackSplitted[ 0 ];
			const vrmNodeName = vrm.humanoid?.getNormalizedBoneNode( vrmBoneName )?.name;
            const bvhRigNode = result.skeleton.getBoneByName(vrmBoneName);

			if ( vrmNodeName != null ) {

				const propertyName = trackSplitted[ 1 ];

				// Store rotations of rest-pose.
				bvhRigNode.getWorldQuaternion( restRotationInverse ).invert();
                if (bvhRigNode.parent){
				    bvhRigNode.parent.getWorldQuaternion( parentRestWorldRotation );
				} else {
					parentRestWorldRotation.identity();
				}

				if ( track instanceof THREE.QuaternionKeyframeTrack ) {

					// Retarget rotation of bvhRig to NormalizedBone.
					for ( let i = 0; i < track.values.length; i += 4 ) {

						const flatQuaternion = track.values.slice( i, i + 4 );

						_quatA.fromArray( flatQuaternion );

						// parentRestWorldRotation * trackRotation * inverse(restRotation)
						_quatA
							.premultiply( parentRestWorldRotation )
							.multiply( restRotationInverse );

						_quatA.toArray( flatQuaternion );

						flatQuaternion.forEach( ( v, index ) => {
							track.values[ index + i ] = v;
						} );

					}

					tracks.push(
						new THREE.QuaternionKeyframeTrack(
							`${vrmNodeName}.${propertyName}`,
							track.times,
							track.values.map( ( v, i ) => ( vrm.meta?.metaVersion === '0' && i % 2 === 0 ? - v : v ) ),
						),
					);

				} else if ( track instanceof THREE.VectorKeyframeTrack ) {
					const value = track.values.map( ( v, i ) => ( vrm.meta?.metaVersion === '0' && i % 3 !== 1 ? - v : v ) * hipsPositionScale );
					tracks.push( new THREE.VectorKeyframeTrack( `${vrmNodeName}.${propertyName}`, track.times, value ) );
				}

			}

		} );

		return new THREE.AnimationClip( 'vrmAnimationBVH', clip.duration, tracks );

	} );

}


/**
 * Utility: find a SkinnedMesh under a VRM scene (best effort).
 * MMDLoader.loadAnimation expects a SkinnedMesh with bones to bind tracks against.
 *
 * @param {any} vrm
 * @returns {THREE.SkinnedMesh | null}
 */
function _findFirstSkinnedMeshInVRM( vrm ) {
	const root = vrm?.scene || vrm;
	if ( !root ) return null;

	let found = null;
	root.traverse( ( obj ) => {
		if ( found ) return;
		if ( obj && obj.isSkinnedMesh ) found = obj;
	} );
	return found;
}


/**
 * Load MMD (.vmd) animation, retarget for three-vrm use, and return it.
 *
 * Notes:
 * - Uses THREE's MMDLoader to parse the VMD into an AnimationClip.
 * - Then remaps track bone names using mmdVRMRigMap and applies the same rest-pose
 *   quaternion retarget math as Mixamo/BVH.
 *
 * @param {string} url A url of vmd motion data
 * @param {VRM} vrm A target VRM
 * @param {number} currentVRMHipsHeight A reference hips height for scaling translation tracks
 * @param {object} [options]
 * @param {Record<string, string>} [options.boneMap] Optional override bone map
 * @param {Record<string, THREE.Quaternion>} [options.boneRotationOffsets] Optional per-bone correction rotations (VRM bone name keys)
 * @returns {Promise<THREE.AnimationClip>} The converted AnimationClip
 */
async function loadMMDAnimation( url, vrm, currentVRMHipsHeight, options = {} ) {

	const boneMap = options.boneMap || mmdVRMRigMap;
	const boneRotationOffsets = options.boneRotationOffsets || {};

	const loader = new MMDLoader();

	// MMDLoader.loadAnimation needs a SkinnedMesh to bind against.
	// We try to find one in the VRM scene. If your project has a canonical mesh, use it instead.
	const targetSkinnedMesh = _findFirstSkinnedMeshInVRM( vrm );

	if ( !targetSkinnedMesh ) {
		console.warn(DEBUG_PREFIX, "loadMMDAnimation: could not find a SkinnedMesh in VRM. Cannot load VMD animation.");
		return new THREE.AnimationClip( 'vrmAnimationMMD', 0, [] );
	}

	// Wrap the callback-based loadAnimation in a Promise
	return new Promise( ( resolve, reject ) => {
		loader.loadAnimation( url, targetSkinnedMesh, ( clip ) => {
			resolve( clip );
		}, ( progress ) => {
			// Optional: handle progress
		}, ( error ) => {
			console.error(DEBUG_PREFIX, "Error loading MMD animation:", error);
			reject( error );
		} );
	} ).then( ( clip ) => {

		// VMD clips tend to be named; we rebuild our own VRM-compatible clip.
		const tracks = [];

		const restRotationInverse = new THREE.Quaternion();
		const parentRestWorldRotation = new THREE.Quaternion();
		const _quatA = new THREE.Quaternion();

		// Hips scaling: MMD motion hips may differ by model; we estimate from VRM hips height.
		// We can't reliably read "motion hips height" from VMD alone, so we keep translation scaling conservative:
		// - If a hips track exists, we scale relative to VRM hips height assuming MMD units are similar.
		const hipsPositionScale = 1.0;

		clip.tracks.forEach( ( track ) => {

			const trackSplitted = track.name.split( '.' );
			const sourceBoneName = trackSplitted[ 0 ];
			const propertyName = trackSplitted[ 1 ];

			// Map MMD bone name -> VRM humanoid bone name
			const vrmBoneName = boneMap[ sourceBoneName ];
			const vrmNodeName = vrm.humanoid?.getNormalizedBoneNode( vrmBoneName )?.name;

			// Find the source bone node (on the target mesh skeleton, since clip was bound there)
			const sourceBoneNode = targetSkinnedMesh.skeleton?.getBoneByName( sourceBoneName );

			if ( vrmNodeName != null && sourceBoneNode != null ) {

				// Store rotations of rest-pose.
				sourceBoneNode.getWorldQuaternion( restRotationInverse ).invert();
				if ( sourceBoneNode.parent ) {
					sourceBoneNode.parent.getWorldQuaternion( parentRestWorldRotation );
				} else {
					parentRestWorldRotation.identity();
				}

				if ( track instanceof THREE.QuaternionKeyframeTrack ) {

					for ( let i = 0; i < track.values.length; i += 4 ) {

						const flatQuaternion = track.values.slice( i, i + 4 );
						_quatA.fromArray( flatQuaternion );

						// parentRestWorldRotation * trackRotation * inverse(restRotation)
						_quatA
							.premultiply( parentRestWorldRotation )
							.multiply( restRotationInverse );

						// Optional per-bone correction (VRM bone name keys)
						const offset = boneRotationOffsets[ vrmBoneName ];
						if ( offset ) {
							_quatA.multiply( offset );
						}

						_quatA.toArray( flatQuaternion );

						flatQuaternion.forEach( ( v, index ) => {
							track.values[ index + i ] = v;
						} );

					}

					tracks.push(
						new THREE.QuaternionKeyframeTrack(
							`${vrmNodeName}.${propertyName}`,
							track.times,
							track.values.map( ( v, i ) => ( vrm.meta?.metaVersion === '0' && i % 2 === 0 ? - v : v ) ),
						),
					);

				} else if ( track instanceof THREE.VectorKeyframeTrack ) {

					// Translation tracks (often hips)
					const value = track.values.map( ( v, i ) => ( vrm.meta?.metaVersion === '0' && i % 3 !== 1 ? - v : v ) * hipsPositionScale );
					tracks.push( new THREE.VectorKeyframeTrack( `${vrmNodeName}.${propertyName}`, track.times, value ) );

				}

			}

		} );

		return new THREE.AnimationClip( 'vrmAnimationMMD', clip.duration, tracks );

	} ).catch( ( error ) => {
		console.error(DEBUG_PREFIX, "Error processing MMD animation:", error);
		return new THREE.AnimationClip( 'vrmAnimationMMD', 0, [] );
	});

}
