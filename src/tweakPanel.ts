import GUI from 'lil-gui';
import { defaultParams, type ParticleField } from './particles';

/** Fonts offered for text shapes. All but the system ones come from Google Fonts. */
export const fonts: Record<string, string> = {
  Inter: 'Inter, sans-serif',
  'Space Grotesk': '"Space Grotesk", sans-serif',
  'Playfair Display': '"Playfair Display", serif',
  'Instrument Serif': '"Instrument Serif", serif',
  'JetBrains Mono': '"JetBrains Mono", monospace',
  Caveat: 'Caveat, cursive',
  'System UI': 'system-ui, sans-serif',
  Georgia: 'Georgia, serif',
};

const FONTS_URL =
  'https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,100..900;1,100..900&family=Space+Grotesk:wght@300..700&family=Playfair+Display:ital,wght@0,400..900;1,400..900&family=JetBrains+Mono:ital,wght@0,100..800;1,100..800&family=Instrument+Serif:ital@0;1&family=Caveat:wght@400..700&display=swap';

/** Add the stylesheet for every font in `fonts` (pages only load the ones they use up front). */
export function loadAllFonts(): void {
  if (document.querySelector(`link[href="${FONTS_URL}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = FONTS_URL;
  document.head.appendChild(link);
}

export interface TextSettings {
  font: string;
  weight: number;
  italic: boolean;
  size: number;
  opacity: number;
  density: number;
  letterSpacing: number;
  lineHeight: number;
}

/** `TextSettings` → `textShape` options. */
export function textOptions({ font, ...rest }: TextSettings) {
  return { ...rest, font: fonts[font] ?? font };
}

export interface TweakPanelOptions {
  title?: string;
  /** Adds a Text folder bound to these settings; `onChange` should re-render the text. */
  text?: { settings: TextSettings; onChange: () => void };
}

const tip = <T extends { domElement: HTMLElement }>(c: T, text: string) => ((c.domElement.title = text), c);

/** lil-gui panel for live-tweaking a field's params. Starts closed. */
export function createTweakPanel(field: ParticleField, opts: TweakPanelOptions = {}): GUI {
  const gui = new GUI({ title: opts.title ?? 'Tweak' });
  gui.close();
  const p = field.params;

  // [key, min, max, step, tooltip]; ranges are set so the defaults sit mid-slider.
  type Slider = [keyof typeof p, number, number, number, string];
  const folders: [string, Slider[]][] = [
    ['Look', [
      ['pointSize', 0.001, 0.01, 0.0001, 'Point diameter in world units (shapes are ~2 units wide).'],
      ['opacity', 0.05, 1, 0.01, 'Per-point opacity. Points blend additively, so dense areas brighten.'],
      ['speedGlow', 0, 2, 0.01, 'Fast-moving particles get brighter and slightly larger.'],
      ['depthFade', 0, 1, 0.01, '3D shapes only: how much points fade towards the back of the shape.'],
      ['depthFadeStart', -1, 1, 0.01, 'Depth where the fade begins, in shape radii (-1 = front, 0 = centre, 1 = back).'],
      ['depthFadeEnd', -1, 1.5, 0.01, 'Depth where the fade reaches full strength.'],
    ]],
    ['Pointer', [
      ['radius', 0.02, 0.3, 0.005, 'Radius of the pointer\'s influence, in world units.'],
      ['swirl', 0, 60, 0.5, 'Tangential force that spins particles around the pointer.'],
      ['idleSwirl', 0, 1, 0.01, 'Fraction of the swirl applied while the pointer rests; the rest comes from moving it.'],
      ['push', -10, 50, 0.5, 'Outward push away from the pointer (negative pulls particles in).'],
      ['drag', 0, 12, 0.1, 'How much particles get dragged along with pointer motion.'],
      ['tapBurst', 0, 150, 1, 'Strength of the shockwave on click / tap.'],
    ]],
    ['Physics', [
      ['spring', 1, 80, 0.5, 'Pull back towards the shape. Higher = snappier return.'],
      ['damping', 0.5, 25, 0.1, 'Velocity damping per second. Higher = less wobble/overshoot.'],
      ['noise', 0, 6, 0.01, 'Ambient drift strength. It fights the spring, so stiffer springs need more noise to show.'],
      ['noiseScale', 0.1, 50, 0.1, 'Spatial frequency of the drift (higher = finer, more independent jitter).'],
      ['noiseSpeed', 0, 5, 0.05, 'How fast the drift field changes over time.'],
      ['introDuration', 0.5, 10, 0.1, 'Seconds for the first shape to fade in and settle (reload to see it).'],
      ['introScatter', 0, 0.2, 0.005, 'How far from their spot particles start when the page loads.'],
      ['morphDuration', 0.05, 4, 0.05, 'Seconds for the pull towards a new shape to ramp in. Longer = more gradual transition.'],
    ]],
    ['Camera', [
      ['autoRotate', -1, 1, 0.01, 'Auto-rotation speed for 3D shapes (radians/second).'],
      ['parallax', 0, 0.8, 0.01, 'How far the shape tilts to follow the pointer (radians).'],
      ['framePadding', 0.8, 2, 0.01, 'Space around the shape when framing (1 = edge to edge).'],
    ]],
  ];

  for (const [name, sliders] of folders) {
    const folder = gui.addFolder(name);
    for (const [key, min, max, step, text] of sliders) {
      const c = tip(folder.add(p, key, min, max, step), text);
      if (key === 'framePadding') c.onChange(() => field.refit());
    }
    if (name === 'Look') {
      tip(folder.addColor(p.palette, '0').name('palette A'), 'Gradient start for shapes without their own colours.').onChange(() => field.refreshColors());
      tip(folder.addColor(p.palette, '1').name('palette B'), 'Gradient end for shapes without their own colours.').onChange(() => field.refreshColors());
      tip(folder.add(p, 'forcePalette'), 'Use the palette even for shapes with colours (emoji, images, models).').onChange(() => field.refreshColors());
      tip(folder.add(p, 'density', 0.1, 2, 0.01), 'Particles per unit of screen area. Smaller shapes use fewer particles; the rest are hidden.').onFinishChange(() => field.refreshColors());
    }
  }

  const initialText = opts.text && { ...opts.text.settings };
  if (opts.text) {
    const { settings, onChange } = opts.text;
    const text = gui.addFolder('Text');
    text.onOpenClose(loadAllFonts);
    tip(text.add(settings, 'font', Object.keys(fonts)), 'Font for the text shape (loaded from Google Fonts).').onChange(onChange);
    tip(text.add(settings, 'weight', 100, 900, 100), 'Font weight. Fonts without that weight get the nearest one (or a synthesised bold).').onFinishChange(onChange);
    tip(text.add(settings, 'italic'), 'Italic style.').onChange(onChange);
    tip(text.add(settings, 'size', 0.1, 1.5, 0.01), 'Text size relative to filling the view (1 = fills it).').onFinishChange(onChange);
    tip(text.add(settings, 'opacity', 0.05, 1, 0.01), 'Opacity of the text\'s points (multiplies the overall opacity).').onFinishChange(onChange);
    tip(text.add(settings, 'density', 0.05, 2, 0.01), 'Particle density for the text (multiplies the overall density).').onFinishChange(onChange);
    tip(text.add(settings, 'letterSpacing', -0.15, 0.6, 0.01), 'Extra space between letters, in em.').onFinishChange(onChange);
    tip(text.add(settings, 'lineHeight', 0.6, 2, 0.01), 'Line spacing for multi-line text.').onFinishChange(onChange);
  }

  const actions = {
    'copy settings': async () => {
      const changed: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p)) {
        if (JSON.stringify(v) !== JSON.stringify(defaultParams[k as keyof typeof defaultParams])) changed[k] = v;
      }
      const out: Record<string, unknown> = { params: changed };
      if (opts.text) out.text = opts.text.settings;
      const json = JSON.stringify(out, null, 2);
      try {
        await navigator.clipboard.writeText(json);
      } catch {
        console.log(json);
      }
      console.info('[tweak] settings copied:\n' + json);
    },
    reset: () => {
      Object.assign(p, structuredClone(defaultParams));
      if (opts.text && initialText) Object.assign(opts.text.settings, initialText);
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
      field.refreshColors();
      field.refit();
      opts.text?.onChange();
    },
  };
  tip(gui.add(actions, 'copy settings'), 'Copy every setting that differs from the defaults as JSON.');
  gui.add(actions, 'reset');
  return gui;
}
