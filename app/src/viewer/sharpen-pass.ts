import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";

/**
 * Contrast-adaptive sharpening, for the reason the shelf needs it at all: the
 * canvas is deliberately rendered smaller than its CSS size and magnified, and
 * magnification is a low-pass operation. Sharpening the magnified result back
 * toward the original local contrast is what makes a reduced render scale look
 * close to native, and it is the same job the vendor upscalers do.
 *
 * This is a fresh implementation of the published contrast-adaptive sharpening
 * method (per-channel contrast estimate -> adaptive weight -> 5-tap cross),
 * not a copy of AMD's FidelityFX source. It is deliberately spatial: no motion
 * vectors, no history buffer, no depth, so it drops into the existing WebGL2
 * chain as one extra full-screen pass.
 *
 * Runs last, after OutputPass, because the method is defined on gamma-encoded
 * display values rather than linear light.
 */
export class SharpenPass extends Pass {
  readonly uniforms: {
    tDiffuse: { value: THREE.Texture | null };
    texelSize: { value: THREE.Vector2 };
    amount: { value: number };
  };
  private readonly material: THREE.ShaderMaterial;
  private readonly fsQuad: FullScreenQuad;

  constructor() {
    super();
    this.uniforms = {
      tDiffuse: { value: null },
      // One source texel, so the tap offsets survive any render scale.
      texelSize: { value: new THREE.Vector2(1, 1) },
      amount: { value: 0.5 },
    };
    this.material = new THREE.ShaderMaterial({
      name: "ContrastAdaptiveSharpen",
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform vec2 texelSize;
        uniform float amount;
        varying vec2 vUv;

        void main() {
          vec3 c = texture2D( tDiffuse, vUv ).rgb;
          vec3 n = texture2D( tDiffuse, vUv + vec2( 0.0, -texelSize.y ) ).rgb;
          vec3 s = texture2D( tDiffuse, vUv + vec2( 0.0, texelSize.y ) ).rgb;
          vec3 w = texture2D( tDiffuse, vUv + vec2( -texelSize.x, 0.0 ) ).rgb;
          vec3 e = texture2D( tDiffuse, vUv + vec2( texelSize.x, 0.0 ) ).rgb;

          // Local neighbourhood bounds of the 5-tap cross.
          vec3 lo = min( min( n, s ), min( min( w, e ), c ) );
          vec3 hi = max( max( n, s ), max( max( w, e ), c ) );

          // How much contrast this pixel can still take before the neighbourhood
          // would clip. Flat areas report ~1 and get sharpened; pixels already
          // near black or white report ~0 and are left alone. This is what keeps
          // the glass rims and the printed artwork free of halos.
          vec3 amp = sqrt( clamp( min( lo, 1.0 - hi ) / max( hi, vec3( 1e-5 ) ), 0.0, 1.0 ) );
          vec3 weight = -amp * ( 1.0 / ( 8.0 - 3.0 * amp ) ) * amount;

          vec3 sharpened = ( n + s + w + e ) * weight + c;
          sharpened /= ( 1.0 + 4.0 * weight );

          // The adaptive weight should already prevent overshoot; the clamp makes
          // it a guarantee rather than a hope.
          gl_FragColor = vec4( clamp( sharpened, lo, hi ), 1.0 );
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  /** 0 disables the effect; 1 is the method's full strength. */
  get amount() {
    return this.uniforms.amount.value;
  }
  set amount(value: number) {
    this.uniforms.amount.value = Math.min(1, Math.max(0, value));
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
      this.fsQuad.render(renderer);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
      this.fsQuad.render(renderer);
    }
  }

  setSize(width: number, height: number) {
    this.uniforms.texelSize.value.set(
      1 / Math.max(1, width),
      1 / Math.max(1, height),
    );
  }

  dispose() {
    this.material.dispose();
    this.fsQuad.dispose();
  }
}
