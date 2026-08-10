/**
 * inphub — money: ledger with filters, category manager, Chart.js donut + line,
 * budget bars. Chart.js is a global loaded from CDN (charts only).
 */

import { apiGet, apiPost } from './api.js';
import {
  escapeHtml, money, fmtDate, monthStr, todayStr, emptyState, toast, onAction,
  openModal, formValues, confirmDialog,
} from './ui.js';
import { opts } from './todos.js';

declare const Chart: any;

interface Category { id: number; name: string; color: string | null; icon: string | null; monthly_budget: string | null; }
interface Expense {
  id: number; type: string; amount: string; currency: string; category_id: number | null;
  category_name: string | null; category_color: string | null; description: string | null;
  payment_method: string | null; spent_at: string; is_recurring: number; recurring_interval: string | null;
}
interface Charts {
  month: string;
  by_category: { name: string; color: string | null; total: string }[];
  over_time: { d: string; total: string }[];
  budgets: { name: string; color: string | null; monthly_budget: string; spent: string }[];
}

let month = monthStr();
let categories: Category[] = [];
let currency = 'TRY';
let donutChart: any = null;
let lineChart: any = null;

export async function renderExpenses(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="view-head">
      <h2>Money</h2>
      <div class="toolbar">
        <input type="month" data-role="month" value="${escapeHtml(month)}" style="width:auto">
        <button class="btn" data-action="categories">Categories</button>
        <button class="btn btn-primary" data-action="new">+ Entry</button>
      </div>
    </div>
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

  const monthEl = container.querySelector<HTMLInputElement>('[data-role="month"]')!;
  monthEl.addEventListener('change', () => {
    month = monthEl.value || monthStr();
    reload(container);
  });
  container.querySelector<HTMLSelectElement>('[data-role="type"]')!.addEventListener('change', () => loadLedger(container));

  onAction(container, (action, el) => {
    const id = Number(el.dataset.id);
    if (action === 'new') openEditor(container, null);
    if (action === 'edit') openEditor(container, findExpense(id));
    if (action === 'delete') remove(container, id);
    if (action === 'categories') openCategories(container);
  });

  categories = await apiGet<Category[]>('categories', 'list');
  await reload(container);
}

let ledgerCache: Expense[] = [];
function findExpense(id: number): Expense | null { return ledgerCache.find((e) => e.id === id) ?? null; }

async function reload(container: HTMLElement): Promise<void> {
  await Promise.all([loadCharts(container), loadLedger(container)]);
}

async function loadLedger(container: HTMLElement): Promise<void> {
  const typeEl = container.querySelector<HTMLSelectElement>('[data-role="type"]')!;
  const ledger = container.querySelector<HTMLElement>('[data-role="ledger"]')!;
  const query: Record<string, string> = { month };
  if (typeEl.value) query.type = typeEl.value;
  const items = await apiGet<Expense[]>('expenses', 'list', query);
  ledgerCache = items;
  if (items.length) currency = items[0].currency || currency;

  if (!items.length) {
    ledger.innerHTML = emptyState('₺', 'No entries this month.');
    return;
  }
  ledger.innerHTML = `
    <table class="data">
      <thead><tr><th>Date</th><th>Category</th><th>Description</th><th class="num">Amount</th><th></th></tr></thead>
      <tbody>${items.map((e) => `
        <tr>
          <td>${escapeHtml(fmtDate(e.spent_at))}</td>
          <td>${e.category_name ? `${dot(e.category_color)} ${escapeHtml(e.category_name)}` : '<span class="muted">—</span>'}</td>
          <td>${escapeHtml(e.description ?? '')}${e.is_recurring ? ' <span class="chip">↻</span>' : ''}</td>
          <td class="num ${e.type === 'income' ? 'text-good' : ''}">${e.type === 'income' ? '+' : ''}${escapeHtml(money(e.amount, e.currency))}</td>
          <td class="num">
            <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${e.id}">Edit</button>
            <button class="btn btn-ghost btn-sm" data-action="delete" data-id="${e.id}">✕</button>
          </td>
        </tr>`).join('')}</tbody>
    </table>`;
}

