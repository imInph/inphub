/**
 * inphub: the dashboard's Customize sheet.
 *
 * Two tabs. Widgets: switch each on or off, drag (or use the arrows) to set the
 * order, pick Normal or Wide. Shortcuts: rename, reorder, add, remove. One Save
 * writes both settings in a single request.
 */
import { apiPost } from './api.js?v=a03b746989';
import { escapeHtml, openModal, toast, sortable } from './ui.js?v=a03b746989';
import { aiAvailable } from './app.js?v=a03b746989';
import { icon } from './icons.js?v=a03b746989';
import { WIDGETS, defaultLayout, isWidgetId, } from './widgets.js?v=a03b746989';
export function openWidgetPicker(layout, shortcuts, onSaved) {
    const root = openModal({
        title: 'Customize dashboard',
        confirmLabel: 'Save',
        size: 'lg',
        bodyHtml: `
      <div class="segmented segmented-block" role="tablist">
        <button type="button" class="on" data-tab="widgets" role="tab" aria-selected="true">Widgets</button>
        <button type="button" data-tab="shortcuts" role="tab" aria-selected="false">Shortcuts</button>
      </div>
      <div data-pane="widgets">
        <p class="pick-hint">Drag ${icon('grip', 14)} to reorder. Widgets pack together automatically, so there are no gaps.</p>
        <ul class="pick-list" data-role="pick-widgets">${widgetRows(layout)}</ul>
        <button type="button" class="btn btn-ghost btn-sm" data-role="reset">Reset to default</button>
      </div>
      <div data-pane="shortcuts" hidden>
        <p class="pick-hint">These sit in the rail beside your widgets.</p>
        <ul class="pick-list" data-role="pick-shortcuts">${shortcuts.map(shortcutRow).join('')}</ul>
        <button type="button" class="btn btn-sm" data-role="add-shortcut">${icon('plus', 14)} Add shortcut</button>
      </div>`,
        onConfirm: async (modal) => {
            const nextShortcuts = readShortcuts(modal);
            if (!nextShortcuts)
                return false;
            try {
                await apiPost('settings', 'save', {
                    settings: {
                        dashboard_widgets: JSON.stringify(readLayout(modal)),
                        dashboard_shortcuts: JSON.stringify(nextShortcuts),
                    },
                });
                toast('Dashboard updated.', 'good');
                onSaved();
            }
            catch (e) {
                toast(e instanceof Error ? e.message : 'Could not save.', 'bad');
                return false;
            }
        },
    });
    const widgetList = root.querySelector('[data-role="pick-widgets"]');
    const shortcutList = root.querySelector('[data-role="pick-shortcuts"]');
    const refreshMoves = () => {
        [widgetList, shortcutList].forEach((list) => {
            const rows = [...list.querySelectorAll(':scope > [data-sort]')];
            rows.forEach((row, i) => {
                row.querySelector('[data-move="-1"]').disabled = i === 0;
                row.querySelector('[data-move="1"]').disabled = i === rows.length - 1;
            });
        });
    };
    sortable(widgetList, refreshMoves);
    sortable(shortcutList, refreshMoves);
    refreshMoves();
    // The modal element is created fresh per open, so direct listeners are fine.
    root.addEventListener('click', (e) => {
        const t = e.target;
        const tab = t.closest('[data-tab]');
        if (tab) {
            root.querySelectorAll('[data-tab]').forEach((b) => {
                const on = b === tab;
                b.classList.toggle('on', on);
                b.setAttribute('aria-selected', String(on));
            });
            root.querySelectorAll('[data-pane]').forEach((p) => {
                p.hidden = p.dataset.pane !== tab.dataset.tab;
            });
            return;
        }
        const size = t.closest('[data-size]');
        if (size) {
            size.parentElement?.querySelectorAll('[data-size]').forEach((b) => {
                b.classList.toggle('on', b === size);
                b.setAttribute('aria-pressed', String(b === size));
            });
            return;
        }
        if (t.closest('[data-role="reset"]')) {
            widgetList.innerHTML = widgetRows(defaultLayout());
            refreshMoves();
            return;
        }
        if (t.closest('[data-role="add-shortcut"]')) {
            shortcutList.insertAdjacentHTML('beforeend', shortcutRow({ name: '', url: '' }));
            refreshMoves();
            shortcutList.querySelector(':scope > [data-sort]:last-child input[name="sc-name"]')?.focus();
            return;
        }
        const del = t.closest('[data-role="del-shortcut"]');
        if (del) {
            del.closest('[data-sort]')?.remove();
            refreshMoves();
        }
    });
    root.addEventListener('change', (e) => {
        const sw = e.target.closest('input[data-role="on"]');
        sw?.closest('[data-sort]')?.classList.toggle('off', !sw.checked);
    });
}
/** Enabled widgets first, in the saved order, then the rest in registry order. */
function widgetRows(layout) {
    const enabled = layout.filter((l) => isWidgetId(l.id));
    const on = new Set(enabled.map((l) => l.id));
    const rest = Object.keys(WIDGETS)
        .filter((id) => !on.has(id))
        .map((id) => ({ id, size: WIDGETS[id].size, off: true }));
    return [...enabled.map((l) => ({ ...l, off: false })), ...rest].map(({ id, size, off }) => {
        const def = WIDGETS[id];
        const needsAi = def.aiOnly && !aiAvailable;
        return `<li class="pick-row ${off ? 'off' : ''}" data-sort data-id="${id}">
      <button type="button" class="pick-handle" data-handle aria-label="Drag to reorder">${icon('grip', 18)}</button>
      <span class="widget-ico tint-${def.tint}">${icon(def.icon, 16)}</span>
      <span class="pick-text"><strong>${escapeHtml(def.title)}${needsAi ? ' <span class="chip">AI off</span>' : ''}</strong>
        <small>${escapeHtml(def.desc)}</small></span>
      <span class="segmented segmented-sm" role="group" aria-label="Size">
        <button type="button" data-size="normal" class="${size === 'normal' ? 'on' : ''}" aria-pressed="${size === 'normal'}">Normal</button>
        <button type="button" data-size="wide" class="${size === 'wide' ? 'on' : ''}" aria-pressed="${size === 'wide'}">Wide</button>
      </span>
      <label class="switch" title="Show on dashboard"><input type="checkbox" data-role="on" ${off ? '' : 'checked'}
        aria-label="Show ${escapeHtml(def.title)}"></label>
      ${moveButtons()}
    </li>`;
    }).join('');
}
function shortcutRow(s) {
    return `<li class="pick-row" data-sort>
    <button type="button" class="pick-handle" data-handle aria-label="Drag to reorder">${icon('grip', 18)}</button>
    <span class="pick-fields">
      <input name="sc-name" value="${escapeHtml(s.name)}" placeholder="Name" autocomplete="off" aria-label="Shortcut name">
      <input name="sc-url" value="${escapeHtml(s.url)}" placeholder="github.com" autocomplete="off" aria-label="Shortcut URL">
    </span>
    ${moveButtons()}
    <button type="button" class="btn btn-ghost btn-icon" data-role="del-shortcut" aria-label="Remove shortcut">${icon('close', 16)}</button>
  </li>`;
}
function moveButtons() {
    return `<span class="pick-move">
    <button type="button" class="btn btn-ghost btn-icon" data-move="-1" aria-label="Move up">${icon('up', 14)}</button>
    <button type="button" class="btn btn-ghost btn-icon" data-move="1" aria-label="Move down">${icon('down', 14)}</button>
  </span>`;
}
function readLayout(modal) {
    return [...modal.querySelectorAll('[data-role="pick-widgets"] > [data-sort]')]
        .filter((row) => row.querySelector('input[data-role="on"]')?.checked)
        .map((row) => ({
        id: row.dataset.id,
        size: row.querySelector('[data-size].on')?.dataset.size === 'wide' ? 'wide' : 'normal',
    }));
}
/** The shortcut rows as data, or null (with a toast) when one is half filled. */
function readShortcuts(modal) {
    const out = [];
    for (const row of modal.querySelectorAll('[data-role="pick-shortcuts"] > [data-sort]')) {
        const name = row.querySelector('input[name="sc-name"]').value.trim();
        let url = row.querySelector('input[name="sc-url"]').value.trim();
        if (!name && !url)
            continue;
        if (!name || !url) {
            toast('Each shortcut needs both a name and a URL.', 'bad');
            return null;
        }
        if (!/^https?:\/\//i.test(url))
            url = 'https://' + url;
        out.push({ name, url });
    }
    return out;
}
