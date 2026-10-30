import * as THREE from 'three';
import { GPUComputationRenderer, type Variable } from 'three/examples/jsm/misc/GPUComputationRenderer.js';
import { colorShader, pointsFragment, pointsVertex, positionShader, velocityShader } from './shaders';
import { pointCount, type PointShape } from './types';

/** Live-tweakable parameters. Mutate `field.params` directly. */
export interface ParticleParams {
  /** Point diameter in world units (shapes are ~2 units wide). */
  pointSize: number;
  opacity: number;
  /** Two sRGB colours blended across shapes that don't carry their own colours. */
  palette: [string, string];
  /** Ignore shape colours and always use the palette. */
  forcePalette: boolean;
  /**
   * Particles used per unit of on-screen area. Shapes drawn smaller than the view (`scale` < 1)
   * use proportionally fewer particles; the spare ones are hidden.
   */
  density: number;

  /** Pointer influence radius (world units). */
  radius: number;
  /** Tangential force around the pointer (the swirl). */
  swirl: number;
  /** How much of the swirl is applied while the pointer is resting (0–1); the rest comes from movement. */
  idleSwirl: number;
  /** Outward push away from the pointer. */
  push: number;
  /** How strongly particles get dragged along with pointer motion. */
  drag: number;
  /** Strength of the shockwave on click / tap. */
  tapBurst: number;

  /** Pull back to the shape. */
  spring: number;
  /** Velocity damping per second. */
  damping: number;
  /** Ambient drift. */
  noise: number;
  noiseScale: number;
  /** How fast the drift field evolves. */
  noiseSpeed: number;
  /** Seconds for the pull towards a new shape to ramp from zero to full strength. */
  morphDuration: number;
  /** Seconds for the very first shape to fade in and settle. */
  introDuration: number;
  /** How far from their spot particles start on the first shape (world units; the view is ~1.5 tall). */
  introScatter: number;
  /** Brightness/size boost for fast particles. */
  speedGlow: number;
  /** 0–1: how much 3D shapes fade out towards their back (flat shapes are unaffected). */
  depthFade: number;
  /** Where the fade begins/ends, in shape radii from the centre (-1 = front, 1 = back). */
  depthFadeStart: number;
  depthFadeEnd: number;

  /** Radians/second auto-rotation for 3D shapes. */
  autoRotate: number;
  /** Max tilt (radians) following the pointer. */
  parallax: number;
  /** Extra space around the shape when fitting it to the view (1 = edge to edge). */
  framePadding: number;
}

export interface ParticleFieldOptions {
  /** Particle count; rounded up to a square texture (e.g. 65536 = 256²). Fixed for the field's lifetime. */
  count?: number;
  /** Cap on devicePixelRatio. */
  maxPixelRatio?: number;
  /**
   * Element whose box frames the shape and bounds pointer interaction. Defaults to the container.
   * Use a smaller element than the container to let particles spill past it, e.g. a full-window
   * canvas framed by a layout box.
   */
  viewport?: HTMLElement;
  /**
   * When the viewport moves or resizes, glide the framing to it at this rate (per second)
   * instead of jumping. 0 = jump. Only applies when `viewport` differs from the container.
   */
  viewEase?: number;
  /** Where pointer events are read from. Defaults to the container. */
  eventTarget?: HTMLElement | Window;
  /** Parallax follows the pointer anywhere on the page (true) or only over the canvas (false). Default true. */
  pageParallax?: boolean;
  /** CSS touch-action on the container. "pan-y" keeps page scrolling working on phones. */
  touchAction?: string;
  blending?: 'additive' | 'normal';
  /** CSS colour, or null for a transparent canvas. */
  background?: string | null;
  params?: Partial<ParticleParams>;
}

export const defaultParams: ParticleParams = {
  pointSize: 0.0045,
  opacity: 1,
  palette: ['#7cc4ff', '#ff7ad9'],
  forcePalette: false,
  density: 1,
  radius: 0.12,
  swirl: 26,
  idleSwirl: 0.58,
  push: 20,
  drag: 5.1,
  tapBurst: 68,
  spring: 40,
  damping: 12,
  noise: 0.62,
  noiseScale: 25,
  noiseSpeed: 1,
  morphDuration: 1.5,
  introDuration: 4.5,
  introScatter: 0.06,
  speedGlow: 0.8,
  depthFade: 1,
  depthFadeStart: -0.18,
  depthFadeEnd: 0.21,
  autoRotate: 0,
  parallax: 0.4,
  framePadding: 1.15,
};

