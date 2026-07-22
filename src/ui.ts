/**
 * inphub — shared UI helpers: toasts, modals, formatting, safe HTML/markdown.
 *
 * No framework: everything builds DOM directly. escapeHtml() is used on every
 * value that originates from the user, the database, or the AI before it
 * touches innerHTML. markdown() renders a deliberately small, safe subset.
 */

/* ------------------------------------------------------------------ escaping */

/** Escape a string for safe interpolation into HTML. */
export function escapeHtml(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Tagged template that escapes every interpolated value. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((out, chunk, i) => {
    const v = i < values.length ? values[i] : '';
    const safe = Array.isArray(v) ? v.join('') : escapeHtml(v);
    return out + chunk + safe;
  }, '');
}

/** Like html`` but does NOT escape — for composing already-safe fragments. */
export function raw(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((out, chunk, i) => out + chunk + (i < values.length ? String(values[i] ?? '') : ''), '');
}

/* ------------------------------------------------------------------- toasts */

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: 'good' | 'bad' | '' = ''): void {
  if (!toastHost) toastHost = document.getElementById('toasts');
  if (!toastHost) return;
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 200);
  }, kind === 'bad' ? 4200 : 2600);
}

/* ------------------------------------------------------------------- modal */

export interface ModalOptions {
  title: string;
  bodyHtml: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: (root: HTMLElement) => boolean | void | Promise<boolean | void>;
  wide?: boolean;
}

/**
 * Open a modal. The body is raw HTML (build it with html`` so values are
 * escaped). Resolves after close. onConfirm returning false keeps it open.
 */
export function openModal(opts: ModalOptions): HTMLElement {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <h3>${escapeHtml(opts.title)}</h3>
      <div class="modal-body">${opts.bodyHtml}</div>
      <div class="modal-actions">
        <button class="btn" data-act="cancel">${escapeHtml(opts.cancelLabel ?? 'Cancel')}</button>
        <button class="btn btn-primary" data-act="confirm">${escapeHtml(opts.confirmLabel ?? 'Save')}</button>
      </div>
    </div>`;

  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };

  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector('[data-act="cancel"]')!.addEventListener('click', close);
  backdrop.querySelector('[data-act="confirm"]')!.addEventListener('click', async () => {
    const keep = opts.onConfirm ? await opts.onConfirm(backdrop) : undefined;
    if (keep !== false) close();
  });
  document.addEventListener('keydown', onKey);

  document.body.appendChild(backdrop);
  const firstField = backdrop.querySelector<HTMLElement>('input, textarea, select');
  firstField?.focus();
  return backdrop;
}

/** A simple confirm dialog; resolves true if confirmed. */
export function confirmDialog(message: string, confirmLabel = 'Delete'): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const root = openModal({
      title: 'Are you sure?',
      bodyHtml: `<p>${escapeHtml(message)}</p>`,
      confirmLabel,
      onConfirm: () => {
        finish(true);
      },
    });
    // Resolve false when the backdrop is removed without confirming.
    const observer = new MutationObserver(() => {
      if (!document.body.contains(root)) {
        observer.disconnect();
        finish(false);
      }
    });
    observer.observe(document.body, { childList: true });
  });
}

/* --------------------------------------------------------------- formatting */

/** Format a number as money with the given currency (symbol-ish). */
export function money(amount: number | string, currency = 'TRY'): string {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  const value = Number.isFinite(n) ? n : 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

/** Human date like "17 Jul 2026". */
export function fmtDate(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value.length <= 10 ? value + 'T00:00:00' : value.replace(' ', 'T'));
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Relative time like "3h ago", "2d ago". */
export function timeAgo(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value.replace(' ', 'T'));
  if (isNaN(d.getTime())) return value;
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return fmtDate(value);
}

/** Today's date as YYYY-MM-DD (local). */
export function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Current month as YYYY-MM (local). */
export function monthStr(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/* ---------------------------------------------------------- safe markdown */

/**
 * Render a small, safe markdown subset to HTML: headings, bold/italic, inline
 * code, fenced code, links, unordered/ordered lists, paragraphs. All text is
 * escaped first, so no raw HTML from the source can survive.
 */
export function markdown(src: string): string {
  if (!src) return '';
  const escaped = escapeHtml(src);
  const lines = escaped.split('\n');
  const out: string[] = [];
  let inCode = false;
  let listType: 'ul' | 'ol' | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push('<p>' + inline(para.join(' ')) + '</p>');
      para = [];
    }
  };
  const flushList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const line of lines) {
    const fence = line.trim().startsWith('```');
    if (fence) {
      flushPara();
      flushList();
      if (!inCode) {
        out.push('<pre><code>');
        inCode = true;
      } else {
        out.push('</code></pre>');
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      out.push(line + '\n');
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (listType !== want) {
        flushList();
        out.push(`<${want}>`);
        listType = want as 'ul' | 'ol';
      }
      out.push('<li>' + inline((ul ? ul[1] : ol![1])) + '</li>');
      continue;
    }

    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }
    para.push(line);
  }
  if (inCode) out.push('</code></pre>');
  flushPara();
  flushList();
  return out.join('\n');
}

/** Inline markdown: bold, italic, code, links. Operates on already-escaped text. */
function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(
      /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>',
    );
}

/* ------------------------------------------------------------------ helpers */

/** Mount safe HTML into a container element. */
export function mount(container: HTMLElement, innerHtml: string): void {
  container.innerHTML = innerHtml;
}

/**
 * A short, dependency-free confetti burst rendered on a throwaway canvas.
 * Purely decorative; removes itself when the animation settles.
 */
export function confetti(): void {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:200';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return;
  }

  const colors = ['#4f8cff', '#22c55e', '#eab308', '#ef4444', '#a855f7', '#ffffff'];
  interface Bit { x: number; y: number; vx: number; vy: number; r: number; c: string; rot: number; vr: number; }
  const bits: Bit[] = [];
  for (let i = 0; i < 150; i++) {
    bits.push({
      x: canvas.width / 2,
      y: canvas.height / 3,
      vx: (Math.random() - 0.5) * 14,
      vy: Math.random() * -13 - 4,
      r: Math.random() * 6 + 4,
      c: colors[Math.floor(Math.random() * colors.length)],
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.35,
    });
  }

  let frame = 0;
  const step = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const b of bits) {
      b.vy += 0.3;
      b.x += b.vx;
      b.y += b.vy;
      b.rot += b.vr;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.r / 2, -b.r / 2, b.r, b.r * 0.6);
      ctx.restore();
    }
    if (++frame < 170) {
      requestAnimationFrame(step);
    } else {
      canvas.remove();
    }
  };
  step();
}

/** Render a standard empty state. */
export function emptyState(icon: string, message: string): string {
  return `<div class="empty"><div class="big">${escapeHtml(icon)}</div><div>${escapeHtml(message)}</div></div>`;
}

/** Delegate clicks within a root to elements matching [data-action]. */
export function onAction(
  root: HTMLElement,
  handler: (action: string, el: HTMLElement, ev: Event) => void,
): void {
  root.addEventListener('click', (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (target && root.contains(target)) {
      handler(target.dataset.action!, target, ev);
    }
  });
}

/** Read a form's fields into a plain object. */
export function formValues(root: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[name]').forEach((el) => {
    if (el instanceof HTMLInputElement && el.type === 'checkbox') {
      out[el.name] = el.checked ? '1' : '0';
    } else {
      out[el.name] = el.value;
    }
  });
  return out;
}
