/**
 * inphub: dashboard: Google search (with suggestions, dash-search.ts), a gap-free widget grid, and a shortcuts
 * rail, all stitched from one stats.php?action=dashboard call.
 *
 * Which widgets show, their order and their size come from the user's
 * `dashboard_widgets` setting (edited in widget-picker.ts). The widgets
 * themselves live in widgets.ts.
 */
import { apiGet, apiPost } from './api.js?v=c10f314afe';
import { escapeHtml, toast, onAction, openModal, formValues, loadingState } from './ui.js?v=c10f314afe';
import { go } from './app.js?v=c10f314afe';
import { icon } from './icons.js?v=c10f314afe';
import { WIDGETS, widgetShell, widgetAvailable, isWidgetId, setCaptureMode, generateBrief, clearBrief, abortBrief, } from './widgets.js?v=c10f314afe';
import { openWidgetPicker } from './widget-picker.js?v=c10f314afe';
import { mountDashSearch } from './dash-search.js?v=c10f314afe';
let data = null;
let shortcuts = [];
export async function renderDashboard(container) {
    abortBrief();
    // Only the very first paint shows a skeleton; later re-renders (habit tick,
    // capture, data-changed) swap in place instead of flashing the whole page.
    const firstPaint = !data;
    if (firstPaint)
        container.innerHTML = loadingState();
    const d = await apiGet('stats', 'dashboard');
    data = d;
    shortcuts = Array.isArray(d.shortcuts) ? d.shortcuts : [];
    const rerender = () => renderDashboard(container);
    // A background re-render must not wipe a half-typed search.
    const prevSearch = container.querySelector('[data-role="search"]');
    const keepSearch = prevSearch ? { value: prevSearch.value, focused: document.activeElement === prevSearch } : null;
    const layout = (Array.isArray(d.layout) ? d.layout : []).filter((l) => isWidgetId(l.id) && widgetAvailable(l.id));
    container.innerHTML = `
    <div class="dash${firstPaint ? ' dash-enter' : ''}">
      <div class="dash-top">
        <form class="dash-search" action="https://www.google.com/search" method="get" target="_self" role="search">
          <span class="dash-search-ico">${icon('search', 18)}</span>
          <input type="text" name="q" placeholder="Search Google" autocomplete="off" spellcheck="false" data-role="search" aria-label="Search Google"
                 role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="dash-suggest">
          <div class="dash-suggest palette-list" id="dash-suggest" data-role="suggest" role="listbox" aria-label="Suggestions" hidden></div>
        </form>
        <button class="btn btn-glass btn-icon dash-customize" data-action="customize" title="Customize dashboard" aria-label="Customize dashboard">
          ${icon('customize', 20)}</button>
      </div>
      <div class="dash-body">
        <div class="dash-widgets" data-role="widgets">
          ${layout.length
        ? layout.map((l, i) => {
            const def = WIDGETS[l.id];
            return widgetShell(l.id, def, l.size, i, def.render(d));
        }).join('')
        : `<div class="card dash-empty">
                 <div>No widgets on your dashboard.</div>
                 <button class="btn btn-primary btn-sm" data-action="customize">Add widgets</button>
               </div>`}
        </div>
        <aside class="dash-rail" aria-label="Shortcuts">
          <div class="rail-list" data-role="shortcuts">${renderShortcuts()}</div>
        </aside>
      </div>
    </div>`;
    mountDashSearch(container, keepSearch);
    const grid = container.querySelector('[data-role="widgets"]');
    masonry(grid);
    layout.forEach((l) => WIDGETS[l.id].mount?.(container, rerender));
    onAction(container, (action, el, ev) => {
        if (action === 'goto') {
            const focus = el.dataset.focus;
            go(el.dataset.view, focus ? { focus } : undefined);
        }
        if (action === 'customize')
            openWidgetPicker(data?.layout ?? [], shortcuts, () => void rerender());
        if (action === 'toggle-habit')
            toggleHabit(container, Number(el.dataset.id));
        if (action === 'capture-mode')
            setCaptureMode(container, el.dataset.mode ?? 'todo', rerender);
        if (action === 'gen-brief')
            generateBrief(container);
        if (action === 'clear-brief')
            clearBrief(container);
        if (action === 'add-shortcut')
            addShortcut(container);
        if (action === 'del-shortcut') {
            ev.preventDefault();
            ev.stopPropagation();
            removeShortcut(container, Number(el.dataset.idx));
        }
    });
}
/* ---------------------------------------------------------------- masonry */
/** Grid row unit in px; must match `grid-auto-rows` on .dash-widgets. */
const ROW_UNIT = 4;
/** Narrowest a widget column may get before the grid drops a column. */
const MIN_COLUMN = 270;
let observer = null;
/**
 * Pack widgets with no vertical holes. Each widget spans as many 4px grid rows
 * as its content needs, so a short widget no longer reserves the height of a
 * tall neighbour. The column count is derived from the width here (rather than
 * CSS auto-fill) because a Wide widget has to know whether two columns exist.
 *
 * A Wide widget can still leave a hole above it in the shorter column, and
 * `dense` only back-fills it when a later widget happens to fit. So a second
 * pass stretches whichever widget sits above a hole down to meet the next one.
 *
 * The observer is module-level and replaced on every render: the grid node is
 * rebuilt each time, and an observer left on detached nodes would leak.
 */
