import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { BokehShader } from "three/addons/shaders/BokehShader.js";

export type DepthOfFieldParameters = {
  focus?: number;
  aperture?: number;
  maxblur?: number;
};

/**
 * Depth of field that does not draw the shelf a second time.
 *
 * Three's `BokehPass` renders the whole scene into a depth target with a
 * `MeshDepthMaterial` before it blurs, and that pass is pure overhead here: the
 * ambient-occlusion pass already renders the same scene into a target that
 * carries a depth texture. When that buffer is available this pass samples it
 * instead, so the frame never submits the archive geometry twice for blurring.
 *
 * The bokeh math itself is three's `BokehShader`, unchanged, so the rendered
 * result matches the previous pass whenever it is fed the same depth.
 */
export class DepthOfFieldPass extends Pass {
  readonly uniforms: Record<string, THREE.IUniform>;
  /**
   * Depth buffer produced by another pass during this frame, in the same view
   * space and with the same near/far as this camera. `null` renders our own.
   */
  depthSource: THREE.Texture | null = null;

  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly material: THREE.ShaderMaterial;
  private readonly fsQuad: FullScreenQuad;
  private readonly depthMaterial = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    blending: THREE.NoBlending,
  });
  private readonly depthTarget: THREE.WebGLRenderTarget;
  private readonly previousClearColor = new THREE.Color();

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    parameters: DepthOfFieldParameters = {},
  ) {
    super();
    this.scene = scene;
    this.camera = camera;
    // Only used when no other pass can supply depth; kept at 1x1 until then.
    this.depthTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.HalfFloatType,
    });
    const uniforms = THREE.UniformsUtils.clone(BokehShader.uniforms);
    uniforms.tDepth.value = this.depthTarget.texture;
    uniforms.focus.value = parameters.focus ?? 1;
    uniforms.aperture.value = parameters.aperture ?? 0.025;
    uniforms.maxblur.value = parameters.maxblur ?? 1;
    uniforms.aspect.value = camera.aspect;
    this.uniforms = uniforms as Record<string, THREE.IUniform>;
    this.material = new THREE.ShaderMaterial({
      name: "SharedDepthBokeh",
      defines: { ...BokehShader.defines },
      uniforms,
      vertexShader: BokehShader.vertexShader,
      fragmentShader: BokehShader.fragmentShader,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  /** True when this frame reused another pass's depth instead of rendering it. */
  get sharingDepth() {
    return this.depthSource !== null;
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ) {
    const depth = this.depthSource ?? this.renderDepth(renderer);
    this.uniforms.tColor.value = readBuffer.texture;
    this.uniforms.tDepth.value = depth;
    this.uniforms.nearClip.value = this.camera.near;
    this.uniforms.farClip.value = this.camera.far;
    // The camera aspect follows window resizes, so read it every frame rather
    // than freezing the value captured at construction time.
    this.uniforms.aspect.value = this.camera.aspect;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
      this.fsQuad.render(renderer);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
      this.fsQuad.render(renderer);
    }
  }

  /** Three's own depth prepass, used only when no shared depth is available. */
  private renderDepth(renderer: THREE.WebGLRenderer) {
    renderer.getClearColor(this.previousClearColor);
    const previousClearAlpha = renderer.getClearAlpha();
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(0xffffff, 1);
    this.scene.overrideMaterial = this.depthMaterial;
    renderer.setRenderTarget(this.depthTarget);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    this.scene.overrideMaterial = null;
    renderer.setClearColor(this.previousClearColor, previousClearAlpha);
    renderer.autoClear = previousAutoClear;
    return this.depthTarget.texture;
  }

  setSize(width: number, height: number) {
    this.depthTarget.setSize(width, height);
  }

  dispose() {
    this.depthTarget.dispose();
    this.depthMaterial.dispose();
    this.material.dispose();
    this.fsQuad.dispose();
  }
}