async function loadCharts(container: HTMLElement): Promise<void> {
  const host = container.querySelector<HTMLElement>('[data-role="charts"]')!;
  const c = await apiGet<Charts>('stats', 'expenses', { month });

  host.innerHTML = `
    <div class="card"><div class="card-head"><h3>By category</h3></div>
      ${c.by_category.length ? '<canvas data-role="donut" height="220"></canvas>' : emptyState('◔', 'No spending yet.')}</div>
    <div class="card"><div class="card-head"><h3>Over the month</h3></div>
      ${c.over_time.length ? '<canvas data-role="line" height="220"></canvas>' : emptyState('📈', 'No spending yet.')}</div>
    ${c.budgets.length ? `<div class="card" style="grid-column:1/-1"><div class="card-head"><h3>Budgets</h3></div>
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

  if (typeof Chart === 'undefined') return;

  donutChart?.destroy();
  lineChart?.destroy();

  const donut = host.querySelector<HTMLCanvasElement>('[data-role="donut"]');
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
  const line = host.querySelector<HTMLCanvasElement>('[data-role="line"]');
  if (line) {
    lineChart = new Chart(line, {
      type: 'line',
      data: {
        labels: c.over_time.map((x) => fmtDate(x.d)),
        datasets: [{ data: c.over_time.map((x) => parseFloat(x.total)), borderColor: '#4f8cff', backgroundColor: 'rgba(79,140,255,.15)', fill: true, tension: 0.25 }],
      },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
    });
  }
}

async function remove(container: HTMLElement, id: number): Promise<void> {
  if (!(await confirmDialog('Delete this entry?'))) return;
  try {
    await apiPost('expenses', 'delete', { id });
    reload(container);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Failed', 'bad');
  }
}

function openEditor(container: HTMLElement, exp: Expense | null): void {
  const catOpts = ['<option value="">— none —</option>']
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
      const payload: Record<string, unknown> = { ...v };
      if (!v.category_id) payload.category_id = null;
      if (exp) payload.id = exp.id;
      try {
        await apiPost('expenses', exp ? 'update' : 'create', payload);
        reload(container);
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
        return false;
      }
    },
  });
}

/* ------------------------------------------------------------- categories */

function openCategories(container: HTMLElement): void {
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
    categories = await apiGet<Category[]>('categories', 'list');
    root.querySelector('.modal-body')!.innerHTML = body();
    reload(container);
  };

  root.querySelector('.modal-body')!.addEventListener('click', async (e) => {
    const el = e.target as HTMLElement;
    const editId = el.getAttribute('data-cat-edit');
    const delId = el.getAttribute('data-cat-del');
    if (el.getAttribute('data-role') === 'cat-add') {
      const name = root.querySelector<HTMLInputElement>('[data-role="cat-name"]')!.value.trim();
      if (!name) return;
      const color = root.querySelector<HTMLInputElement>('[data-role="cat-color"]')!.value;
      const budget = root.querySelector<HTMLInputElement>('[data-role="cat-budget"]')!.value;
      try {
        await apiPost('categories', 'create', { name, color, monthly_budget: budget || null });
        await refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed', 'bad');
      }
    } else if (editId) {
      const cat = categories.find((c) => c.id === Number(editId));
      if (cat) editCategory(cat, refresh);
    } else if (delId) {
      if (!(await confirmDialog('Delete category? Its entries stay, uncategorised.'))) return;
      try {
        await apiPost('categories', 'delete', { id: Number(delId) });
        await refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed', 'bad');
      }
    }
  });
}

function editCategory(cat: Category, refresh: () => Promise<void>): void {
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
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
        return false;
      }
    },
  });
}

function dot(color: string | null): string {
  return `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${escapeHtml(color || '#6b7280')}"></span>`;
}
