import { ParticleField, modelShape, textShape, type PointShape } from './particles';
import { createTweakPanel, textOptions, type TextSettings } from './tweakPanel';

// Lucide icons (ISC licence), drawn inside the menu pills.
const icons: Record<string, string> = {
  about: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  projects: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  writings: '<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>',
  work: '<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/>',
};

// Point cloud per menu item; shared loaders are only fetched once.
const models = `${import.meta.env.BASE_URL}models/`;
const me = () => modelShape(models + 'me-web.ply');
// Projects/Writings are placeholders for testing.
const galaxy = () => modelShape(models + 'galaxy_ascii.ply', { rotation: [28, 0, -14], scale: 0.8, opacity: 0.55, depthFade: 0 });
const wave = () => textShape('🌊', { useColor: true, edgeBias: 0, opacity: 1, density: 1 });
const shapeLoaders: Record<string, () => Promise<PointShape>> = {
  about: me,
  projects: galaxy,
  writings: wave,
  work: me,
};

const stage = document.querySelector<HTMLElement>('.stage')!;
const menu = document.querySelector<HTMLElement>('.menu')!;
const links = [...menu.querySelectorAll<HTMLAnchorElement>('a[data-key]')];
const sections = [...document.querySelectorAll<HTMLElement>('.content section[data-key]')];
const scrim = document.querySelector<HTMLElement>('.scrim')!;

const linkFor = (key: string | null) => links.find((l) => l.dataset.key === key) ?? null;
const readHash = () => (linkFor(location.hash.slice(1)) ? location.hash.slice(1) : null);
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Lay out for a deep link before the field measures the stage, so it doesn't glide in from the idle layout.
document.body.classList.toggle('open', readHash() !== null);

// ------------------------------------------------------------------ particles

const field = new ParticleField(document.querySelector<HTMLElement>('.particles')!, {
  viewport: stage,
  viewEase: 5,
  eventTarget: window,
  params: {
    // Shapes without their own colours (the name) are white.
    palette: ['#ffffff', '#ffffff'],
    introDuration: 3,
  },
});
(window as unknown as { field: ParticleField }).field = field; // for poking at from the console

const nameText: TextSettings = { font: 'Caveat', weight: 500, italic: false, size: 1, opacity: 0.27, density: 0.45, letterSpacing: 0, lineHeight: 0.75 };
// The narrow layout (same breakpoint as home.css) has a tall stage, so the name goes on two lines.
const narrow = window.matchMedia('(max-width: 760px)');
const nameString = () => (narrow.matches ? 'finn\nsinclair' : 'finn sinclair');

const cache = new Map<() => Promise<PointShape>, Promise<PointShape>>();
const load = (loader: () => Promise<PointShape>) => {
  if (!cache.has(loader)) cache.set(loader, loader());
  return cache.get(loader)!;
};

let wanted = '';
let pending: Promise<void> = Promise.resolve();
/** Morph to a menu item's shape, or the name. `force` re-renders even if it's already showing. */
function showShape(key: string, force = false): Promise<void> {
  if (key === wanted && !force) return pending;
  wanted = key;
  pending = (async () => {
    const shape = await (key === 'name' ? textShape(nameString(), textOptions(nameText)) : load(shapeLoaders[key]));
    // Ignore stale loads if the user has moved on.
    if (wanted === key) field.setShape(shape);
  })();
  return pending;
}

// ------------------------------------------------------------------ menu

/** A pill behind one menu item, with the item's icon, that slides between items. */
class Pill {
  link: HTMLAnchorElement | null = null;
  private icons: SVGElement[];

  constructor(private el: HTMLElement) {
    const slot = el.querySelector<HTMLElement>('.pill-icon')!;
    for (const [key, paths] of Object.entries(icons)) {
      slot.insertAdjacentHTML(
        'beforeend',
        `<svg data-key="${key}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`,
      );
    }
    this.icons = [...slot.querySelectorAll('svg')];
  }

