/**
 * Icons of the formula chips (field types, tables, `CurrentValue`, a broken
 * reference) as plain SVG node lists, so that both React (read-only
 * formulas) and the CodeMirror widgets (DOM, no React) draw the same ones.
 * Shapes of the lucide icons the app uses elsewhere (ISC licence, like
 * `lucide-react`; `grid/columns.ts` does the same for the canvas headers).
 */

export type IconNode = readonly (readonly [string, Readonly<Record<string, string>>])[];

const ICONS = {
  text: [
    ['path', { d: 'M12 4v16' }],
    ['path', { d: 'M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2' }],
    ['path', { d: 'M9 20h6' }],
  ],
  number: [
    ['line', { x1: '4', x2: '20', y1: '9', y2: '9' }],
    ['line', { x1: '4', x2: '20', y1: '15', y2: '15' }],
    ['line', { x1: '10', x2: '8', y1: '3', y2: '21' }],
    ['line', { x1: '16', x2: '14', y1: '3', y2: '21' }],
  ],
  select: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'm16 10-4 4-4-4' }],
  ],
  datetime: [
    ['path', { d: 'M8 2v3' }],
    ['path', { d: 'M16 2v3' }],
    ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }],
    ['path', { d: 'M3 9h18' }],
  ],
  checkbox: [
    ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }],
    ['path', { d: 'm16 9-5.5 5.5L8 12' }],
  ],
  user: [
    ['path', { d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' }],
    ['circle', { cx: '12', cy: '7', r: '4' }],
  ],
  link: [
    ['path', { d: 'M9 17H7A5 5 0 0 1 7 7h2' }],
    ['path', { d: 'M15 7h2a5 5 0 1 1 0 10h-2' }],
    ['line', { x1: '8', x2: '16', y1: '12', y2: '12' }],
  ],
  attachment: [
    [
      'path',
      {
        d: 'm16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551',
      },
    ],
  ],
  autoNumber: [
    ['path', { d: 'M11 5h10' }],
    ['path', { d: 'M11 12h10' }],
    ['path', { d: 'M11 19h10' }],
    ['path', { d: 'M4 4h1v5' }],
    ['path', { d: 'M4 9h2' }],
    ['path', { d: 'M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02' }],
  ],
  formula: [
    [
      'path',
      {
        d: 'M18 7V5a1 1 0 0 0-1-1H6.5a.5.5 0 0 0-.4.8l4.5 6a2 2 0 0 1 0 2.4l-4.5 6a.5.5 0 0 0 .4.8H17a1 1 0 0 0 1-1v-2',
      },
    ],
  ],
  lookup: [
    ['path', { d: 'M21 5H3' }],
    ['path', { d: 'M10 12H3' }],
    ['path', { d: 'M10 19H3' }],
    ['circle', { cx: '17', cy: '15', r: '3' }],
    ['path', { d: 'm21 19-1.9-1.9' }],
  ],
  table: [
    ['path', { d: 'M12 3v18' }],
    ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }],
    ['path', { d: 'M3 9h18' }],
    ['path', { d: 'M3 15h18' }],
  ],
  currentValue: [
    ['circle', { cx: '12', cy: '12', r: '4' }],
    ['path', { d: 'M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8' }],
  ],
  broken: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['line', { x1: '12', x2: '12', y1: '8', y2: '12' }],
    ['line', { x1: '12', x2: '12.01', y1: '16', y2: '16' }],
  ],
} as const satisfies Record<string, IconNode>;

export type ChipIcon = keyof typeof ICONS;

const BY_FIELD_TYPE: Readonly<Record<string, ChipIcon>> = {
  text: 'text',
  number: 'number',
  select: 'select',
  datetime: 'datetime',
  created_at: 'datetime',
  updated_at: 'datetime',
  checkbox: 'checkbox',
  user: 'user',
  created_by: 'user',
  updated_by: 'user',
  link: 'link',
  parent: 'link',
  attachment: 'attachment',
  auto_number: 'autoNumber',
  formula: 'formula',
  lookup: 'lookup',
};

export function fieldIcon(type: string): ChipIcon {
  return BY_FIELD_TYPE[type] ?? 'text';
}

export function iconNode(icon: ChipIcon): IconNode {
  return ICONS[icon];
}

const SVG = 'http://www.w3.org/2000/svg';

/** The icon as a DOM element (CodeMirror widgets), 12 px, stroked with the text colour. */
export function iconElement(icon: ChipIcon, size = 12): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  const attributes: Record<string, string> = {
    width: String(size),
    height: String(size),
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  };
  for (const [name, value] of Object.entries(attributes)) svg.setAttribute(name, value);
  for (const [tag, attrs] of ICONS[icon]) {
    const child = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attrs)) child.setAttribute(name, value);
    svg.append(child);
  }
  return svg;
}
