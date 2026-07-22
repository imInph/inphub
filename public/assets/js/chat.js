/**
 * inphub — slide-out AI chat panel (Phase 2).
 *
 * Talks to api/ai.php using the portable action protocol: the backend parses
 * any actions the model requested, executes the whitelisted ones, and returns
 * a clean reply plus a list of what it did. We surface those as small notes.
 *
 * Conversations are grouped by session_id (a column that already exists on
 * chat_messages), so the panel offers a history menu, a "new chat" button, and
 * a per-conversation model picker whose choice never overwrites the settings
 * model — it is passed only for that chat's calls.
 */
import { apiGet, apiPost } from './api.js';
import { escapeHtml, markdown, toast, timeAgo } from './ui.js';
let panel = null;
let loaded = false;
let currentSession = 'default';
let selectedModel = null;
/** A fresh session id in the backend's allowed charset (^[A-Za-z0-9_-]{1,64}$). */
function genSession() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
export function initChat() {
    panel = document.getElementById('chat-panel');
    const btn = document.getElementById('btn-chat');
    btn?.addEventListener('click', toggleChat);
}
export function openChat() {
    if (!panel)
        return;
    if (panel.hasAttribute('hidden'))
        toggleChat();
}
async function toggleChat() {
    if (!panel)
        return;
    const opening = panel.hasAttribute('hidden');
    panel.hidden = !opening;
    if (!opening)
        return;
    if (!panel.dataset.built) {
        panel.innerHTML = `
      <div class="chat-head">
        <strong>Assistant</strong>
        <span class="chat-head-tools">
          <select data-role="model" title="Model for this conversation"></select>
          <button class="btn btn-ghost btn-sm" data-role="history" title="Conversations">☰</button>
          <button class="btn btn-ghost btn-sm" data-role="new" title="New chat">＋</button>
          <button class="btn btn-ghost btn-sm" data-role="close" title="Close">✕</button>
        </span>
      </div>
      <div class="chat-sessions" data-role="sessions" hidden></div>
      <div class="chat-log" data-role="log"></div>
      <form class="chat-input" data-role="form">
        <input data-role="text" placeholder="Ask or tell me to do something…" autocomplete="off">
        <button class="btn btn-primary" type="submit">Send</button>
      </form>`;
        panel.dataset.built = '1';
        panel.querySelector('[data-role="close"]').addEventListener('click', () => (panel.hidden = true));
        panel.querySelector('[data-role="new"]').addEventListener('click', newChat);
        panel.querySelector('[data-role="history"]').addEventListener('click', toggleSessions);
        panel.querySelector('[data-role="form"]').addEventListener('submit', send);
        const model = panel.querySelector('[data-role="model"]');
        model.addEventListener('change', () => (selectedModel = model.value || null));
        await loadModels();
    }
    if (!loaded)
        await loadHistory();
    panel.querySelector('[data-role="text"]')?.focus();
}
function logEl() {
    return panel.querySelector('[data-role="log"]');
}
/** Populate the per-chat model picker from the configured provider. */
async function loadModels() {
    const sel = panel.querySelector('[data-role="model"]');
    try {
        const res = await apiGet('ai', 'models');
        if (!res.models.length) {
            sel.hidden = true;
            return;
        }
        sel.innerHTML = res.models
            .map((m) => `<option value="${escapeHtml(m)}" ${m === res.current ? 'selected' : ''}>${escapeHtml(m)}</option>`)
            .join('');
        selectedModel = res.current || null;
    }
    catch {
        sel.hidden = true; // provider not reachable — fall back to the settings model
    }
}
/* ------------------------------------------------------------ conversations */
function toggleSessions() {
    const host = panel.querySelector('[data-role="sessions"]');
    if (!host.hidden) {
        host.hidden = true;
        return;
    }
    host.hidden = false;
    renderSessions();
}
async function renderSessions() {
    const host = panel.querySelector('[data-role="sessions"]');
    host.innerHTML = '<div class="chat-note">Loading…</div>';
    try {
        const res = await apiGet('ai', 'chat_sessions');
        if (!res.sessions.length) {
            host.innerHTML = '<div class="chat-note">No past conversations.</div>';
            return;
        }
        host.innerHTML = res.sessions
            .map((s) => `
        <div class="chat-session ${s.session_id === currentSession ? 'active' : ''}">
          <button class="chat-session-open" data-id="${escapeHtml(s.session_id)}">
            <span class="chat-session-title">${escapeHtml(s.title)}</span>
            <span class="chat-session-meta">${escapeHtml(timeAgo(s.last_at))} · ${s.turns}</span>
          </button>
          <button class="chat-session-del" data-id="${escapeHtml(s.session_id)}" title="Delete">✕</button>
        </div>`)
            .join('');
        host.querySelectorAll('.chat-session-open').forEach((b) => b.addEventListener('click', () => switchSession(b.dataset.id)));
        host.querySelectorAll('.chat-session-del').forEach((b) => b.addEventListener('click', () => deleteSession(b.dataset.id)));
    }
    catch (e) {
        host.innerHTML = `<div class="chat-note">${escapeHtml(e instanceof Error ? e.message : 'Failed to load.')}</div>`;
    }
}
async function switchSession(id) {
    currentSession = id;
    panel.querySelector('[data-role="sessions"]').hidden = true;
    await loadHistory();
    panel.querySelector('[data-role="text"]')?.focus();
}
function newChat() {
    currentSession = genSession();
    panel.querySelector('[data-role="sessions"]').hidden = true;
    logEl().innerHTML = '';
    appendNote('New conversation. Ask me anything, or tell me to add a task, log an expense, and so on.');
    loaded = true;
    panel.querySelector('[data-role="text"]')?.focus();
}
async function deleteSession(id) {
    try {
        await apiPost('ai', 'clear_chat', { session: id });
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
        return;
    }
    if (id === currentSession) {
        newChat(); // was the open conversation — start a fresh one
    }
    else {
        await renderSessions();
    }
}
/* -------------------------------------------------------------------- turns */
async function loadHistory() {
    try {
        const res = await apiGet('ai', 'chat_history', { session: currentSession });
        logEl().innerHTML = '';
        if (!res.messages.length) {
            appendNote('Ask me about your day, or tell me to add a task, log an expense, and so on.');
        }
        for (const m of res.messages)
            appendMessage(m.role, m.content, parseActions(m.actions));
        loaded = true;
    }
    catch (e) {
        appendNote(e instanceof Error ? e.message : 'Could not load history.');
    }
}
function parseActions(raw) {
    if (!raw)
        return [];
    try {
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(v) ? v : [];
    }
    catch {
        return [];
    }
}
async function send(e) {
    e.preventDefault();
    const input = panel.querySelector('[data-role="text"]');
    const message = input.value.trim();
    if (!message)
        return;
    input.value = '';
    appendMessage('user', message, []);
    const thinking = appendNote('Thinking…');
    try {
        const res = await apiPost('ai', 'chat', {
            message,
            session: currentSession,
            model: selectedModel ?? undefined,
        });
        thinking.remove();
        appendMessage('assistant', res.reply, res.actions);
        if (res.actions.length) {
            // A write happened — refresh the current view if it exposes a hash reload.
            window.dispatchEvent(new CustomEvent('inphub:data-changed'));
        }
    }
    catch (err) {
        thinking.remove();
        appendMessage('assistant', '', []);
        toast(err instanceof Error ? err.message : 'Chat failed', 'bad');
    }
}
function appendMessage(role, content, actions) {
    const el = document.createElement('div');
    el.className = 'chat-msg ' + (role === 'user' ? 'user' : 'assistant');
    el.innerHTML = role === 'user' ? escapeHtml(content) : `<div class="md">${markdown(content || '…')}</div>`;
    if (actions.length) {
        el.innerHTML += `<div class="chat-actions-note">✓ ${actions.map((a) => escapeHtml(a.summary)).join(' · ')}</div>`;
    }
    const log = logEl();
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
}
function appendNote(text) {
    const el = document.createElement('div');
    el.className = 'chat-msg assistant';
    el.style.opacity = '.7';
    el.textContent = text;
    const log = logEl();
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
}
