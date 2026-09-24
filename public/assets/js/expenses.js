/**
 * inphub: money: period-scoped totals, ledger with filters, category manager,
 * Chart.js donut + line, budget bars. Chart.js is a global loaded from CDN.
 *
 * One period selector scopes the totals, both charts and the ledger. Two things
 * deliberately ignore it: "Current net" is always all-time (money in your wallet
 * does not reset on the 1st) and Budgets are always the current calendar month
 * (a monthly_budget only means anything against a month).
 */
import { apiGet, apiPost } from './api.js?v=e4ef27a132';
import { escapeHtml, money, fmtDate, fmtMonth, todayStr, emptyState, toast, onAction, openModal, formValues, confirmDialog, flashFocused, } from './ui.js?v=e4ef27a132';
import { currentParams } from './app.js?v=e4ef27a132';
import { opts } from './todos.js?v=e4ef27a132';
/** Selectable windows, server-side keys in Money.Periods (server/Core/Money.cs). */
const PERIODS = [
    ['month', 'This month'],
    ['last_month', 'Last month'],
    ['3m', 'Last 3 months'],
    ['6m', 'Last 6 months'],
    ['year', 'This year'],
    ['all', 'All time'],
];
const PERIOD_KEY = 'inphub.money.period';
/** Last choice wins across reloads; an unknown stored value falls back. */
function storedPeriod() {
    try {
        const v = localStorage.getItem(PERIOD_KEY);
        if (v && PERIODS.some(([k]) => k === v))
            return v;
    }
    catch {
        /* storage unavailable */
    }
    return 'month';
}
function rememberPeriod(value) {
    try {
        localStorage.setItem(PERIOD_KEY, value);
    }
    catch {
        /* storage unavailable, the choice still holds for this page session */
    }
}
function periodLabel(key) {
    return PERIODS.find(([k]) => k === key)?.[1] ?? 'This month';
}
let period = storedPeriod();
let categories = [];
/** Display currency, authoritative once the first stats payload lands. */
let currency = 'TRY';
let donutChart = null;
let lineChart = null;
export async function renderExpenses(container) {
    container.innerHTML = `
    <div class="view-head">
      <div class="toolbar">
        <select data-role="period" style="width:auto">
          ${PERIODS.map(([k, label]) => `<option value="${k}"${k === period ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
        </select>
        <button class="btn" data-action="categories">Categories</button>
        <button class="btn btn-primary" data-action="new">+ Entry</button>
      </div>
    </div>
    <div class="grid grid-3 stat-strip" data-role="stats"></div>
    <div class="grid grid-2" data-role="charts"></div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><h3>Ledger</h3>
        <div class="toolbar">
          <select data-role="type" style="width:auto">
            <option value="">All</option><option value="expense">Expenses</option><option value="income">Income</option>
          </select>
        </div>
      </div>
      <div data-role="ledger"></div>
    </div>`;
    // Bound once. Safe because nothing ever re-renders .view-head, the loaders
    // swap only their own [data-role] nodes. Re-rendering the head here would
    // destroy this <select> and the dropdown would work exactly once.
    const periodEl = container.querySelector('[data-role="period"]');
    periodEl.addEventListener('change', () => {
        period = periodEl.value || 'month';
        rememberPeriod(period);
        reload(container);
    });
    container.querySelector('[data-role="type"]').addEventListener('change', () => loadLedger(container));
    onAction(container, (action, el) => {
        const id = Number(el.dataset.id);
        if (action === 'new')
            openEditor(container, null);
        if (action === 'edit')
            openEditor(container, findExpense(id));
        if (action === 'delete')
            remove(container, id);
        if (action === 'categories')
            openCategories(container);
    });
    categories = await apiGet('categories', 'list');
    await reload(container);
}
let ledgerCache = [];
function findExpense(id) { return ledgerCache.find((e) => e.id === id) ?? null; }
async function reload(container) {
    await Promise.all([loadCharts(container), loadLedger(container)]);
}
async function loadLedger(container) {
    const typeEl = container.querySelector('[data-role="type"]');
    const ledger = container.querySelector('[data-role="ledger"]');
    const query = { period };
    if (typeEl.value)
        query.type = typeEl.value;
    const items = await apiGet('expenses', 'list', query);
    ledgerCache = items;
    if (items.length) {
        renderLedgerTable(ledger, items);
    }
    else {
        ledger.innerHTML = emptyState('', `No entries for ${periodLabel(period).toLowerCase()}.`);
    }
    // Arrived from search or history. Runs for the empty case too, returning
    // early there would refuse to widen exactly when widening matters most. An older entry falls outside the selected
    // period, so widen to All time rather than appearing to do nothing.
    const focus = currentParams().get('focus');
    if (focus !== null && !flashFocused(container, focus) && (period !== 'all' || typeEl.value !== '')) {
        period = 'all';
        rememberPeriod(period);
        const periodEl = container.querySelector('[data-role="period"]');
        if (periodEl)
            periodEl.value = 'all';
        typeEl.value = '';
        await reload(container);
    }
}
function renderLedgerTable(ledger, items) {
    ledger.innerHTML = `
    <table class="data">
      <thead><tr><th>Date</th><th>Category</th><th>Description</th><th class="num">Amount</th><th></th></tr></thead>
      <tbody>${items.map((e) => `
        <tr data-row="${e.id}">
          <td>${escapeHtml(fmtDate(e.spent_at))}</td>
          <td>${e.category_name ? `${dot(e.category_color)} ${escapeHtml(e.category_name)}` : '<span class="muted">-</span>'}</td>
          <td>${escapeHtml(e.description ?? '')}${e.is_recurring ? ' <span class="chip">↻</span>' : ''}</td>
          <td class="num ${e.type === 'income' ? 'text-good' : ''}">${e.type === 'income' ? '+' : ''}${escapeHtml(money(e.amount, e.currency))}</td>
          <td class="num">
            <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${e.id}">Edit</button>
            <button class="btn btn-ghost btn-sm" data-action="delete" data-id="${e.id}">✕</button>
          </td>
        </tr>`).join('')}</tbody>
    </table>`;
}
async function loadCharts(container) {
    const statsHost = container.querySelector('[data-role="stats"]');
    const host = container.querySelector('[data-role="charts"]');
    const c = await apiGet('stats', 'expenses', { period });
    currency = c.currency || currency;
    // Spent/Income follow the selector; Current net never does, and says so.
    statsHost.innerHTML = `
    ${statCard('Spent', c.label, money(c.totals.expense, currency), c.totals.expense > 0 ? 'text-bad' : '')}
    ${statCard('Income', c.label, money(c.totals.income, currency), c.totals.income > 0 ? 'text-good' : '')}
    ${statCard('Current net', 'all time', money(c.all_time.current_net, currency), c.all_time.current_net < 0 ? 'text-bad' : 'text-good')}`;
    // The series is zero-filled, so "has rows" no longer means "has spending".
    const hasSpend = c.over_time.some((x) => Number(x.total) > 0);
    host.innerHTML = `
    <div class="card"><div class="card-head"><h3>By category</h3></div>
      ${c.by_category.length ? '<canvas data-role="donut" height="220"></canvas>' : emptyState('', 'No spending in this period.')}</div>
    <div class="card"><div class="card-head"><h3>Over time</h3>
      <span class="chip">${escapeHtml(c.granularity === 'month' ? 'monthly' : 'daily')}</span></div>
      ${hasSpend ? '<canvas data-role="line" height="220"></canvas>' : emptyState('', 'No spending in this period.')}</div>
    ${c.budgets.length ? `<div class="card" style="grid-column:1/-1"><div class="card-head"><h3>Budgets</h3>
      <span class="chip">${escapeHtml(fmtMonth(c.budget_month))}</span></div>
      <div class="list">${c.budgets.map((b) => {
        const spent = parseFloat(b.spent);
        const budget = parseFloat(b.monthly_budget);
        const pct = budget ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
        const over = spent > budget;
        return `<div>
          <div class="row" style="border:none;padding:2px 0;background:none">
            <span class="grow">${dot(b.color)} ${escapeHtml(b.name)}</span>
            <span class="mono tabular ${over ? 'text-bad' : ''}">${escapeHtml(money(spent, currency))} / ${escapeHtml(money(budget, currency))}</span>
          </div>
          <div class="progress ${over ? 'over' : ''}"><span style="width:${pct}%"></span></div>
        </div>`;
    }).join('')}</div></div>` : ''}`;
    if (typeof Chart === 'undefined')
        return;
    donutChart?.destroy();
    lineChart?.destroy();
    const donut = host.querySelector('[data-role="donut"]');
    if (donut) {
        donutChart = new Chart(donut, {
            type: 'doughnut',
            data: {
                labels: c.by_category.map((x) => x.name),
                datasets: [{ data: c.by_category.map((x) => parseFloat(x.total)), backgroundColor: c.by_category.map((x) => x.color || '#6b7280'), borderWidth: 0 }],
            },
            options: { plugins: { legend: { position: 'bottom' } }, cutout: '62%' },
        });
    }
    const line = host.querySelector('[data-role="line"]');
    if (line) {
        lineChart = new Chart(line, {
            type: 'line',
            data: {
                labels: c.over_time.map((x) => (c.granularity === 'month' ? fmtMonth(x.d) : fmtDate(x.d))),
                datasets: [{ data: c.over_time.map((x) => Number(x.total) || 0), borderColor: '#4f8cff', backgroundColor: 'rgba(79,140,255,.15)', fill: true, tension: 0.25 }],
            },
            options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
        });
    }
}
async function remove(container, id) {
    const e = findExpense(id);
    if (!(await confirmDialog('Delete this entry?')))
        return;
    try {
        await apiPost('expenses', 'delete', { id });
        reload(container);
        if (e) {
            toast(`Deleted ${money(e.amount, e.currency)}`, '', {
                label: 'Undo',
                run: async () => {
                    try {
                        await apiPost('expenses', 'create', {
                            type: e.type, amount: e.amount, currency: e.currency, category_id: e.category_id,
                            description: e.description, payment_method: e.payment_method, spent_at: e.spent_at,
                            is_recurring: e.is_recurring, recurring_interval: e.recurring_interval,
                        });
                        await reload(container);
                        toast('Restored as a new entry.', 'good');
                    }
                    catch (err) {
                        toast(err instanceof Error ? err.message : 'Could not restore', 'bad');
                    }
                },
            });
        }
    }
    catch (err) {
        toast(err instanceof Error ? err.message : 'Failed', 'bad');
    }
}
function openEditor(container, exp) {
    const catOpts = ['<option value="">none</option>']
        .concat(categories.map((c) => `<option value="${c.id}" ${exp?.category_id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`))
        .join('');
    openModal({
        title: exp ? 'Edit entry' : 'New entry',
        confirmLabel: exp ? 'Save' : 'Add',
        bodyHtml: `
      <div class="field-row">
        <label><span>Type</span><select name="type">${opts(['expense', 'income'], exp?.type ?? 'expense')}</select></label>
        <label><span>Amount</span><input name="amount" type="number" step="0.01" value="${escapeHtml(exp?.amount ?? '')}" required></label>
        <label><span>Currency</span><input name="currency" value="${escapeHtml(exp?.currency ?? currency)}" maxlength="3"></label>
      </div>
      <div class="field-row">
        <label><span>Category</span><select name="category_id">${catOpts}</select></label>
        <label><span>Date</span><input name="spent_at" type="date" value="${escapeHtml(exp?.spent_at ?? todayStr())}"></label>
      </div>
      <label><span>Description</span><input name="description" value="${escapeHtml(exp?.description ?? '')}"></label>
      <div class="field-row">
        <label><span>Payment method</span><input name="payment_method" value="${escapeHtml(exp?.payment_method ?? '')}"></label>
        <label><span>Recurring interval</span><input name="recurring_interval" value="${escapeHtml(exp?.recurring_interval ?? '')}" placeholder="monthly"></label>
      </div>
      <label class="checkbox"><input type="checkbox" name="is_recurring" ${exp?.is_recurring ? 'checked' : ''}><span>Recurring</span></label>`,
        onConfirm: async (root) => {
            const v = formValues(root);
            if (!v.amount || isNaN(parseFloat(v.amount))) {
                toast('Amount is required.', 'bad');
                return false;
            }
            const payload = { ...v };
            if (!v.category_id)
                payload.category_id = null;
            if (exp)
                payload.id = exp.id;
            try {
                await apiPost('expenses', exp ? 'update' : 'create', payload);
                reload(container);
            }
            catch (e) {
                toast(e instanceof Error ? e.message : 'Failed', 'bad');
                return false;
            }
        },
    });
}
/* ------------------------------------------------------------- categories */
function openCategories(container) {
    const body = () => `
    <div class="list" data-role="cat-list">
      ${categories.map((c) => `
        <div class="row">
          <span class="grow">${dot(c.color)} ${escapeHtml(c.name)}
            ${c.monthly_budget ? `<span class="muted"> · budget ${escapeHtml(money(c.monthly_budget, currency))}</span>` : ''}</span>
          <button class="btn btn-ghost btn-sm" data-cat-edit="${c.id}">Edit</button>
          <button class="btn btn-ghost btn-sm" data-cat-del="${c.id}">✕</button>
        </div>`).join('')}
    </div>
    <hr style="border:none;border-top:1px solid var(--border);margin:14px 0">
    <div class="field-row">
      <label style="flex:2"><span>New category</span><input data-role="cat-name" placeholder="Name"></label>
      <label><span>Color</span><input data-role="cat-color" type="color" value="#4f8cff"></label>
      <label><span>Budget</span><input data-role="cat-budget" type="number" step="0.01"></label>
    </div>
    <button class="btn btn-primary btn-block" data-role="cat-add">Add category</button>`;
    const root = openModal({
        title: 'Categories',
        bodyHtml: body(),
        confirmLabel: 'Done',
        cancelLabel: 'Close',
    });
    const refresh = async () => {
        categories = await apiGet('categories', 'list');
        root.querySelector('.modal-body').innerHTML = body();
        reload(container);
    };
    root.querySelector('.modal-body').addEventListener('click', async (e) => {
        const el = e.target;
        const editId = el.getAttribute('data-cat-edit');
        const delId = el.getAttribute('data-cat-del');
        if (el.getAttribute('data-role') === 'cat-add') {
            const name = root.querySelector('[data-role="cat-name"]').value.trim();
            if (!name)
                return;
            const color = root.querySelector('[data-role="cat-color"]').value;
            const budget = root.querySelector('[data-role="cat-budget"]').value;
            try {
                await apiPost('categories', 'create', { name, color, monthly_budget: budget || null });
                await refresh();
            }
            catch (err) {
                toast(err instanceof Error ? err.message : 'Failed', 'bad');
            }
        }
        else if (editId) {
            const cat = categories.find((c) => c.id === Number(editId));
            if (cat)
                editCategory(cat, refresh);
        }
        else if (delId) {
            if (!(await confirmDialog('Delete category? Its entries stay, uncategorised.')))
                return;
            try {
                await apiPost('categories', 'delete', { id: Number(delId) });
                await refresh();
            }
            catch (err) {
                toast(err instanceof Error ? err.message : 'Failed', 'bad');
            }
        }
    });
}
function editCategory(cat, refresh) {
    openModal({
        title: 'Edit category',
        bodyHtml: `
      <label><span>Name</span><input name="name" value="${escapeHtml(cat.name)}"></label>
      <div class="field-row">
        <label><span>Color</span><input name="color" type="color" value="${escapeHtml(cat.color ?? '#4f8cff')}"></label>
        <label><span>Monthly budget</span><input name="monthly_budget" type="number" step="0.01" value="${escapeHtml(cat.monthly_budget ?? '')}"></label>
      </div>`,
        onConfirm: async (root) => {
            const v = formValues(root);
            try {
                await apiPost('categories', 'update', { id: cat.id, name: v.name, color: v.color, monthly_budget: v.monthly_budget || null });
                await refresh();
            }
            catch (e) {
                toast(e instanceof Error ? e.message : 'Failed', 'bad');
                return false;
            }
        },
    });
}
/** One figure in the summary strip above the charts. */
function statCard(title, sub, value, tone) {
    return `<div class="card stat">
    <div class="stat-label">${escapeHtml(title)} <span class="text-dim">· ${escapeHtml(sub)}</span></div>
    <div class="stat-value mono tabular ${tone}">${escapeHtml(value)}</div>
  </div>`;
}
/** The configured currency's symbol ("₺"), falling back to the raw code. */
function currencySymbol(code) {
    try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, maximumFractionDigits: 0 })
            .formatToParts(0).find((part) => part.type === 'currency')?.value ?? code;
    }
    catch {
        return code;
    }
}
function dot(color) {
    return `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${escapeHtml(color || '#6b7280')}"></span>`;
}