  show(link: HTMLAnchorElement | null) {
    if (link === this.link) return;
    const first = !this.link;
    this.link = link;
    if (!link) {
      this.el.classList.remove('visible');
      return;
    }
    // First appearance jumps into place; after that the pill slides between items.
    this.el.classList.toggle('instant', first);
    this.place();
    if (first) {
      this.el.getBoundingClientRect(); // commit the position before re-enabling transitions
      this.el.classList.remove('instant');
    }
    this.el.classList.add('visible');
    for (const svg of this.icons) svg.classList.toggle('current', svg.dataset.key === link.dataset.key);
  }

  place() {
    if (!this.link) return;
    const menuBox = menu.getBoundingClientRect();
    const box = this.link.getBoundingClientRect();
    const css = getComputedStyle(menu);
    const padX = parseFloat(css.getPropertyValue('--pad-x'));
    const lead = parseFloat(css.paddingLeft); // icon + gaps to the left of the text column
    this.el.style.transform = `translate(${box.left - menuBox.left - lead}px, ${box.top - menuBox.top}px)`;
    this.el.style.width = `${lead + box.width + padX}px`;
  }
}

const hoverPill = new Pill(menu.querySelector<HTMLElement>('.hover-pill')!);
const selectedPill = new Pill(menu.querySelector<HTMLElement>('.highlight')!);

/** Previewed item: sticky while nothing is open, so the cloud can be played with. */
let hovered: HTMLAnchorElement | null = null;
/** Clicked item, whose content is showing. */
let selected: HTMLAnchorElement | null = null;

function render() {
  for (const link of links) {
    link.classList.toggle('hovered', link === hovered);
    link.classList.toggle('selected', link === selected);
  }
  hoverPill.show(hovered === selected ? null : hovered);
  selectedPill.show(selected);
  return showShape((hovered ?? selected)?.dataset.key ?? 'name');
}

function setHover(link: HTMLAnchorElement | null) {
  if (link === hovered) return;
  hovered = link;
  render();
}

/** Animate `el` from where it was (`before`) to where the layout now puts it. */
function flip(el: HTMLElement, before: DOMRect) {
  if (reducedMotion()) return;
  const after = el.getBoundingClientRect();
  const dx = before.left - after.left;
  const dy = before.top - after.top;
  if (!dx && !dy) return;
  el.style.transition = 'none';
  el.style.transform = `translate(${dx}px, ${dy}px)`;
  el.getBoundingClientRect();
  el.style.transition = '';
  el.style.transform = '';
}

/** Open a menu item's content, or close it (null). Driven by the URL hash. */
function select(key: string | null) {
  const link = linkFor(key);
  if (link === selected) return;
  const before = menu.getBoundingClientRect();
  selected = link;
  for (const section of sections) section.hidden = section.dataset.key !== key;
  document.body.classList.toggle('open', !!link);
  window.scrollTo(0, 0);
  flip(menu, before);
  field.refit(); // the stage may have moved without resizing
  if (link) menu.style.setProperty('--selected-index', String(links.indexOf(link)));
  render();
  updateCollapse();
}

// ------------------------------------------------------------------ collapsing menu

// With an item open, the menu is pinned top left. Once the text scrolls up to it, the menu collapses
// to just the selected pill; tapping that expands the full menu over a scrim.
let expanded = false;

function setExpanded(value: boolean) {
  expanded = value;
  document.body.classList.toggle('menu-expanded', value);
}

function updateCollapse() {
  const section = sections.find((s) => !s.hidden);
  // Where the pinned menu's bottom edge sits. From its CSS `top` rather than its box, which the
  // collapse itself moves, so this doesn't flip-flop.
  const menuBottom = parseFloat(getComputedStyle(menu).top) + menu.offsetHeight;
  // Only once the text actually reaches the menu, not on the first pixel of scroll.
  const collapsed = !!section && section.getBoundingClientRect().top < menuBottom;
  document.body.classList.toggle('menu-collapsed', collapsed);
  if (!collapsed && expanded) setExpanded(false);
}

