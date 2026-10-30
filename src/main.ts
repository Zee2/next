import * as THREE from 'three';
import {
  ParticleField,
  geometryShape,
  imageShape,
  modelShape,
  pathShape,
  svgShape,
  textShape,
  type PointShape,
} from './particles';
import { createTweakPanel, textOptions, type TextSettings } from './tweakPanel';

const stage = document.getElementById('stage')!;
const status = document.getElementById('status')!;
const field = new ParticleField(stage, { count: 256 * 256 });
(window as unknown as { field: ParticleField }).field = field; // for poking at from the console

// ------------------------------------------------------------------ shape catalogue

type Entry = { label: string; group: 'symbols' | 'models'; make: () => Promise<PointShape> };

const models = `${import.meta.env.BASE_URL}models/`;

const entries: Entry[] = [
  {
    label: 'Heart',
    group: 'symbols',
    make: () =>
      pathShape(
        'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
      ),
  },
  { label: 'Star', group: 'symbols', make: () => pathShape('M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z') },
  { label: 'Sparkle', group: 'symbols', make: () => pathShape('M12 0C13 8 16 11 24 12 16 13 13 16 12 24 11 16 8 13 0 12 8 11 11 8 12 0Z') },
  {
    label: 'Rings',
    group: 'symbols',
    make: () =>
      svgShape(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="42" fill="none" stroke="#fff" stroke-width="5"/><circle cx="50" cy="50" r="28" fill="none" stroke="#fff" stroke-width="3"/><circle cx="50" cy="50" r="10" fill="#fff"/></svg>`,
        { edgeBias: 0 },
      ),
  },
  { label: '🌊 emoji', group: 'symbols', make: () => textShape('🌊', { useColor: true, edgeBias: 0, opacity: 1, density: 1 }) },
  { label: 'Torus knot', group: 'models', make: async () => geometryShape(new THREE.TorusKnotGeometry(1, 0.3, 200, 32)) },
  { label: 'knot.ply', group: 'models', make: () => modelShape(models + 'knot.ply') },
  { label: 'galaxy (ascii)', group: 'models', make: () => modelShape(models + 'galaxy_ascii.ply', { rotation: [25, 0, 0] }) },
  { label: 'Head', group: 'models', make: () => modelShape(models + 'head_lps.ply') },
  { label: 'Lucy', group: 'models', make: () => modelShape(models + 'lucy100k.ply') },
  { label: 'Me', group: 'models', make: () => modelShape(models + 'me-web.ply') },
  // The full-size original isn't committed (see .gitignore); only available locally.
  { label: 'Me (original)', group: 'models', make: () => modelShape(models + 'me.ply') },
  { label: 'planet 3DGS .ply', group: 'models', make: () => modelShape(models + 'planet_3dgs.ply') },
  { label: 'planet .splat', group: 'models', make: () => modelShape(models + 'planet.splat') },
];

const buttons = new Map<string, HTMLButtonElement>();
let activeLabel = '';

async function show(label: string, make: () => Promise<PointShape>) {
  status.textContent = `Loading ${label}…`;
  try {
    const t0 = performance.now();
    const shape = await make();
    field.setShape(shape);
    activeLabel = label;
    showingText = false;
    buttons.forEach((b, l) => b.classList.toggle('active', l === label));
    status.textContent = `${label}: ${(shape.positions.length / 3).toLocaleString()} points (${Math.round(performance.now() - t0)} ms)`;
  } catch (e) {
    console.error(e);
    status.textContent = `Failed: ${(e as Error).message}`;
  }
}

for (const entry of entries) {
  const b = document.createElement('button');
  b.textContent = entry.label;
  b.onclick = () => show(entry.label, entry.make);
  document.getElementById(entry.group)!.appendChild(b);
  buttons.set(entry.label, b);
}

const textInput = document.getElementById('text') as HTMLInputElement;
const textSettings: TextSettings = { font: 'Inter', weight: 800, italic: false, size: 1, opacity: 0.27, density: 0.45, letterSpacing: 0, lineHeight: 1.05 };
let showingText = false;
const showText = async () => {
  const value = textInput.value.replace(/\\n/g, '\n') || ' ';
  await show(`"${value}"`, () => textShape(value, textOptions(textSettings)));
  showingText = true;
};
document.getElementById('text-go')!.onclick = showText;
textInput.addEventListener('keydown', (e) => e.key === 'Enter' && showText());

// ------------------------------------------------------------------ auto-cycle

let cycleTimer = 0;
const cycleButton = document.getElementById('cycle')!;
cycleButton.onclick = () => {
  if (cycleTimer) {
    clearInterval(cycleTimer);
    cycleTimer = 0;
  } else {
    cycleTimer = window.setInterval(() => {
      const i = entries.findIndex((e) => e.label === activeLabel);
      const next = entries[(i + 1) % entries.length];
      show(next.label, next.make);
    }, 5000);
  }
  cycleButton.textContent = `Auto-cycle: ${cycleTimer ? 'on' : 'off'}`;
};

// ------------------------------------------------------------------ drag & drop

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  const name = file.name.toLowerCase();
  if (name.endsWith('.svg')) {
    show(file.name, async () => svgShape(await file.text()));
  } else if (file.type.startsWith('image/')) {
    const url = URL.createObjectURL(file);
    await show(file.name, () => imageShape(url));
    URL.revokeObjectURL(url);
  } else {
    show(file.name, async () => modelShape(await file.arrayBuffer(), { name: file.name }));
  }
});

// ------------------------------------------------------------------ tweak panel

createTweakPanel(field, { text: { settings: textSettings, onChange: () => showingText && showText() } });

showText();