function masonry(grid) {
    observer?.disconnect();
    let width = -1;
    let frame = 0;
    const gap = () => parseFloat(getComputedStyle(grid).columnGap) || 16;
    const widgets = () => [...grid.querySelectorAll(':scope > .widget')];
    const pack = () => {
        frame = 0;
        const w = grid.clientWidth;
        if (!w)
            return; // hidden view; the observer re-packs once it is shown
        const g = gap();
        if (w !== width) {
            width = w;
            const cols = Math.max(1, Math.floor((w + g) / (MIN_COLUMN + g)));
            grid.style.setProperty('--cols', String(cols));
            widgets().forEach((el) => {
                el.style.gridColumn = el.dataset.size === 'wide' && cols > 1 ? 'span 2' : '';
            });
        }
        // Pass 1: span from content.
        const items = widgets();
        const base = new Map();
        items.forEach((el) => {
            const inner = el.firstElementChild;
            const rows = Math.max(1, Math.ceil(((inner?.getBoundingClientRect().height ?? 0) + g) / ROW_UNIT));
            base.set(el, rows);
            el.style.gridRowEnd = `span ${rows}`;
        });
        // Pass 2: stretch into holes. Compare each widget with the nearest one
        // below it that shares a column; anything more than a row of slack is a hole.
        const rects = items.map((el) => ({ el, r: el.getBoundingClientRect() }));
        rects.forEach(({ el, r }) => {
            let below = Infinity;
            rects.forEach(({ el: other, r: o }) => {
                if (other === el)
                    return;
                const overlaps = o.left < r.right - 1 && o.right > r.left + 1;
                if (overlaps && o.top >= r.bottom - 1)
                    below = Math.min(below, o.top);
            });
            if (below === Infinity)
                return; // bottom of its column, ragged ends are fine
            const slack = below - r.bottom - g; // r.bottom excludes the margin gap
            if (slack >= ROW_UNIT) {
                el.style.gridRowEnd = `span ${base.get(el) + Math.floor(slack / ROW_UNIT)}`;
            }
        });
    };
    const schedule = () => {
        if (!frame)
            frame = requestAnimationFrame(pack);
    };
    // Synchronous first pass, so the first frame is already packed.
    pack();
    observer = new ResizeObserver((entries) => {
        // Our own stretching resizes the widget boxes, never the inner content,
        // so only real content or width changes land here.
        if (entries.some((e) => e.target === grid ? grid.clientWidth !== width : true))
            schedule();
    });
    observer.observe(grid);
    grid.querySelectorAll('.widget-inner').forEach((inner) => observer.observe(inner));
}
/* -------------------------------------------------------------- shortcuts */
function renderShortcuts() {
    const tiles = shortcuts.map((s, i) => {
        let host = '';
        try {
            host = new URL(s.url).hostname;
        }
        catch {
            host = '';
        }
        const letter = escapeHtml((s.name[0] || '?').toUpperCase());
        const fav = host
            ? `<span class="fav" data-letter="${letter}"><img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64"
           alt="" loading="lazy" onerror="this.parentNode.textContent=this.parentNode.dataset.letter"></span>`
            : `<span class="fav">${letter}</span>`;
        return `<a class="rail-tile" href="${escapeHtml(s.url)}" target="_blank" rel="noopener" title="${escapeHtml(s.name)} · ${escapeHtml(s.url)}">
      ${fav}
      <span class="sc-name">${escapeHtml(s.name)}</span>
      <button class="shortcut-del" data-action="del-shortcut" data-idx="${i}" title="Remove" aria-label="Remove ${escapeHtml(s.name)}">${icon('close', 12)}</button>
    </a>`;
    }).join('');
    return `${tiles}
    <button class="rail-tile rail-add" data-action="add-shortcut" title="Add a site">
      <span class="fav">${icon('plus', 20)}</span><span class="sc-name">Add</span>
    </button>`;
}
function addShortcut(container) {
    openModal({
        title: 'Add shortcut',
        confirmLabel: 'Add',
        bodyHtml: `
      <label><span>Name</span><input name="name" placeholder="GitHub" autocomplete="off"></label>
      <label><span>URL</span><input name="url" placeholder="github.com" autocomplete="off"></label>`,
        onConfirm: async (root) => {
            const v = formValues(root);
            const name = v.name.trim();
            let url = v.url.trim();
            if (!name || !url) {
                toast('Name and URL are required.', 'bad');
                return false;
            }
            if (!/^https?:\/\//i.test(url))
                url = 'https://' + url;
            shortcuts.push({ name, url });
            await saveShortcuts(container);
        },
    });
}
async function removeShortcut(container, idx) {
    if (idx < 0 || idx >= shortcuts.length)
        return;
    shortcuts.splice(idx, 1);
    await saveShortcuts(container);
}
async function saveShortcuts(container) {
    const host = container.querySelector('[data-role="shortcuts"]');
    if (host)
        host.innerHTML = renderShortcuts();
    if (data)
        data.shortcuts = shortcuts;
    try {
        await apiPost('settings', 'save', { settings: { dashboard_shortcuts: JSON.stringify(shortcuts) } });
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Could not save shortcuts', 'bad');
    }
}
/* ---------------------------------------------------------------- helpers */
async function toggleHabit(container, id) {
    try {
        await apiPost('habits', 'log', { id });
        await renderDashboard(container);
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
    }
}