function close() {
  history.pushState(null, '', location.pathname + location.search);
  select(null);
}

/** Back to the idle state: nothing open or previewed, name shown. */
function goHome() {
  hovered = null;
  if (selected) close();
  else render();
}

// Clicking empty page (away from the stage, which has its own tap burst) goes home. The menu, the
// text (so selecting it doesn't close it), the scrim and the tweak panel have their own clicks.
document.addEventListener('click', (e) => {
  if (!(e.target instanceof Element) || e.target.closest('a, button, input, .menu, .content, .scrim, .lil-gui')) return;
  const r = stage.getBoundingClientRect();
  const margin = 24;
  const nearStage = e.clientX > r.left - margin && e.clientX < r.right + margin && e.clientY > r.top - margin && e.clientY < r.bottom + margin;
  if (!nearStage) goHome();
});

for (const link of links) {
  link.addEventListener('pointerenter', (e) => {
    // Touch has no hover; a tap goes straight to opening the item.
    if (e.pointerType !== 'touch') setHover(link);
  });
  link.addEventListener('focus', () => {
    if (link.matches(':focus-visible')) setHover(link);
  });
  link.addEventListener('click', (e) => {
    // Other items navigate to their hash.
    if (link !== selected) {
      setExpanded(false);
      return;
    }
    e.preventDefault();
    // The collapsed pill toggles the full menu.
    if (document.body.classList.contains('menu-collapsed')) {
      setExpanded(!expanded);
      return;
    }
    // Otherwise clicking the open item closes it.
    close();
  });
}

// While something is open, previews are only for as long as you're over the menu.
menu.addEventListener('pointerleave', (e) => {
  if (selected && e.pointerType !== 'touch') setHover(null);
});
menu.addEventListener('focusout', (e) => {
  if (selected && !menu.contains(e.relatedTarget as Node | null)) setHover(null);
});

window.addEventListener('hashchange', () => select(readHash()));
narrow.addEventListener('change', () => {
  if (wanted === 'name') showShape('name', true);
  updateCollapse();
});
window.addEventListener('scroll', updateCollapse, { passive: true });
scrim.addEventListener('click', () => setExpanded(false));
// With a mouse, hovering the collapsed pill expands the menu too.
menu.addEventListener('pointerenter', (e) => {
  if (e.pointerType !== 'touch' && document.body.classList.contains('menu-collapsed')) setExpanded(true);
});
menu.addEventListener('pointerleave', (e) => {
  if (e.pointerType !== 'touch') setExpanded(false);
});
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (expanded) setExpanded(false);
  else if (selected) close();
});

select(readHash());
render().then(() => {
  // Warm the cache so the first hover morphs straight away.
  Object.values(shapeLoaders).forEach(load);
});

// Keep the pills fitted if fonts load late or the layout changes.
const refit = () => {
  hoverPill.place();
  selectedPill.place();
};
document.fonts.ready.then(refit);
new ResizeObserver(refit).observe(menu);

// ------------------------------------------------------------------ playground settings

// Hidden by default: press ` (backtick) to toggle, or open the page with ?tweak.
const panel = createTweakPanel(field, {
  title: 'Playground (` to hide)',
  // Editing the name's text settings brings the name back so you can see them.
  text: {
    settings: nameText,
    onChange: () => {
      goHome();
      showShape('name', true);
    },
  },
});
let panelVisible = false;
const setPanel = (visible: boolean) => {
  panelVisible = visible;
  panel.show(visible);
  if (visible) panel.open();
};
setPanel(new URLSearchParams(location.search).has('tweak'));
window.addEventListener('keydown', (e) => {
  if (e.key !== '`' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof HTMLElement && e.target.closest('input, textarea, [contenteditable]')) return;
  setPanel(!panelVisible);
}, true); // capture: lil-gui stops key events from bubbling out of its controls
