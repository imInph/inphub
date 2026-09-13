/**
 * inphub: shared UI helpers: toasts, modals, formatting, safe HTML/markdown.
 *
 * No framework: everything builds DOM directly. escapeHtml() is used on every
 * value that originates from the user, the database, or the AI before it
 * touches innerHTML. markdown() renders a deliberately small, safe subset.
 */
/* ------------------------------------------------------------------ escaping */
/** Escape a string for safe interpolation into HTML. */
export function escapeHtml(value) {
    const s = value === null || value === undefined ? '' : String(value);
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
/** Tagged template that escapes every interpolated value. */
export function html(strings, ...values) {
    return strings.reduce((out, chunk, i) => {
        const v = i < values.length ? values[i] : '';
        const safe = Array.isArray(v) ? v.join('') : escapeHtml(v);
        return out + chunk + safe;
    }, '');
}
/** Like html`` but does NOT escape, for composing already-safe fragments. */
export function raw(strings, ...values) {
    return strings.reduce((out, chunk, i) => out + chunk + (i < values.length ? String(values[i] ?? '') : ''), '');
}
/* ------------------------------------------------------------------- toasts */
let toastHost = null;
/** At most this many toasts on screen, the stack used to grow without limit. */
const TOAST_MAX = 4;
/**
 * Show a toast. `action` renders a button inside it (used for Undo), which the
 * old textContent-only implementation structurally could not hold. A toast with
 * an action lingers longer, since it asks the user to decide something.
 */
export function toast(message, kind = '', action) {
    if (!toastHost)
        toastHost = document.getElementById('toasts');
    if (!toastHost)
        return;
    while (toastHost.children.length >= TOAST_MAX)
        toastHost.firstElementChild?.remove();
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;
    el.appendChild(text);
    let timer = 0;
    const dismiss = () => {
        clearTimeout(timer);
        el.style.transition = 'opacity .2s';
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 200);
    };
    if (action) {
        const btn = document.createElement('button');
        btn.className = 'toast-action';
        btn.textContent = action.label;
        btn.addEventListener('click', () => {
            dismiss();
            action.run();
        });
        el.appendChild(btn);
    }
    // Error toasts are assertive; the polite region is for the rest.
    if (kind === 'bad')
        el.setAttribute('role', 'alert');
    toastHost.appendChild(el);
    timer = window.setTimeout(dismiss, action ? 7000 : kind === 'bad' ? 4200 : 2600);
}
/**
 * Open a modal. The body is raw HTML (build it with html`` so values are
 * escaped). Resolves after close. onConfirm returning false keeps it open.
 */
