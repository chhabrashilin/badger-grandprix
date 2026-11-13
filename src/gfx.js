// Rendering pipeline: HDR + ACES tone mapping, sun shadows, bloom, a procedural
// sky that is rendered once into a cached cubemap, sky-based reflections, and
// automatic resolution / quality scaling to hold the frame rate.
import * as THREE from 'three';
import { EffectComposer } from '../vendor/addons/postprocessing/EffectComposer.js';
import { Pass } from '../vendor/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from '../vendor/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/addons/postprocessing/OutputPass.js';

/**
 * ratio: max device-pixel ratio. env: sky reflections on shiny surfaces.
 * Low and Medium draw straight to the screen; only High pays for the HDR bloom chain.
 */
export const QUALITY = {
  low: { ratio: 1, shadows: 0, bloom: false, msaa: 0, env: true },
  medium: { ratio: 1.25, shadows: 1024, bloom: false, msaa: 0, env: true },
  high: { ratio: 1.5, shadows: 2048, bloom: true, msaa: 4, env: true },
};
const TIERS = ['low', 'medium', 'high'];
const MIN_SCALE = 0.6;

const SUN_DIR = new THREE.Vector3(-0.52, 0.72, 0.46).normalize();
const HAZE = 0xcfe4f6;

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = viewMatrix * vec4(position, 0.0); // rotation only
    gl_Position = projectionMatrix * vec4(p.xyz, 1.0);
    gl_Position.z = gl_Position.w;
  }`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 sunDir, zenith, horizon, haze;
  uniform float disc;
  varying vec3 vDir;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 7.1; a *= 0.5; }
    return s;
  }
  void main() {
    vec3 d = normalize(vDir);
    vec3 col = mix(horizon, zenith, pow(max(d.y, 0.0), 0.55));
    col = mix(haze, col, smoothstep(0.0, 0.22, d.y));
    float s = max(dot(d, sunDir), 0.0);
    col += vec3(1.0, 0.86, 0.62) * pow(s, 10.0) * 0.22;
    if (d.y > 0.015) {
      // Puffy cumulus: a broad coverage mask carved by finer detail
      vec2 uv = d.xz / (d.y + 0.16) * 2.4;
      float cover = fbm(uv * 0.45);
      float detail = fbm(uv * 1.9 + 3.0);
      float c = smoothstep(0.50, 0.60, cover * 0.72 + detail * 0.34);
      float thick = smoothstep(0.50, 0.78, cover * 0.72 + detail * 0.34);
      float towardSun = fbm(uv * 1.9 + 3.0 + sunDir.xz * 0.5);
      vec3 cloud = mix(vec3(0.99, 0.98, 0.96), vec3(0.66, 0.73, 0.86), thick * 0.75 + (detail - towardSun) * 1.2);
      col = mix(col, cloud, c * smoothstep(0.015, 0.16, d.y));
    }
    col += vec3(1.0, 0.93, 0.78) * pow(s, 900.0) * 9.0 * disc;
    if (d.y < 0.0) col = mix(haze, vec3(0.30, 0.40, 0.22), smoothstep(0.0, -0.35, d.y));
    gl_FragColor = vec4(col, 1.0);
  }`;

/**
 * The sky shader is expensive per pixel, so it is rendered exactly once into a
 * cubemap. Every frame after that the sky is a single texture lookup.
 */
function bakeSky(renderer, size, disc) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      sunDir: { value: SUN_DIR },
      zenith: { value: new THREE.Color(0x1763d6) },
      horizon: { value: new THREE.Color(0x8fc6f5) },
      haze: { value: new THREE.Color(HAZE) },
      disc: { value: disc },
    },
  });
  const scene = new THREE.Scene();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
  sky.frustumCulled = false;
  scene.add(sky);
  const target = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter });
  new THREE.CubeCamera(0.1, 10, target).update(renderer, scene);
  sky.geometry.dispose();
  mat.dispose();
  return target;
}

