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
    <div class="modal${opts.size === 'lg' ? ' modal-lg' : ''}" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
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
/**
 * A per-page random marker put on the checkboxes marked generates, so they can
 * be told apart from any <input type=checkbox> written as raw HTML. Only real
 * task-list items may become clickable, the toggle edits the source by index.
 */
const TASK_MARK = 'inphub-task-' + Math.random().toString(36).slice(2, 10);
/** Classes markdown output may keep: code languages and footnote markup. */
const SAFE_CLASS = /^(language-[\w+#-]+|footnotes|sr-only)$/;
let parser = null;
function markdownParser() {
    if (parser)
        return parser;
    const lib = window.marked;
    if (!lib)
        return null;
    parser = new lib.Marked({ gfm: true, breaks: true, silent: true });
    if (window.markedFootnote)
        parser.use(window.markedFootnote());
    parser.use({
        renderer: {
            checkbox({ checked }) {
                return `<input type="checkbox" class="${TASK_MARK}"${checked ? ' checked' : ''} disabled> `;
            },
        },
    });
    return parser;
}
/**
 * Render markdown (GitHub flavour: tables, task lists, strikethrough,
 * footnotes, autolinks, raw HTML…) to safe HTML.
 *
 * marked parses, DOMPurify sanitises, then a DOM pass adds what sanitising
 * cannot: link targets, lazy images, embedded players and task checkboxes.
 * Used for notes, chat replies, the daily brief, the weekly review and repo
 * READMEs, which come from GitHub, so the sanitiser settings matter:
 * - data-* attributes are stripped, or content could carry `data-action` and
 *   fire the view's delegated onAction() handler (delete, pin…) on click;
 * - ids/names are prefixed (SANITIZE_NAMED_PROPS) so an `id="toasts"` cannot
 *   shadow the app's own nodes;
 * - style, forms and iframes are forbidden; the only iframes are the embeds
 *   built below from a parsed video/track id, never from the raw URL.
 */
export function markdown(src, opts = {}) {
    if (!src)
        return '';
    const md = markdownParser();
    const purify = window.DOMPurify;
    if (!md || !purify) {
        // Vendor scripts missing (bad copy): plain text, never unsanitised HTML.
        return `<p>${escapeHtml(src).replace(/\n/g, '<br>')}</p>`;
    }
    installAnchorHandler();
    const frag = purify.sanitize(md.parse(src, { async: false }), {
        RETURN_DOM_FRAGMENT: true,
        SANITIZE_NAMED_PROPS: true,
        ALLOW_DATA_ATTR: false,
        FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'option', 'iframe', 'frame', 'frameset',
            'object', 'embed', 'link', 'meta', 'base', 'dialog'],
        FORBID_ATTR: ['style', 'tabindex', 'autofocus'],
    });
    frag.querySelectorAll('input').forEach((input) => {
        if (input.type !== 'checkbox')
            input.remove();
    });
    // Raw HTML may not borrow the app's own classes: `<div class="palette">`
    // in a README would be a fixed full-screen overlay. Keep only the classes
    // marked and the footnote extension emit.
    frag.querySelectorAll('[class]').forEach((el) => {
        const keep = [...el.classList].filter((c) => SAFE_CLASS.test(c) || c === TASK_MARK);
        if (keep.length)
            el.setAttribute('class', keep.join(' '));
        else
            el.removeAttribute('class');
    });
    frag.querySelectorAll('a[href]').forEach((a) => {
        if ((a.getAttribute('href') ?? '').startsWith('#'))
            return; // footnotes, in-note anchors
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
    });
    frag.querySelectorAll('img').forEach((img) => {
        img.loading = 'lazy';
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
    });
    let taskIndex = 0;
    frag.querySelectorAll('input[type="checkbox"]').forEach((box) => {
        const real = box.classList.contains(TASK_MARK);
        box.className = real ? 'md-task' : '';
        box.disabled = true;
        if (!real)
            return;
        box.closest('li')?.classList.add('md-task-item');
        if (opts.tasks) {
            box.disabled = false;
            box.setAttribute('data-task-index', String(taskIndex));
            box.setAttribute('data-action', 'md-task');
            box.setAttribute('aria-label', 'Toggle task');
        }
        taskIndex++;
    });
    if (opts.embeds !== false) {
        frag.querySelectorAll('p').forEach((p) => {
            const nodes = [...p.childNodes].filter((n) => !(n.nodeType === Node.TEXT_NODE && !n.textContent?.trim()));
            const a = nodes.length === 1 && nodes[0] instanceof HTMLAnchorElement ? nodes[0] : null;
            if (!a || a.textContent?.trim() !== a.getAttribute('href'))
                return; // bare links only
            const embed = buildEmbed(a.href);
            if (embed)
                p.replaceWith(embed);
        });
    }
    const host = document.createElement('div');
    host.appendChild(frag);
    return host.innerHTML;
}
/**
 * A player for a supported link, or null. The iframe src is assembled from an
 * id matched out of the URL, so nothing else from the link reaches it.
 */
function buildEmbed(href) {
    let url;
    try {
        url = new URL(href);
    }
    catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
        return null;
    const host = url.hostname.replace(/^(www|m|music)\./, '');
    const path = url.pathname;
    let src = '';
    let kind = 'video';
    if (host === 'youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com') {
        const id = host === 'youtu.be'
            ? path.slice(1).split('/')[0]
            : url.searchParams.get('v') ?? path.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/)?.[1] ?? '';
        if (!/^[A-Za-z0-9_-]{6,20}$/.test(id))
            return null;
        const start = youtubeStart(url.searchParams.get('t') ?? url.searchParams.get('start'));
        src = `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}`;
    }
    else if (host === 'vimeo.com' || host === 'player.vimeo.com') {
        const id = path.match(/(?:^|\/)(\d{5,12})(?:$|\/)/)?.[1];
        if (!id)
            return null;
        src = `https://player.vimeo.com/video/${id}`;
    }
    else if (host === 'open.spotify.com') {
        const m = path.match(/^\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{10,40})/);
        if (!m)
            return null;
        src = `https://open.spotify.com/embed/${m[1]}/${m[2]}`;
        kind = m[1] === 'track' || m[1] === 'episode' ? 'audio' : 'audio-tall';
    }
    else if (host === 'soundcloud.com') {
        if (!/^\/[\w-]+\/[\w-]+/.test(path))
            return null;
        src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(`https://soundcloud.com${path}`)}&visual=false`;
        kind = 'audio';
    }
    else {
        return null;
    }
    const wrap = document.createElement('div');
    wrap.className = `md-embed md-embed-${kind}`;
    const frame = document.createElement('iframe');
    frame.src = src;
    frame.title = 'Embedded player';
    frame.loading = 'lazy';
    // YouTube refuses to play without a referrer; strict-origin sends only the origin.
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups');
    frame.setAttribute('allow', 'encrypted-media; picture-in-picture; fullscreen; clipboard-write');
    frame.setAttribute('allowfullscreen', '');
    wrap.appendChild(frame);
    return wrap;
}
/** YouTube's t= / start= ("90", "90s", "1m30s", "1h2m3s") as whole seconds. */
function youtubeStart(value) {
    if (!value)
        return 0;
    if (/^\d+$/.test(value))
        return Number(value);
    const m = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}
let anchorHandler = false;
/**
 * In-note anchors (footnotes, `[see](#section)`) would otherwise change
 * location.hash, which is the SPA's router: the click would navigate to the
 * dashboard. Scroll to the target inside the same rendered block instead, so
 * two notes on one page with the same footnote ids never cross over.
 */
function installAnchorHandler() {
    if (anchorHandler)
        return;
    anchorHandler = true;
    document.addEventListener('click', (e) => {
        const a = e.target?.closest?.('.md a[href^="#"]');
        if (!a)
            return;
        e.preventDefault();
        const id = decodeURIComponent((a.getAttribute('href') ?? '').slice(1));
        const root = a.closest('.md');
        if (!id || !root)
            return;
        const target = root.querySelector(`[id="${CSS.escape('user-content-' + id)}"]`)
            ?? root.querySelector(`[id="${CSS.escape(id)}"]`);
        target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
}
/**
 * Flip the n-th `- [ ]` / `- [x]` marker in markdown source. Markers inside
 * fenced code blocks are skipped, exactly as marked skips them, so index n is
 * the n-th clickable checkbox markdown() rendered. Returns null when the source
 * has a different number of tasks than were rendered (an edge case such as an
 * indented code block), so a toggle can never edit the wrong line.
 */
export function toggleMarkdownTask(src, index, renderedCount) {
    const lines = src.split('\n');
    const hits = [];
    let fence = null;
    lines.forEach((line, i) => {
        const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
        if (f) {
            if (fence === null)
                fence = f[1][0];
            else if (f[1][0] === fence)
                fence = null;
            return;
        }
        if (fence === null && /^(\s*>)*\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\](?=\s|$)/.test(line))
            hits.push(i);
    });
    if (hits.length !== renderedCount || index < 0 || index >= hits.length)
        return null;
    const at = hits[index];
    lines[at] = lines[at].replace(/\[([ xX])\]/, (_m, mark) => (mark === ' ' ? '[x]' : '[ ]'));
    return lines.join('\n');
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
/* --------------------------------------------------------------- sortable */
/**
 * Make the direct children of `list` reorderable by dragging their
 * `[data-handle]`. Pointer events rather than HTML5 drag-and-drop, which never
 * fires for touch. Buttons with `data-move="-1|1"` inside a child move it one
 * step, for keyboards. `onChange` runs after every reorder.
 *
 * Binds to `list` itself, so call it once per freshly built list node.
 */
export function sortable(list, onChange) {
    let dragging = null;
    let pointerId = -1;
    let offsetY = 0;
    const items = () => [...list.children].filter((c) => c instanceof HTMLElement && c.dataset.sort !== undefined);
    list.addEventListener('pointerdown', (e) => {
        const handle = e.target.closest('[data-handle]');
        const item = handle?.closest('[data-sort]');
        if (!handle || !item || item.parentElement !== list || e.button !== 0)
            return;
        e.preventDefault();
        dragging = item;
        pointerId = e.pointerId;
        offsetY = e.clientY - item.getBoundingClientRect().top;
        handle.setPointerCapture(e.pointerId);
        item.classList.add('dragging');
    });
    list.addEventListener('pointermove', (e) => {
        if (!dragging || e.pointerId !== pointerId)
            return;
        const y = e.clientY;
        const siblings = items().filter((c) => c !== dragging);
        // Insert before the first sibling whose midpoint is below the pointer.
        const before = siblings.find((c) => {
            const r = c.getBoundingClientRect();
            return y - offsetY + dragging.offsetHeight / 2 < r.top + r.height / 2;
        });
        if (before) {
            if (dragging.nextElementSibling !== before)
                list.insertBefore(dragging, before);
        }
        else if (siblings.length) {
            const lastItem = siblings[siblings.length - 1];
            if (lastItem.nextElementSibling !== dragging)
                lastItem.after(dragging);
        }
    });
    const end = (e) => {
        if (!dragging || e.pointerId !== pointerId)
            return;
        dragging.classList.remove('dragging');
        dragging = null;
        pointerId = -1;
        onChange();
    };
    list.addEventListener('pointerup', end);
    list.addEventListener('pointercancel', end);
    list.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-move]');
        const item = btn?.closest('[data-sort]');
        if (!btn || !item || item.parentElement !== list)
            return;
        e.preventDefault();
        const all = items();
        const to = all.indexOf(item) + Number(btn.dataset.move);
        if (to < 0 || to >= all.length)
            return;
        if (Number(btn.dataset.move) < 0)
            all[to].before(item);
        else
            all[to].after(item);
        btn.focus();
        onChange();
    });
}
/* -------------------------------------------------------------- sparkline */
/**
 * A tiny inline-SVG line (+ soft fill) for a widget. Strokes currentColor, so
 * the caller colours it with CSS and it follows the theme with no redraw.
 */
export function sparkline(values, width = 240, height = 56) {
    if (values.length < 2)
        return '';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const pad = 3;
    const pts = values.map((v, i) => [
        (i / (values.length - 1)) * width,
        pad + (1 - (v - min) / span) * (height - pad * 2),
    ]);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${line} L${width} ${height} L0 ${height} Z" fill="currentColor" opacity=".12"/>
    <path d="${line}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}
