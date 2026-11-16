// A tiny DOM helper: h('div.card', { onclick }, 'text', child)

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { style?: Partial<CSSStyleDeclaration> | string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K | string, props?: Props | Child, ...children: Child[]): HTMLElement {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props as Child);
  } else if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k in el && k !== 'list' && k !== 'form') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Node) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function mount(el: Node, ...children: Child[]) {
  clear(el);
  append(el, children);
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

/** Inline SVG icon from a 24x24 path. */
export function svgIcon(d: string, cls = 'ico'): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
}

/** <dialog>.showModal arrived in Safari 15.4; fall back to a fixed panel before that. */
export function openDialog(dlg: HTMLDialogElement) {
  document.body.appendChild(dlg);
  if (typeof dlg.showModal === 'function') {
    dlg.showModal();
    return;
  }
  dlg.setAttribute('open', '');
  Object.assign(dlg.style, { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: '20', margin: '0' });
}

export function closeDialog(dlg: HTMLDialogElement) {
  if (typeof dlg.close === 'function' && dlg.open) dlg.close();
  dlg.remove();
}
