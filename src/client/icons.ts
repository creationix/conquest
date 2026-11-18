// Icons as 24x24 SVG path data, shared by the canvas map and the DOM HUD.

export const ICONS = {
  gold: 'M2.5 20.5 4 15h7l1.5 5.5Zm9 0L13 15h7l1.5 5.5ZM7 13.5 8.5 8h7l1.5 5.5ZM10 4.8l.9-2.3.9 2.3 2.4.2-1.9 1.5.6 2.3-2-1.3-2 1.3.6-2.3L7.6 5Z',
  iron: 'M12.9 4.4c3.2-.5 6.4.6 8.6 2.9.3.3 0 .8-.4.7-2.4-.9-5-1-7.4-.5ZM11 4.4c-3.2-.5-6.4.6-8.6 2.9-.3.3 0 .8.4.7 2.4-.9 5-1 7.4-.5ZM10.4 3.5h3.2v4.2h-3.2ZM10.7 7.6h2.6l-.4 14h-1.8Z',
  coal: 'M2.5 18.5 5 13.2l5 .4 1.7 5-3.9 3.1-4.9-1.2ZM12.6 14.3l2.6-4.6 5.6.9 1.2 5.6-4.7 3-4.2-1.3ZM6.8 10.8 8.6 5.4l5-.9 2 4.4-3.1 3.4-4.3.2Z',
  timber: 'M12 1.8 18 9.4h-3l5.2 6.6h-6.2v5.4h-4v-5.4H3.8L9 9.4H6Z',
  horses: 'M5 3h4v8.3a3 3 0 0 0 6 0V3h4v8.6a7 7 0 0 1-14 0ZM5.2 5.5h3.4M15.4 5.5h3.4',
  horse: 'M7 22c.2-3 .9-5.3 2.7-7.3-1.4.4-2.6 1.4-3.8 1.6-1.4.2-2.6-.9-2.4-2.3.3-1.6 2.7-4.7 4.6-6.4.4-1.1.4-2.4 1-3.6l1.7 1.6c.7-.3 1.4-.4 2.2-.4 4.6.2 7.6 4.6 7.6 10.6 0 2.1-.3 4.2-.8 6.2Z',
  weapon: 'M20.6 2.4h1v1l-10.8 11-1.8-1.8ZM4.7 13.6l1.4-1.4 5.7 5.7-1.4 1.4-1.6-1.6-3.3 3.3-2.5-.1-.1-2.5 3.3-3.3Z',
  boat: 'M2.5 15h19l-3.6 5.5H6ZM11 2.5v11.3H4.6ZM12.6 4.2c3.3 2.2 5.6 5.6 6.4 9.6h-6.4Z',
  city: 'M2.5 21.5V9.5h3.2v2.2h1.8V9.5h3V5h1.4V2.5L15 3.6l-2.1 1v.4h.7v4.5h3v2.2h1.8V9.5h3.2v12h-7.5v-3.7a2.1 2.1 0 0 0-4.2 0v3.7Z',
  stockpile: 'M3.5 10.3C3.5 7 7.3 4.5 12 4.5s8.5 2.5 8.5 5.8v.7h-17Zm0 2.2h17v8h-17Zm7 1.8v3.5h3v-3.5Z',
  star: 'm12 2.5 2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9Z',
  shield: 'M12 2.5 20 5.5v6c0 5-3.4 8.7-8 10-4.6-1.3-8-5-8-10v-6Z',
  swords: 'M3.4 2.4h-1v1l10.8 11 1.8-1.8ZM19.3 13.6l-1.4-1.4-5.7 5.7 1.4 1.4 1.6-1.6 3.3 3.3 2.5-.1.1-2.5-3.3-3.3ZM20.6 2.4h1v1l-6.4 6.5-1.8-1.8ZM4.7 13.6l1.4-1.4 5.7 5.7-1.4 1.4-1.6-1.6-3.3 3.3-2.5-.1-.1-2.5 3.3-3.3Z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6 6 18',
  fit: 'M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  computer: 'M4 5h16v10H4ZM9 19h6M12 15v4',
  device: 'M7 2.5h10v19H7ZM11 18.5h2',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  scroll: 'M7 3h11a2 2 0 0 1 2 2v1h-4M7 3a2 2 0 0 0-2 2v13a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3V8M9 9h7M9 13h7M9 17h4',
  sound: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4ZM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11',
  mute: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4ZM16 9.5l5 5m0-5-5 5',
  fullscreen: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  exitFullscreen: 'M3 8h5V3m8 0v5h5M3 16h5v5m13-5h-5v5',
  download: 'M12 3v12m-5-5 5 5 5-5M4 20h16',
  bell: 'M12 3a5 5 0 0 0-5 5v4l-2 4h14l-2-4V8a5 5 0 0 0-5-5Zm-2 15a2 2 0 0 0 4 0Z',
  chevronUp: 'm6 15 6-6 6 6',
  chevronDown: 'm6 9 6 6 6-6',
  trade: 'M4 8h13l-3.5-3.5M20 16H7l3.5 3.5',
  music: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm11-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
} as const;

export type IconName = keyof typeof ICONS;

/** Icons drawn with strokes instead of fills. */
export const STROKED = new Set<IconName>(['menu', 'close', 'fit', 'plus', 'minus', 'computer', 'device', 'check', 'scroll', 'sound', 'mute', 'fullscreen', 'trade', 'music', 'exitFullscreen', 'download', 'chevronUp', 'chevronDown']);

const cache = new Map<string, Path2D>();
export function iconPath(name: IconName): Path2D {
  let p = cache.get(name);
  if (!p) {
    p = new Path2D(ICONS[name]);
    cache.set(name, p);
  }
  return p;
}

export const GOOD_COLORS = {
  gold: '#f5c542',
  iron: '#9fb4c7',
  coal: '#5b5f6b',
  timber: '#79b85a',
  horses: '#c99a62',
} as const;

export const GOOD_LABELS = { gold: 'Gold', iron: 'Iron', coal: 'Coal', timber: 'Timber', horses: 'Horses' } as const;