/** Renders every split-screen view into the composer's buffer. */
class MultiViewPass extends Pass {
  constructor(gfx) {
    super();
    this.gfx = gfx;
    this.views = [];
    this.needsSwap = false;
  }

  render(renderer, writeBuffer, readBuffer) {
    const pr = readBuffer.width / this.gfx.W;
    const H = readBuffer.height;
    readBuffer.scissorTest = false;
    readBuffer.viewport.set(0, 0, readBuffer.width, H);
    renderer.setRenderTarget(readBuffer);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    for (const v of this.views) {
      const [x, y, w, h] = v.rect;
      const r = [Math.round(x * pr), Math.round(H - (y + h) * pr), Math.round(w * pr), Math.round(h * pr)];
      readBuffer.viewport.set(...r);
      readBuffer.scissor.set(...r);
      readBuffer.scissorTest = true;
      this.gfx.aimSun(v.focus, v.range);
      renderer.setRenderTarget(readBuffer);
      renderer.render(this.gfx.scene, v.camera);
    }
    readBuffer.scissorTest = false;
    readBuffer.viewport.set(0, 0, readBuffer.width, H);
  }
}

/** Integrated / mobile GPUs start one tier lower. */
function looksIntegrated(gl) {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
    return /Intel|UHD|Iris|Mali|Adreno|PowerVR|Apple GPU|SwiftShader|llvmpipe/i.test(name);
  } catch {
    return true;
  }
}

