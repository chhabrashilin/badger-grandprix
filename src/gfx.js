// Rendering pipeline: single HD path with ACES tone mapping, cached sky cubemap,
// soft sun shadows (updated on a budget), bloom, and silent resolution scaling
// that never drops the quality tier.
import * as THREE from 'three';
import { EffectComposer } from '../vendor/addons/postprocessing/EffectComposer.js';
import { Pass } from '../vendor/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from '../vendor/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/addons/postprocessing/OutputPass.js';

/**
 * One locked HD preset. Resolution still scales under load, but shadows / bloom /
 * MSAA / env stay on so the game always looks like the High build.
 */
export const QUALITY = {
  high: { ratio: 1.75, shadows: 2048, bloom: true, msaa: 2, env: true },
};
const MIN_SCALE = 0.72;

const SUN_DIR = new THREE.Vector3(-0.48, 0.78, 0.4).normalize();
const HAZE = 0xb9d4ea;

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = viewMatrix * vec4(position, 0.0);
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
    vec3 col = mix(horizon, zenith, pow(max(d.y, 0.0), 0.62));
    col = mix(haze, col, smoothstep(0.0, 0.18, d.y));
    float s = max(dot(d, sunDir), 0.0);
    col += vec3(1.0, 0.88, 0.68) * pow(s, 8.0) * 0.28;
    if (d.y > 0.012) {
      vec2 uv = d.xz / (d.y + 0.14) * 2.2;
      float cover = fbm(uv * 0.42);
      float detail = fbm(uv * 1.85 + 3.0);
      float c = smoothstep(0.48, 0.58, cover * 0.72 + detail * 0.34);
      float thick = smoothstep(0.48, 0.76, cover * 0.72 + detail * 0.34);
      float towardSun = fbm(uv * 1.85 + 3.0 + sunDir.xz * 0.5);
      vec3 cloud = mix(vec3(1.0, 0.99, 0.97), vec3(0.62, 0.70, 0.84), thick * 0.72 + (detail - towardSun) * 1.15);
      col = mix(col, cloud, c * smoothstep(0.012, 0.14, d.y));
    }
    col += vec3(1.0, 0.94, 0.8) * pow(s, 700.0) * 10.0 * disc;
    if (d.y < 0.0) col = mix(haze, vec3(0.28, 0.38, 0.2), smoothstep(0.0, -0.35, d.y));
    gl_FragColor = vec4(col, 1.0);
  }`;

/** Bake the expensive sky shader once into a cubemap. */
function bakeSky(renderer, size, disc) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      sunDir: { value: SUN_DIR },
      zenith: { value: new THREE.Color(0x1a6fe0) },
      horizon: { value: new THREE.Color(0x9ecff5) },
      haze: { value: new THREE.Color(HAZE) },
      disc: { value: disc },
    },
  });
  const scene = new THREE.Scene();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
  sky.frustumCulled = false;
  scene.add(sky);
  const target = new THREE.WebGLCubeRenderTarget(size, {
    type: THREE.HalfFloatType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
  });
  new THREE.CubeCamera(0.1, 10, target).update(renderer, scene);
  sky.geometry.dispose();
  mat.dispose();
  return target;
}

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
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    stencil: false,
    depth: true,
  });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.info.autoReset = false;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(HAZE, 420, 2600);
  const skyCube = bakeSky(renderer, 1024, 1);
  scene.background = skyCube.texture;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envCube = bakeSky(renderer, 256, 0);
  const envTexture = pmrem.fromCubemap(envCube.texture).texture;
  envCube.dispose();
  pmrem.dispose();

  const sun = new THREE.DirectionalLight(0xfff2dc, 3.15);
  sun.shadow.bias = -0.00035;
  sun.shadow.normalBias = 0.28;
  sun.shadow.radius = 2.2;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xd4e8ff, 0xa8b888, 1.85);
  scene.add(hemi);
  // Soft fill so shadowed asphalt still reads like daylight photography.
  const fill = new THREE.DirectionalLight(0xb8d0f0, 0.35);
  fill.position.set(SUN_DIR.x * -80, 40, SUN_DIR.z * -80);
  scene.add(fill);

  const gfx = {
    renderer, scene, sun, W: 1, H: 1, maxAniso,
    quality: QUALITY.high, qualityName: 'high', auto: true, scale: 1, views: 1,
    composer: null, pass: null, bloom: null, integrated: looksIntegrated(renderer.getContext()),
    bad: 0, good: 0, raises: 4, overrides: {},
    _frame: 0, _shadowFocus: new THREE.Vector3(1e9, 0, 0),
    get shadowsOn() {
      return this.quality.shadows > 0;
    },

    /** Tag textures for sharp glancing-angle road detail. */
    sharpen(tex) {
      if (!tex) return tex;
      tex.anisotropy = Math.min(8, maxAniso);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      return tex;
    },

    aimSun(focus, range = 60) {
      const moved = this._shadowFocus.distanceToSquared(focus) > 4;
      sun.target.position.set(focus.x, 0, focus.z);
      sun.position.copy(sun.target.position).addScaledVector(SUN_DIR, 280);
      sun.target.updateMatrixWorld();
      const c = sun.shadow.camera;
      if (c.right !== range) {
        c.left = c.bottom = -range;
        c.right = c.top = range;
        c.near = 18;
        c.far = 600;
        c.updateProjectionMatrix();
        renderer.shadowMap.needsUpdate = true;
      } else if (moved) {
        this._shadowFocus.copy(focus);
        renderer.shadowMap.needsUpdate = true;
      }
    },

    /** Always HD. `auto` only enables silent resolution scaling. */
    setQuality(name) {
      this.auto = name === 'auto' || name === 'high' || !name;
      if (this.auto && this.integrated && this.scale === 1) this.scale = 0.88;
      this.applyTier('high');
      this.raises = 4;
    },

    applyTier() {
      const q = { ...QUALITY.high, ...this.overrides };
      this.quality = q;
      this.qualityName = 'high';
      renderer.shadowMap.enabled = q.shadows > 0;
      sun.castShadow = q.shadows > 0;
      scene.environment = q.env ? envTexture : null;
      this.sizeShadows();
      this.bad = this.good = 0;
      this.resize(this.W, this.H);
    },

    sizeShadows() {
      const q = this.quality;
      if (!q.shadows) return;
      // Split-screen shares one sun: shrink the map so four views stay fluid.
      const size = this.views > 2 ? Math.min(q.shadows, 1024) : this.views > 1 ? Math.min(q.shadows, 1536) : q.shadows;
      if (sun.shadow.mapSize.x !== size) {
        sun.shadow.mapSize.set(size, size);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
        renderer.shadowMap.needsUpdate = true;
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
        const target = new THREE.WebGLRenderTarget(Math.max(1, W * pr), Math.max(1, H * pr), {
          type: THREE.HalfFloatType,
          samples: q.msaa,
        });
        this.composer = new EffectComposer(renderer, target);
        this.composer.setPixelRatio(pr);
        this.composer.setSize(W, H);
        this.pass = new MultiViewPass(this);
        this.bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.22, 0.55, 1.05);
        this.composer.addPass(this.pass);
        this.composer.addPass(this.bloom);
        this.composer.addPass(new OutputPass());
        this.bloom.setSize((W * pr) / 2, (H * pr) / 2);
      }
      renderer.shadowMap.needsUpdate = true;
    },

    /**
     * Silent resolution scaler. Never demotes the HD tier — only the internal
     * render scale moves, so the game always keeps shadows + bloom + MSAA.
     */
    adapt(avgMs, worstMs = avgMs) {
      if (avgMs > 19) {
        this.good = 0;
        if (++this.bad < 2) return;
        this.bad = 0;
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
          this.scale = Math.max(MIN_SCALE, this.scale - (avgMs > 26 ? 0.12 : 0.08));
          this.resize(this.W, this.H);
        }
      } else if (avgMs < 16.8 && worstMs < 24) {
        this.bad = 0;
        this.before = 0;
        if (++this.good >= 6 && this.scale < 1 && this.raises > 0) {
          this.good = 0;
          this.raises--;
          this.scale = Math.min(1, this.scale + 0.08);
          this.resize(this.W, this.H);
        }
      } else {
        this.bad = this.good = 0;
      }
    },

    warmUp(views) {
      renderer.shadowMap.needsUpdate = true;
      this.render(views);
      renderer.getContext().finish();
    },

    /** @param views [{ rect, camera, focus, range? }] */
    render(views) {
      if (views.length !== this.views) {
        this.views = views.length;
        this.sizeShadows();
      }
      this._frame++;
      // Refresh the shadow map every other frame (every frame for the first few
      // after a resize / warm-up). Cuts the shadow pass roughly in half.
      if (this._frame <= 3 || (this._frame & 1) === 0) {
        renderer.shadowMap.needsUpdate = true;
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