export function openModal(opts) {
    const titleId = 'modal-title-' + Math.random().toString(36).slice(2, 8);
    const returnTo = document.activeElement;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <h3 id="${titleId}">${escapeHtml(opts.title)}</h3>
      <div class="modal-body">${opts.bodyHtml}</div>
      <div class="modal-actions">
        ${opts.cancelLabel === '' ? '' : `<button class="btn" data-act="cancel">${escapeHtml(opts.cancelLabel ?? 'Cancel')}</button>`}
        <button class="btn btn-primary" data-act="confirm">${escapeHtml(opts.confirmLabel ?? 'Save')}</button>
      </div>
    </div>`;
    const close = () => {
        document.removeEventListener('keydown', onKey);
        backdrop.remove();
        // Put focus back where it came from; it used to be dropped on the body.
        returnTo?.focus?.();
    };
    /** Tab must not walk out of an aria-modal dialog into the page behind it. */
    const trap = (e) => {
        const focusable = [...backdrop.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
        if (!focusable.length)
            return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        }
        else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    };
    const onKey = (e) => {
        if (e.key === 'Escape') {
            close();
            return;
        }
        // Enter submits from a single-line field, which every editor lacked.
        if (e.key === 'Enter' && !e.shiftKey) {
            const el = document.activeElement;
            if (el && backdrop.contains(el) && el.tagName === 'INPUT') {
                e.preventDefault();
                backdrop.querySelector('[data-act="confirm"]')?.click();
                return;
            }
        }
        if (e.key === 'Tab')
            trap(e);
    };
    backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop)
            close();
    });
    backdrop.querySelector('[data-act="cancel"]')?.addEventListener('click', close);
    backdrop.querySelector('[data-act="confirm"]').addEventListener('click', async () => {
        const keep = opts.onConfirm ? await opts.onConfirm(backdrop) : undefined;
        if (keep !== false)
            close();
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    const firstField = backdrop.querySelector('input, textarea, select');
    firstField?.focus();
    return backdrop;
}
/** A simple confirm dialog; resolves true if confirmed. */
export function confirmDialog(message, confirmLabel = 'Delete') {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => {
            if (done)
                return;
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
export function money(amount, currency = 'TRY') {
    const n = typeof amount === 'string' ? parseFloat(amount) : amount;
    const value = Number.isFinite(n) ? n : 0;
    try {
        return new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency,
            maximumFractionDigits: 2,
        }).format(value);
    }
    catch {
        return `${value.toFixed(2)} ${currency}`;
    }
}
/** Human date like "17 Jul 2026". */
export function fmtDate(value) {
    if (!value)
        return '';
    const d = new Date(value.length <= 10 ? value + 'T00:00:00' : value.replace(' ', 'T'));
    if (isNaN(d.getTime()))
        return value;
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}
/**
 * Human month like "Sep 2026" from a "YYYY-MM" key.
 * Note the "-01T00:00:00": new Date('2026-09') parses as UTC midnight and
 * renders the *previous* month west of UTC, same trap as toISOString().
 */
export function fmtMonth(value) {
    if (!value)
        return '';
    const d = new Date(value + '-01T00:00:00');
    if (isNaN(d.getTime()))
        return value;
    return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}
/** Relative time like "3h ago", "2d ago". */
export function timeAgo(value) {
    if (!value)
        return '';
    const d = new Date(value.replace(' ', 'T'));
    if (isNaN(d.getTime()))
        return value;
    const secs = Math.round((Date.now() - d.getTime()) / 1000);
    if (secs < 60)
        return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60)
        return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24)
        return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    if (days < 30)
        return `${days}d ago`;
    return fmtDate(value);
}
/** A date as YYYY-MM-DD in the *local* timezone (never toISOString, that is UTC). */
export function localDate(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** A datetime as YYYY-MM-DD HH:MM:SS in the *local* timezone (matches MySQL DATETIME). */
export function localDateTime(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
/** Today's date as YYYY-MM-DD (local). */
export function todayStr() {
    return localDate(new Date());
}
/** Current month as YYYY-MM (local). */
export function monthStr(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
/**
 * Briefly highlight a row the user was sent to (a search result, a history
 * link). Scrolls only when the element is off-screen, so re-applying it after
 * an unrelated re-render is invisible rather than a jarring jump.
 */
export function flashRow(el) {
    if (!el)
        return;
    const box = el.getBoundingClientRect();
    const offScreen = box.top < 70 || box.bottom > window.innerHeight - 20;
    if (offScreen)
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Restart the animation even if the class is already present.
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
}
/**
 * Find the row for `focus` in the active route and highlight it.
 * Returns false when the row is not in the DOM, which tells the caller the
 * view's own filters are hiding it and need widening.
 */
export function flashFocused(container, focus) {
    if (!focus)
        return true;
    const el = container.querySelector(`[data-row="${CSS.escape(focus)}"]`);
    if (!el)
        return false;
    flashRow(el);
    return true;
}
/* ---------------------------------------------------------- safe markdown */
/**
 * Render a small, safe markdown subset to HTML: headings, bold/italic, inline
 * code, fenced code, links, unordered/ordered lists, paragraphs. All text is
 * escaped first, so no raw HTML from the source can survive.
 */
export function markdown(src) {
    if (!src)
        return '';
    const escaped = escapeHtml(src);
    const lines = escaped.split('\n');
    const out = [];
    let inCode = false;
    let listType = null;
    let para = [];
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
            }
            else {
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
                listType = want;
            }
            out.push('<li>' + inline((ul ? ul[1] : ol[1])) + '</li>');
            continue;
        }
        if (line.trim() === '') {
            flushPara();
            flushList();
            continue;
        }
        para.push(line);
    }
    if (inCode)
        out.push('</code></pre>');
    flushPara();
    flushList();
    return out.join('\n');
}
/** Inline markdown: bold, italic, code, links. Operates on already-escaped text. */
function inline(text) {
    return text
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
/* ------------------------------------------------------------------ helpers */
/**
 * A short, dependency-free confetti burst rendered on a throwaway canvas.
 * Purely decorative; removes itself when the animation settles.
 */
export function confetti() {
    // 150 particles over ~170 frames is exactly what this preference is for.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
        return;
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
    const bits = [];
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
        }
        else {
            canvas.remove();
        }
    };
    step();
}
/** Render a standard empty state. */
/**
 * A skeleton placeholder. Seven views hand-wrote `<div class="empty">Loading…`,
 * which is visually identical to a genuinely empty view and, being short,
 * made every view jump as content arrived.
 */
export function loadingState(rows = 3) {
    return `<div class="skeleton-wrap" aria-busy="true" aria-live="polite">
    ${Array.from({ length: rows }, () => '<div class="skeleton"></div>').join('')}
  </div>`;
}
export function emptyState(icon, message, action) {
    return `<div class="empty">${icon ? `<div class="big">${escapeHtml(icon)}</div>` : ''}
    <div>${escapeHtml(message)}</div>
    ${action ? `<button class="btn btn-primary btn-sm" style="margin-top:12px"
        data-action="${escapeHtml(action.action)}">${escapeHtml(action.label)}</button>` : ''}</div>`;
}
/** Current handler per root, lets onAction() replace instead of stack. */
const actionHandlers = new WeakMap();
/**
 * Delegate clicks within a root to elements matching [data-action].
 * Idempotent: the view containers are persistent nodes that get re-rendered
 * (innerHTML swapped) many times, so calling this again *replaces* the
 * previous handler rather than adding another listener, otherwise one click
 * would fire N stacked handlers (duplicate modals, duplicate API calls).
 */
export function onAction(root, handler) {
    const bindOnce = !actionHandlers.has(root);
    actionHandlers.set(root, handler);
    if (!bindOnce)
        return;
    root.addEventListener('click', (ev) => {
        const target = ev.target.closest('[data-action]');
        if (target && root.contains(target)) {
            actionHandlers.get(root)?.(target.dataset.action, target, ev);
        }
    });
    // Keyboard parity for the non-<button> controls (the todo checkbox is a
    // focusable <span role="checkbox">), so they are not mouse-only.
    root.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ')
            return;
        const el = e.target?.closest('[data-action][tabindex]');
        if (!el || !root.contains(el))
            return;
        e.preventDefault();
        el.click();
    });
}
/** Read a form's fields into a plain object. */
export function formValues(root) {
    const out = {};
    root.querySelectorAll('[name]').forEach((el) => {
        if (el instanceof HTMLInputElement && el.type === 'checkbox') {
            out[el.name] = el.checked ? '1' : '0';
        }
        else {
            out[el.name] = el.value;
        }
    });
    return out;
}