export function createGfx(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false; // counted per frame by the caller

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(HAZE, 280, 2000);
  scene.background = bakeSky(renderer, 1024, 1).texture;

  // Image-based lighting from a small sky capture without the sun disc (avoids fireflies).
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envCube = bakeSky(renderer, 128, 0);
  const envTexture = pmrem.fromCubemap(envCube.texture).texture;
  envCube.dispose();
  pmrem.dispose();

  const sun = new THREE.DirectionalLight(0xfff0d8, 2.7);
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.4;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xcfe2ff, 0xb9c39a, 2.5); // sky/ground ambient for the diffuse materials
  scene.add(hemi);

  const gfx = {
    renderer, scene, sun, W: 1, H: 1,
    quality: QUALITY.medium, qualityName: 'medium', auto: true, scale: 1, views: 1,
    composer: null, pass: null, bloom: null, integrated: looksIntegrated(renderer.getContext()),
    bad: 0, good: 0, raises: 2, overrides: {},
    get shadowsOn() {
      return this.quality.shadows > 0;
    },

    /** Centre the sun's shadow frustum on a point of interest. */
    aimSun(focus, range = 60) {
      sun.target.position.set(focus.x, 0, focus.z);
      sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 260);
      sun.target.updateMatrixWorld();
      const c = sun.shadow.camera;
      if (c.right !== range) {
        c.left = c.bottom = -range;
        c.right = c.top = range;
        c.near = 20;
        c.far = 560;
        c.updateProjectionMatrix();
      }
    },

    /** 'auto' picks a tier for this GPU and keeps adjusting; a named tier is held. */
    setQuality(name) {
      this.auto = name === 'auto';
      // Integrated graphics start on the lightest tier at reduced resolution; the scaler takes it from there.
      if (this.auto && this.integrated && this.scale === 1) this.scale = 0.8;
      this.applyTier(this.auto ? (this.integrated ? 'low' : 'high') : name);
      this.raises = 2;
    },

    applyTier(name) {
      const q = { ...(QUALITY[name] ?? QUALITY.medium), ...this.overrides };
      this.quality = q;
      this.qualityName = name;
      renderer.shadowMap.enabled = q.shadows > 0;
      sun.castShadow = q.shadows > 0;
      scene.environment = q.env ? envTexture : null;
      this.sizeShadows();
      scene.traverse((o) => {
        if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true;
      });
      this.bad = this.good = 0;
      this.resize(this.W, this.H);
    },

    /** Each split-screen view renders its own shadow map, so shrink it as views are added. */
    sizeShadows() {
      const q = this.quality;
      if (!q.shadows) return;
      const size = this.views > 2 ? Math.min(q.shadows, 1024) : q.shadows;
      if (sun.shadow.mapSize.x !== size) {
        sun.shadow.mapSize.set(size, size);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
    },

    resize(W, H) {
      this.W = W;
      this.H = H;
      const q = this.quality;
      const pr = Math.min(devicePixelRatio, q.ratio) * this.scale;
      renderer.setPixelRatio(pr);
      renderer.setSize(W, H, false);
      this.composer?.renderTarget1.dispose();
      this.composer?.renderTarget2.dispose();
      this.bloom?.dispose();
      this.composer = null;
      if (q.bloom) {
        const target = new THREE.WebGLRenderTarget(W * pr, H * pr, { type: THREE.HalfFloatType, samples: q.msaa });
        this.composer = new EffectComposer(renderer, target);
        this.composer.setPixelRatio(pr);
        this.composer.setSize(W, H);
        this.pass = new MultiViewPass(this);
        this.bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.26, 0.6, 1.1);
        this.composer.addPass(this.pass);
        this.composer.addPass(this.bloom);
        this.composer.addPass(new OutputPass());
        this.bloom.setSize((W * pr) / 2, (H * pr) / 2); // bloom is blurry anyway: run it at half resolution
      }
    },

    /**
     * Feed in the average frame time (ms) of the last window. Lowers render
     * resolution when frames are slow, then drops a quality tier if that is
     * not enough; creeps resolution back up (a limited number of times) when
     * there is headroom.
     */
    adapt(avgMs, worstMs = avgMs, canChangeTier = true) {
      // On a 60 Hz display the best possible average is 16.7 ms; above ~18 ms frames are being dropped.
      if (avgMs > 19) {
        this.good = 0;
        if (++this.bad < 2) return;
        this.bad = 0;
        // If the last cut in resolution bought nothing, pixels are not the bottleneck: undo it and stop cutting.
        if (this.before && avgMs > this.before - 1) {
          this.scale = this.beforeScale;
          this.floor = this.beforeScale;
          this.before = 0;
          this.resize(this.W, this.H);
          return;
        }
        if (this.scale > Math.max(MIN_SCALE, this.floor ?? 0) + 0.01) {
          this.before = avgMs;
          this.beforeScale = this.scale;
          this.scale = Math.max(MIN_SCALE, this.scale - (avgMs > 26 ? 0.2 : 0.1));
          this.resize(this.W, this.H);
        } else if (this.auto && canChangeTier && this.qualityName !== 'low') {
          // Recompiles every shader, so only done between races.
          this.scale = 0.8;
          this.applyTier(TIERS[TIERS.indexOf(this.qualityName) - 1]);
        }
      } else if (avgMs < 17.2 && worstMs < 26) {
        this.bad = 0;
        this.before = 0;
        if (++this.good >= 8 && this.scale < 1 && this.raises > 0) {
          this.good = 0;
          this.raises--;
          this.scale = Math.min(1, this.scale + 0.1);
          this.resize(this.W, this.H);
        }
      } else {
        this.bad = this.good = 0;
      }
    },

    /**
     * Draw one real frame so every shader (scene, shadows, post-processing) is
     * compiled and every texture uploaded before play starts. Blocking by design:
     * call it behind a loading screen.
     */
    warmUp(views) {
      this.render(views);
      renderer.getContext().finish();
    },

    /** @param views [{ rect: [x, y, w, h] in CSS px (top-left origin), camera, focus: {x, z}, range? }] */
    render(views) {
      if (views.length !== this.views) {
        this.views = views.length;
        this.sizeShadows();
      }
      if (this.composer) {
        this.pass.views = views;
        this.composer.render();
        return;
      }
      renderer.setRenderTarget(null);
      renderer.setScissorTest(true);
      for (const v of views) {
        const [x, y, w, h] = v.rect;
        renderer.setViewport(x, this.H - y - h, w, h);
        renderer.setScissor(x, this.H - y - h, w, h);
        this.aimSun(v.focus, v.range);
        renderer.render(scene, v.camera);
      }
    },
  };
  return gfx;
}