/** Fixed camera distance; at fov 35 the view is ~1.5 units tall at the origin (pointSize/radius are tuned to this). */
const CAMERA_Z = 2.4;

type EventMap = WindowEventMap & DocumentEventMap;

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export class ParticleField {
  readonly params: ParticleParams;
  readonly canvas: HTMLCanvasElement;
  readonly count: number;
  readonly viewport: HTMLElement;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  private tilt = new THREE.Group(); // pointer parallax
  private spin = new THREE.Group(); // auto-rotation; particles live in this space
  private points: THREE.Points;
  private material: THREE.ShaderMaterial;

  private gpu: GPUComputationRenderer;
  private posVar: Variable;
  private velVar: Variable;
  private colVar: Variable;
  /** Colours at the start of the current transition. */
  private prevColor: THREE.WebGLRenderTarget;
  private targetTex: THREE.DataTexture;
  private targetColorTex: THREE.DataTexture;
  private size: number;

  private shape: PointShape | null = null;
  private fitCenter = new THREE.Vector3();
  private fitScale = 1;
  private fitRadius = 1;
  private depthFade = 0;
  /** Viewport box relative to the canvas in CSS px: where the camera frames now, and where it's heading. */
  private view = { x: 0, y: 0, w: 1, h: 1 };
  private viewTarget = { x: 0, y: 0, w: 1, h: 1 };
  private viewEase: number;
  private viewPlaced = false;
  private canvasSize = { w: 1, h: 1 };

  // Pointer state
  private ndc = new THREE.Vector2();
  private pointerInside = false;
  /** Pointer relative to the canvas centre, ±1 at the window edges (for parallax). */
  private pageNdc = new THREE.Vector2();
  private pointerOnPage = false;
  private presence = 0;
  private stir = 0;
  private burst = 0;
  private morph = 1;
  private morphSeconds = 1;
  /** 0→1 over the intro; drives the global fade-in (nothing shows before the first shape). */
  private intro = 0;
  private lastPlanePoint: THREE.Vector3 | null = null;
  private pointerVel = new THREE.Vector3();
  private raycaster = new THREE.Raycaster();

  private timer = new THREE.Timer();
  private running = false;
  private visible = true;
  private frame = 0;
  private cleanup: (() => void)[] = [];

  constructor(
    readonly container: HTMLElement,
    opts: ParticleFieldOptions = {},
  ) {
    this.params = { ...defaultParams, ...opts.params };
    this.viewport = opts.viewport ?? container;
    this.viewEase = this.viewport === container ? 0 : (opts.viewEase ?? 0);
    const { count = 65536, maxPixelRatio = 2, blending = 'additive', background = null } = opts;
    this.size = Math.ceil(Math.sqrt(count));
    this.count = this.size * this.size;

    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: background === null, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
    if (background !== null) this.renderer.setClearColor(background);
    else this.renderer.setClearColor(0x000000, 0);
    this.canvas = this.renderer.domElement;
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%' });
    container.appendChild(this.canvas);
    container.style.touchAction = opts.touchAction ?? 'pan-y';

    this.camera.position.set(0, 0, CAMERA_Z);
    this.scene.add(this.tilt);
    this.tilt.add(this.spin);

    // --- simulation
    this.gpu = new GPUComputationRenderer(this.size, this.size, this.renderer);
    if (!this.renderer.extensions.has('EXT_color_buffer_float')) this.gpu.setDataType(THREE.HalfFloatType);

    const pos0 = this.gpu.createTexture();
    const vel0 = this.gpu.createTexture();
    const col0 = this.gpu.createTexture();
    const pd = pos0.image.data as Float32Array;
    for (let i = 0; i < this.count; i++) {
      // Start as a loose cloud; the first shape assembles out of it.
      const v = new THREE.Vector3().randomDirection().multiplyScalar(1.5 + Math.random() * 2.5);
      pd.set([v.x, v.y, v.z, 1], i * 4);
    }
    (col0.image.data as Float32Array).fill(0);

    this.targetTex = this.makeDataTexture();
    this.targetColorTex = this.makeDataTexture();

    this.posVar = this.gpu.addVariable('texturePosition', positionShader, pos0);
    this.velVar = this.gpu.addVariable('textureVelocity', velocityShader, vel0);
    this.colVar = this.gpu.addVariable('textureColor', colorShader, col0);
    this.gpu.setVariableDependencies(this.posVar, [this.posVar, this.velVar]);
    this.gpu.setVariableDependencies(this.velVar, [this.posVar, this.velVar]);
    this.gpu.setVariableDependencies(this.colVar, [this.colVar]);

    Object.assign(this.velVar.material.uniforms, {
      tTarget: { value: this.targetTex },
      uDt: { value: 0 },
      uRayOrigin: { value: new THREE.Vector3(0, 0, 100) },
      uRayDir: { value: new THREE.Vector3(0, 0, -1) },
      uPresence: { value: 0 },
      uPointerVel: { value: new THREE.Vector3() },
      uRadius: { value: 0 },
      uSwirl: { value: 0 },
      uPush: { value: 0 },
      uDrag: { value: 0 },
      uBurst: { value: 0 },
      uSpring: { value: 0 },
      uDamping: { value: 0 },
      uNoise: { value: 0 },
      uNoiseScale: { value: 0 },
      uNoiseTime: { value: 0 },
      uMorph: { value: 1 },
      uFitCenter: { value: this.fitCenter },
      uFitScale: { value: 1 },
    });
    Object.assign(this.posVar.material.uniforms, {
      tTarget: { value: this.targetTex },
      uDt: { value: 0 },
    });
    Object.assign(this.colVar.material.uniforms, {
      tTargetColor: { value: this.targetColorTex },
      tPrevColor: { value: null },
      uMorph: { value: 1 },
    });

    const err = this.gpu.init();
    if (err) throw new Error(`ParticleField: ${err}`);
    this.prevColor = this.gpu.createRenderTarget(
      this.size,
      this.size,
      THREE.ClampToEdgeWrapping,
      THREE.ClampToEdgeWrapping,
      THREE.NearestFilter,
      THREE.NearestFilter,
    );
    this.colVar.material.uniforms.tPrevColor.value = this.prevColor.texture;

    // --- render
    const geometry = new THREE.BufferGeometry();
    const refs = new Float32Array(this.count * 2);
    for (let i = 0; i < this.count; i++) {
      refs[i * 2] = ((i % this.size) + 0.5) / this.size;
      refs[i * 2 + 1] = (Math.floor(i / this.size) + 0.5) / this.size;
    }
    geometry.setAttribute('reference', new THREE.BufferAttribute(refs, 2));
    // Dummy positions so three knows the vertex count; real positions come from the texture.
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.count * 3), 3));

    this.material = new THREE.ShaderMaterial({
      vertexShader: pointsVertex,
      fragmentShader: pointsFragment,
      uniforms: {
        tPosition: { value: null },
        tVelocity: { value: null },
        tColor: { value: null },
        uSize: { value: 0 },
        uProjScale: { value: 1 },
        uSpeedGlow: { value: 0 },
        uOpacity: { value: 1 },
        uDepthCenter: { value: CAMERA_Z },
        uDepthRadius: { value: 1 },
        uDepthFade: { value: 0 },
        uDepthFadeStart: { value: 0 },
        uDepthFadeEnd: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: blending === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.spin.add(this.points);

    this.bindEvents(opts.eventTarget ?? container, opts.pageParallax ?? true);
    this.resize();
    this.start();
  }

  /** Morph into a new shape. */
  setShape(shape: PointShape): void {
    const first = this.shape === null;
    // Colours blend from what's on screen now (even mid-transition) to the new shape's.
    if (!first) this.gpu.renderTexture(this.gpu.getCurrentRenderTarget(this.colVar).texture, this.prevColor);
    this.shape = shape;
    this.writeTargets();
    this.fitShape();
    this.morph = 0;
    this.morphSeconds = first ? this.params.introDuration : this.params.morphDuration;
    if (first) this.seedIntro();
    if (!shape.is3D) {
      // Ease flat shapes back to facing the camera.
      this.spinTarget = Math.round(this.spin.rotation.y / (Math.PI * 2)) * Math.PI * 2;
    } else this.spinTarget = null;
  }

  /**
   * Start the first shape as a loose haze around where it will be: each particle is
   * offset randomly from its spot, already coloured, and the whole field fades in.
   */
  private seedIntro(): void {
    const pos = this.gpu.createTexture();
    const col = this.gpu.createTexture();
    const pd = pos.image.data as Float32Array;
    const t = this.targetTex.image.data as Float32Array;
    const c = this.fitCenter;
    const s = this.fitScale;
    const r = this.params.introScatter;
    // Roughly gaussian offsets: mostly close, a few strays.
    const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.4;
    for (let i = 0; i < this.count; i++) {
      pd[i * 4] = (t[i * 4] - c.x) * s + gauss() * r;
      pd[i * 4 + 1] = (t[i * 4 + 1] - c.y) * s + gauss() * r;
      pd[i * 4 + 2] = (t[i * 4 + 2] - c.z) * s + gauss() * r;
      pd[i * 4 + 3] = t[i * 4 + 3];
    }
    (col.image.data as Float32Array).set(this.targetColorTex.image.data as Float32Array);
    for (const rt of this.posVar.renderTargets) this.gpu.renderTexture(pos, rt);
    for (const rt of this.colVar.renderTargets) this.gpu.renderTexture(col, rt);
    this.gpu.renderTexture(col, this.prevColor);
    pos.dispose();
    col.dispose();
    this.intro = 0;
  }

  /** Re-measure the viewport and re-fit the shape, e.g. after a layout change or changing `framePadding`. */
  refit(): void {
    this.resize();
  }

  /** Re-apply palette/colour/density params after changing them. */
  refreshColors(): void {
    if (this.shape) this.writeTargets();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer.reset();
    const loop = () => {
      if (!this.running) return;
      this.frame = requestAnimationFrame(loop);
      if (this.visible) this.tick();
    };
    loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  dispose(): void {
    this.stop();
    this.cleanup.forEach((f) => f());
    this.gpu.dispose();
    this.prevColor.dispose();
    this.targetTex.dispose();
    this.targetColorTex.dispose();
    this.points.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }

  // ------------------------------------------------------------------ internals

  private spinTarget: number | null = null;

  private makeDataTexture(): THREE.DataTexture {
    const tex = new THREE.DataTexture(new Float32Array(this.count * 4), this.size, this.size, THREE.RGBAFormat, THREE.FloatType);
    tex.needsUpdate = true;
    return tex;
  }

  private writeTargets(): void {
    const shape = this.shape!;
    const n = pointCount(shape);
    const t = this.targetTex.image.data as Float32Array;
    const c = this.targetColorTex.image.data as Float32Array;
    const useShapeColor = !!shape.colors && !this.params.forcePalette;
    const a = new THREE.Color(this.params.palette[0]);
    const b = new THREE.Color(this.params.palette[1]);
    const ca = a.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
    const cb = b.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
    const { min, max } = shape.bounds;
    const sx = 1 / Math.max(1e-6, max[0] - min[0]);
    const sy = 1 / Math.max(1e-6, max[1] - min[1]);
    const shapeOpacity = shape.opacity ?? 1;
    // Keep on-screen density constant: smaller shapes use fewer particles.
    const scale = shape.scale ?? 1;
    const density = this.params.density * (shape.density ?? 1);
    const active = Math.max(1, Math.min(this.count, Math.round(this.count * density * scale * scale)));
    // Duplicated points (when the shape has fewer points than particles) get a little jitter.
    const jitter = n < active ? 0.006 : 0;

    for (let i = 0; i < this.count; i++) {
      if (i >= active) {
        // Spare particle: park it invisibly on a random shape point so it can fade in in place later.
        const k = Math.floor(Math.random() * Math.min(n, active));
        t.set([shape.positions[k * 3], shape.positions[k * 3 + 1], shape.positions[k * 3 + 2], 1], i * 4);
        c[i * 4 + 3] = 0;
        continue;
      }
      const j = n >= active ? i : i % n;
      const dup = i >= n;
      t[i * 4] = shape.positions[j * 3] + (dup ? (Math.random() - 0.5) * jitter : 0);
      t[i * 4 + 1] = shape.positions[j * 3 + 1] + (dup ? (Math.random() - 0.5) * jitter : 0);
      t[i * 4 + 2] = shape.positions[j * 3 + 2] + (dup ? (Math.random() - 0.5) * jitter : 0);
      t[i * 4 + 3] = shape.sizes ? shape.sizes[j] : 1;
      if (useShapeColor) {
        c.set(shape.colors!.subarray(j * 4, j * 4 + 4), i * 4);
        c[i * 4 + 3] *= shapeOpacity;
      } else {
        // Diagonal gradient across the shape plus per-particle variation.
        const gx = (shape.positions[j * 3] - min[0]) * sx;
        const gy = (shape.positions[j * 3 + 1] - min[1]) * sy;
        const f = THREE.MathUtils.clamp(gx * 0.7 + (1 - gy) * 0.3 + (Math.random() - 0.5) * 0.35, 0, 1);
        const shade = 0.75 + Math.random() * 0.25;
        c[i * 4] = (ca.r + (cb.r - ca.r) * f) * shade;
        c[i * 4 + 1] = (ca.g + (cb.g - ca.g) * f) * shade;
        c[i * 4 + 2] = (ca.b + (cb.b - ca.b) * f) * shade;
        c[i * 4 + 3] = shapeOpacity;
      }
    }
    this.targetTex.needsUpdate = true;
    this.targetColorTex.needsUpdate = true;
  }

  /**
   * The camera never moves; instead each shape is centred and scaled (in the sim shader)
   * to fit the view, so shape changes and resizes are just part of the morph.
   */
  private fitShape(): void {
    if (!this.shape) return;
    const { min, max } = this.shape.bounds;
    let halfW = (max[0] - min[0]) / 2;
    let halfH = (max[1] - min[1]) / 2;
    let radius = Math.hypot(halfW, halfH);
    if (this.shape.is3D) {
      // It can rotate/tilt, so fit its bounding sphere-ish extent, but never less than its
      // actual width/height (flat, wide shapes like a galaxy would otherwise overflow).
      const halfD = (max[2] - min[2]) / 2;
      radius = Math.hypot(Math.max(halfW, halfD), halfH);
      halfW = Math.max(radius * 0.85, halfW, halfD);
      halfH = Math.max(radius * 0.85, halfH);
    }
    const viewHalfH = CAMERA_Z * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const viewHalfW = viewHalfH * this.camera.aspect;
    this.fitScale =
      (Math.min(viewHalfH / Math.max(halfH, 1e-6), viewHalfW / Math.max(halfW, 1e-6)) / this.params.framePadding) * (this.shape.scale ?? 1);
    this.fitCenter.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    this.fitRadius = radius * this.fitScale;
  }

  private resize = () => {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.canvasSize = { w, h };
    const c = this.canvas.getBoundingClientRect();
    const v = this.viewport.getBoundingClientRect();
    this.viewTarget = { x: v.left - c.left, y: v.top - c.top, w: v.width || 1, h: v.height || 1 };
    if (!this.viewPlaced || !this.viewEase || reducedMotion()) {
      this.view = { ...this.viewTarget };
      this.viewPlaced = true;
    }
    this.applyView();
  };

  /**
   * The camera frames the viewport; the canvas is a window onto that same projection, offset
   * to wherever the viewport sits inside it (no offset when they're the same element).
   */
  private applyView() {
    const { x, y, w, h } = this.view;
    this.camera.aspect = w / h;
    this.camera.setViewOffset(w, h, -x, -y, this.canvasSize.w, this.canvasSize.h);
    this.camera.updateProjectionMatrix();
    this.fitShape();
  }

  /** Ease the framing towards the viewport's current box. */
  private easeView(dt: number) {
    const k = 1 - Math.exp(-dt * this.viewEase);
    let changed = false;
    for (const key of ['x', 'y', 'w', 'h'] as const) {
      const d = this.viewTarget[key] - this.view[key];
      if (d === 0) continue;
      this.view[key] = Math.abs(d) < 0.1 ? this.viewTarget[key] : this.view[key] + d * k;
      changed = true;
    }
    if (changed) this.applyView();
  }

  private bindEvents(target: HTMLElement | Window, pageParallax: boolean) {
    const on = <K extends keyof EventMap>(el: EventTarget, type: K, fn: (e: EventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    const setFromClient = (x: number, y: number) => {
      const r = this.canvas.getBoundingClientRect();
      this.ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
      const v = this.viewport.getBoundingClientRect();
      const vx = ((x - v.left) / v.width) * 2 - 1;
      const vy = ((y - v.top) / v.height) * 2 - 1;
      this.pointerInside = Math.abs(vx) <= 1.05 && Math.abs(vy) <= 1.05;
    };
    let touchTimer = 0;
    const touchEnd = () => {
      clearTimeout(touchTimer);
      touchTimer = window.setTimeout(() => (this.pointerInside = false), 250);
    };

    on(target, 'pointermove', (e) => {
      if (e.pointerType !== 'touch') setFromClient(e.clientX, e.clientY);
    });
    on(target, 'pointerdown', (e) => {
      setFromClient(e.clientX, e.clientY);
      this.lastPlanePoint = null; // no velocity spike from the jump
      if (this.pointerInside) this.burst = this.params.tapBurst;
    });
    on(target === window ? document.documentElement : target, 'pointerleave', (e) => {
      if (e.pointerType !== 'touch') this.pointerInside = false;
    });
    // Touch via touch events so tracking continues while the page scrolls (pointer events get cancelled).
    on(target, 'touchstart', (e) => {
      clearTimeout(touchTimer);
      setFromClient(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    on(target, 'touchmove', (e) => setFromClient(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    on(target, 'touchend', touchEnd, { passive: true });
    on(target, 'touchcancel', touchEnd, { passive: true });
    on(window, 'blur', () => (this.pointerInside = this.pointerOnPage = false));

    if (pageParallax) {
      const setPage = (x: number, y: number) => {
        const r = this.viewport.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        // Full tilt when the pointer reaches the window edge on the far side of the canvas centre.
        const sx = x < cx ? cx : window.innerWidth - cx;
        const sy = y < cy ? cy : window.innerHeight - cy;
        this.pageNdc.set(
          THREE.MathUtils.clamp((x - cx) / Math.max(1, sx), -1, 1),
          THREE.MathUtils.clamp(-(y - cy) / Math.max(1, sy), -1, 1),
        );
        this.pointerOnPage = true;
      };
      on(window, 'pointermove', (e) => setPage(e.clientX, e.clientY));
      on(window, 'touchmove', (e) => setPage(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
      on(document.documentElement, 'mouseleave', () => (this.pointerOnPage = false));
    }

    const ro = new ResizeObserver(this.resize);
    ro.observe(this.container);
    if (this.viewport !== this.container) {
      ro.observe(this.viewport);
      // The viewport can also move without resizing (scrolling, layout shifts around it).
      on(window, 'scroll', this.resize, { passive: true });
      on(window, 'resize', this.resize);
    }
    this.cleanup.push(() => ro.disconnect());

    // Pause when scrolled out of view or the tab is hidden.
    const io = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting && !document.hidden;
      this.timer.reset();
    });
    io.observe(this.viewport);
    this.cleanup.push(() => io.disconnect());
    on(document, 'visibilitychange', () => {
      this.visible = !document.hidden;
      this.timer.reset();
    });
  }

  private tick() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 1 / 30);
    const p = this.params;
    const calm = reducedMotion();
    if (this.viewEase) this.easeView(dt);

    // Camera + groups

    const tiltK = 1 - Math.exp(-dt * 2.5);
    const look = this.pointerOnPage ? this.pageNdc : this.pointerInside ? this.ndc : null;
    const tx = look ? -look.y * p.parallax : 0;
    const ty = look ? look.x * p.parallax : 0;
    this.tilt.rotation.x += (tx - this.tilt.rotation.x) * tiltK;
    this.tilt.rotation.y += (ty - this.tilt.rotation.y) * tiltK;
    if (this.spinTarget === null) {
      if (!calm) this.spin.rotation.y += p.autoRotate * dt;
    } else {
      this.spin.rotation.y += (this.spinTarget - this.spin.rotation.y) * (1 - Math.exp(-dt * 2));
    }
    this.scene.updateMatrixWorld();

    // Pointer ray in particle (spin-local) space.
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const inv = this.spin.matrixWorld.clone().invert();
    const ray = this.raycaster.ray.clone().applyMatrix4(inv);
    ray.direction.normalize();
    // Closest point on the ray to the origin approximates "where on the shape" the pointer is.
    const planePoint = ray.at(-ray.origin.dot(ray.direction), new THREE.Vector3());
    if (this.lastPlanePoint && dt > 0) {
      const v = planePoint.clone().sub(this.lastPlanePoint).divideScalar(dt);
      this.pointerVel.lerp(v, 1 - Math.exp(-dt * 20));
    } else this.pointerVel.set(0, 0, 0);
    this.lastPlanePoint = this.pointerInside ? planePoint : null;
    if (!this.pointerInside) this.pointerVel.multiplyScalar(Math.exp(-dt * 5));

    this.presence += ((this.pointerInside ? 1 : 0) - this.presence) * (1 - Math.exp(-dt * 6));
    // Swirl strength: a resting baseline plus a boost from pointer speed.
    const speed = Math.min(this.pointerVel.length() / 3, 1);
    const stirTarget = p.idleSwirl + (1 - p.idleSwirl) * speed;
    this.stir += (stirTarget - this.stir) * (1 - Math.exp(-dt * (stirTarget > this.stir ? 10 : 2)));
    this.burst *= Math.exp(-dt * 8);
    this.morph = Math.min(1, this.morph + dt / Math.max(0.01, this.morphSeconds));
    this.intro = Math.min(1, this.intro + dt / Math.max(0.01, p.introDuration));

    const u = this.velVar.material.uniforms;
    u.uDt.value = dt;
    u.uRayOrigin.value.copy(ray.origin);
    u.uRayDir.value.copy(ray.direction);
    u.uPresence.value = this.presence;
    u.uPointerVel.value.copy(this.pointerVel);
    u.uRadius.value = p.radius;
    u.uSwirl.value = p.swirl * this.stir;
    u.uPush.value = p.push;
    u.uDrag.value = p.drag;
    u.uBurst.value = this.burst * this.presence;
    u.uSpring.value = p.spring;
    u.uDamping.value = p.damping;
    u.uNoise.value = calm ? p.noise * 0.3 : p.noise;
    u.uNoiseScale.value = p.noiseScale;
    u.uNoiseTime.value += dt * p.noiseSpeed;
    // Smoothstep so the pull eases in and settles without a kink.
    u.uFitScale.value = this.fitScale;
    const ramp = this.morph * this.morph * (3 - 2 * this.morph);
    // The intro pull starts much softer (cubic) so the haze settles across the whole fade.
    u.uMorph.value = this.intro < 1 ? ramp * ramp * ramp : ramp;
    this.posVar.material.uniforms.uDt.value = dt;
    this.colVar.material.uniforms.uMorph.value = this.morph;

    if (this.shape) this.gpu.compute();

    const m = this.material.uniforms;
    m.tPosition.value = this.gpu.getCurrentRenderTarget(this.posVar).texture;
    m.tVelocity.value = this.gpu.getCurrentRenderTarget(this.velVar).texture;
    m.tColor.value = this.gpu.getCurrentRenderTarget(this.colVar).texture;
    m.uSize.value = p.pointSize;
    // Glow is for pointer play; don't let transition travel light the cloud up.
    m.uSpeedGlow.value = p.speedGlow * (1 - Math.sin((Math.PI / 2) * Math.min(1, (1 - this.morph) * 2)));
    // Intro: ease-in-out fade, weighted late so points stay faint while still loose.
    const fadeIn = this.intro * this.intro * (3 - 2 * this.intro);
    m.uOpacity.value = p.opacity * fadeIn * fadeIn;
    // Ease the fade in/out when switching between flat and 3D shapes.
    const fadeTarget = this.shape?.is3D ? p.depthFade * (this.shape.depthFade ?? 1) : 0;
    this.depthFade += (fadeTarget - this.depthFade) * (1 - Math.exp(-dt * 3));
    m.uDepthFade.value = this.depthFade;
    m.uDepthRadius.value = this.fitRadius;
    m.uDepthFadeStart.value = p.depthFadeStart;
    m.uDepthFadeEnd.value = Math.max(p.depthFadeEnd, p.depthFadeStart + 0.01);
    // Projection height in buffer pixels is the viewport's, not the (possibly larger) canvas's.
    const projH = this.view.h * this.renderer.getPixelRatio();
    m.uProjScale.value = projH / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));

    this.renderer.render(this.scene, this.camera);
  }
}
