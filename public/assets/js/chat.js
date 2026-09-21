/**
 * inphub: slide-out AI chat panel.
 *
 * Talks to api/ai.php using the portable action protocol: the backend parses
 * any actions the model requested, executes the whitelisted ones, and returns
 * a clean reply plus a list of what it did. We surface those as small notes.
 */
import { apiGet, apiPost } from './api.js?v=42714d0ded';
import { escapeHtml, markdown, toast } from './ui.js?v=42714d0ded';
let panel = null;
let loaded = false;
/** Active conversation; null until the first message starts a new one. */
let currentSession = null;
/** Session-only model override, never written to settings. Empty = settings model. */
let chatModel = '';
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
        <span>
          <button class="btn btn-ghost btn-sm" data-role="history" title="Chat history">🕘</button>
          <button class="btn btn-ghost btn-sm" data-role="new" title="New chat">＋</button>
          <button class="btn btn-ghost btn-sm" data-role="close">✕</button>
        </span>
      </div>
      <div class="chat-sessions" data-role="sessions" hidden></div>
      <div class="chat-model">
        <label for="chat-model-input">Model</label>
        <input id="chat-model-input" data-role="model" list="chat-model-list"
          placeholder="Default (from Settings)" autocomplete="off" spellcheck="false">
        <datalist id="chat-model-list"></datalist>
      </div>
      <div class="chat-log" data-role="log"></div>
      <form class="chat-input" data-role="form">
        <input data-role="text" placeholder="Ask or tell me to do something…" autocomplete="off">
        <button class="btn btn-primary" type="submit">Send</button>
      </form>`;
        panel.dataset.built = '1';
        panel.querySelector('[data-role="close"]').addEventListener('click', () => (panel.hidden = true));
        panel.querySelector('[data-role="history"]').addEventListener('click', toggleSessions);
        panel.querySelector('[data-role="new"]').addEventListener('click', newChat);
        // Session list: one delegated listener on the stable host element.
        panel.querySelector('[data-role="sessions"]').addEventListener('click', (e) => {
            const t = e.target.closest('[data-open], [data-del]');
            if (!t)
                return;
            if (t.dataset.open)
                openSession(t.dataset.open);
            if (t.dataset.del)
                deleteSession(t.dataset.del);
        });
        panel.querySelector('[data-role="form"]').addEventListener('submit', send);
        const modelInput = panel.querySelector('[data-role="model"]');
        modelInput.value = chatModel;
        modelInput.addEventListener('change', () => {
            chatModel = modelInput.value.trim(); // this chat session only
        });
        loadModels();
    }
    if (!loaded)
        await loadHistory();
    panel.querySelector('[data-role="text"]')?.focus();
}
function logEl() {
    return panel.querySelector('[data-role="log"]');
}
/** Fill the model combo's suggestions from the configured provider. */
async function loadModels() {
    try {
        const res = await apiGet('ai', 'models');
        const list = panel?.querySelector('#chat-model-list');
        const input = panel?.querySelector('[data-role="model"]');
        if (!list || !input)
            return;
        list.innerHTML = res.models.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
        input.placeholder = `Default (${res.default})`;
    }
    catch {
        /* suggestions are optional, the input still accepts any model id */
    }
}
async function loadHistory(sessionId) {
    try {
        const res = await apiGet('ai', 'chat_history', sessionId ? { session_id: sessionId } : {});
        currentSession = res.session_id;
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
/* ------------------------------------------------------- history menu */
function sessionsEl() {
    return panel.querySelector('[data-role="sessions"]');
}
async function toggleSessions() {
    const host = sessionsEl();
    if (!host.hidden) {
        host.hidden = true;
        return;
    }
    host.innerHTML = '<div class="text-dim" style="padding:8px 12px">Loading…</div>';
    host.hidden = false;
    try {
        const res = await apiGet('ai', 'list_sessions');
        if (!res.sessions.length) {
            host.innerHTML = '<div class="text-dim" style="padding:8px 12px">No past conversations.</div>';
            return;
        }
        host.innerHTML = res.sessions.map((s) => `
      <div class="chat-session ${s.session_id === currentSession ? 'active' : ''}" data-sid="${escapeHtml(s.session_id)}">
        <button class="chat-session-open" data-open="${escapeHtml(s.session_id)}">
          <span class="chat-session-title">${escapeHtml(s.title)}</span>
          <span class="chat-session-date">${escapeHtml(s.updated_at.slice(0, 16))}</span>
        </button>
        <button class="btn btn-ghost btn-sm" data-del="${escapeHtml(s.session_id)}" title="Delete conversation">✕</button>
      </div>`).join('');
    }
    catch (e) {
        host.innerHTML = `<div class="text-dim" style="padding:8px 12px">${escapeHtml(e instanceof Error ? e.message : 'Failed')}</div>`;
    }
}
function newChat() {
    currentSession = null;
    sessionsEl().hidden = true;
    logEl().innerHTML = '';
    appendNote('New chat.');
    panel.querySelector('[data-role="text"]')?.focus();
}
async function openSession(sid) {
    sessionsEl().hidden = true;
    await loadHistory(sid);
    panel.querySelector('[data-role="text"]')?.focus();
}
async function deleteSession(sid) {
    try {
        await apiPost('ai', 'delete_session', { session_id: sid });
        if (sid === currentSession)
            newChat();
        // Re-render the (open) list.
        sessionsEl().hidden = true;
        await toggleSessions();
    }
    catch (e) {
        toast(e instanceof Error ? e.message : 'Failed', 'bad');
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
        const payload = { message };
        if (chatModel)
            payload.model = chatModel;
        if (currentSession)
            payload.session_id = currentSession;
        const res = await apiPost('ai', 'chat', payload);
        currentSession = res.session_id;
        thinking.remove();
        appendMessage('assistant', res.reply, res.actions);
        if (res.actions.some((a) => a.summary)) {
            // A write happened, refresh the current view if it exposes a hash reload.
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
    const done = actions.filter((a) => a.summary);
    const failed = actions.filter((a) => a.error);
    if (done.length) {
        el.innerHTML += `<div class="chat-actions-note">✓ ${done.map((a) => escapeHtml(a.summary)).join(' · ')}</div>`;
    }
    if (failed.length) {
        el.innerHTML += `<div class="chat-actions-note warn">⚠ ${failed.map((a) => escapeHtml(a.error)).join(' · ')}</div>`;
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
