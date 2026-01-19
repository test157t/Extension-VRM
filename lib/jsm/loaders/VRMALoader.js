import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '../../three-vrm-animation.module.js';
import { GLTFLoader } from './GLTFLoader.js';

/**
 * VRMALoader: Loads .vrma animation files and outputs { skeleton, clip } like BVHLoader
 * @param {string} url - The URL of the .vrma file
 * @param {Object} vrm - The target VRM model (for skeleton reference)
 * @returns {Promise<{ skeleton: Skeleton, clip: AnimationClip }>} Unified output
 */
export class VRMALoader {
  constructor(manager) {
    this.manager = manager;
  }

  async loadAsync(url, vrm) {
    const gltfLoader = new GLTFLoader(this.manager);
    // register the plugin so the GLTF parser will populate userData.vrmAnimations
    gltfLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));

    const loadPromise = new Promise((resolve, reject) => {
      gltfLoader.load(
        url,
        (gltf) => resolve(gltf),
        undefined,
        (err) => reject(err)
      );
    });

    const gltf = await loadPromise;
    const vrmAnimations = (gltf.userData && gltf.userData.vrmAnimations) || [];
    const vrmAnimation = vrmAnimations.length > 0 ? vrmAnimations[0] : null;

    let clip = null;
    if (vrmAnimation && vrm) {
      clip = createVRMAnimationClip(vrmAnimation, vrm);
    }

    const skeleton = vrm && vrm.scene ? vrm.scene.skeleton : null;
    return {
      skeleton: skeleton || null,
      clip: clip
    };
  }
}
