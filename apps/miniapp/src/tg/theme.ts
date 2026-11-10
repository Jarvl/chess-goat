import type { ThemeParams } from './types';
import type { Tg } from './webapp';

/** Telegram's colours with a fixed palette per scheme when a key is missing. */
export const FALLBACK_THEME = {
  light: {
    bg: '#ffffff',
    text: '#000000',
    hint: '#707579',
    link: '#2481cc',
    button: '#2481cc',
    buttonText: '#ffffff',
    secondaryBg: '#f1f1f4',
    destructive: '#d14e4e',
  },
  dark: {
    bg: '#18222d',
    text: '#ffffff',
    hint: '#8b9aa8',
    link: '#6ab2f2',
    button: '#2ea6ff',
    buttonText: '#ffffff',
    secondaryBg: '#131b23',
    destructive: '#ef5b5b',
  },
} as const;

/** The Chess Goat accents, fixed per scheme on top of Telegram's neutrals. */
export const ACCENTS = {
  light: {
    '--acc': '#2e7d4f',
    '--acc-ink': '#ffffff',
    '--acc-text': '#256b42',
    '--acc-soft': '#e3f1e7',
    '--move': '#e0b94a',
    '--move-ink': '#2a2000',
    '--move-soft': '#fbf3dc',
    '--move-text': '#8a6a00',
    '--urgent': '#d14e4e',
    '--hero-bg': 'linear-gradient(135deg, #236140, #153a26)',
    '--hero-ink': '#f5f0dc',
    '--hero-sub': '#bcd3c2',
    '--bl': '#f0ead2',
    '--bd': '#7d9f6b',
    '--lm': 'rgba(224, 185, 74, 0.6)',
    '--sel': 'rgba(46, 125, 79, 0.55)',
    '--dot': 'rgba(21, 58, 38, 0.4)',
    '--pm': '#2481cc',
    '--pm-sq': 'rgba(36, 129, 204, 0.42)',
    '--pm-soft': '#e6f1fa',
  },
  dark: {
    '--acc': '#4cbb7a',
    '--acc-ink': '#06200f',
    '--acc-text': '#6fd197',
    '--acc-soft': 'rgba(76, 187, 122, 0.16)',
    '--move': '#e8c35a',
    '--move-ink': '#2a2000',
    '--move-soft': 'rgba(232, 195, 90, 0.12)',
    '--move-text': '#ecc964',
    '--urgent': '#ef5b5b',
    '--hero-bg': 'linear-gradient(135deg, #1f4a33, #11281b)',
    '--hero-ink': '#f5f0dc',
    '--hero-sub': '#a9c7b3',
    '--bl': '#e6dfc3',
    '--bd': '#6e9160',
    '--lm': 'rgba(232, 195, 90, 0.6)',
    '--sel': 'rgba(76, 187, 122, 0.6)',
    '--dot': 'rgba(12, 40, 24, 0.45)',
    '--pm': '#6ab2f2',
    '--pm-sq': 'rgba(106, 178, 242, 0.45)',
    '--pm-soft': 'rgba(106, 178, 242, 0.14)',
  },
} as const satisfies Record<'light' | 'dark', Record<string, string>>;

export function themeVariables(
  params: ThemeParams,
  scheme: 'light' | 'dark',
): Record<string, string> {
  const fallback = FALLBACK_THEME[scheme];
  const bg = params.bg_color ?? fallback.bg;
  const secondaryBg = params.secondary_bg_color ?? fallback.secondaryBg;
  return {
    '--bg': bg,
    '--text': params.text_color ?? fallback.text,
    '--hint': params.hint_color ?? fallback.hint,
    '--link': params.link_color ?? fallback.link,
    '--button': params.button_color ?? fallback.button,
    '--button-text': params.button_text_color ?? fallback.buttonText,
    '--secondary-bg': secondaryBg,
    '--destructive': params.destructive_text_color ?? fallback.destructive,
    // The design's two surfaces: the page sits on the secondary colour, cards on the main one.
    '--page': secondaryBg,
    '--card': bg,
    ...ACCENTS[scheme],
  };
}

/** Writes the theme and the stable viewport height as CSS custom properties on the root. */
export function applyTheme(tg: Tg, root: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries(themeVariables(tg.themeParams, tg.colorScheme))) {
    root.style.setProperty(name, value);
  }
  root.dataset.theme = tg.colorScheme;
  root.style.setProperty('--stable-height', `${tg.stableHeight}px`);
}

/** Telegram's own chrome (header, background, bottom bar, MainButton) matched to the page. */
export function applyChrome(tg: Tg): void {
  tg.setChromeColor('secondary_bg_color');
  const accent = ACCENTS[tg.colorScheme];
  tg.setMainButtonColors(accent['--acc'], accent['--acc-ink']);
}
