/**
 * inphub — slide-out AI chat panel (Phase 2).
 *
 * Talks to api/ai.php using the portable action protocol: the backend parses
 * any actions the model requested, executes the whitelisted ones, and returns
 * a clean reply plus a list of what it did. We surface those as small notes.
 */

import { apiGet, apiPost } from './api.js';
import { escapeHtml, markdown, toast } from './ui.js';

interface ChatMessage { id?: number; role: string; content: string; actions?: string | null; }
interface ChatReply { reply: string; actions: { tool: string; summary: string }[]; }

let panel: HTMLElement | null = null;
let loaded = false;

export function initChat(): void {
  panel = document.getElementById('chat-panel');
  const btn = document.getElementById('btn-chat');
  btn?.addEventListener('click', toggleChat);
}

export function openChat(): void {
  if (!panel) return;
  if (panel.hasAttribute('hidden')) toggleChat();
}

async function toggleChat(): Promise<void> {
  if (!panel) return;
  const opening = panel.hasAttribute('hidden');
  panel.hidden = !opening;
  if (!opening) return;

  if (!panel.dataset.built) {
    panel.innerHTML = `
      <div class="chat-head">
        <strong>Assistant</strong>
        <span>
          <button class="btn btn-ghost btn-sm" data-role="clear">Clear</button>
          <button class="btn btn-ghost btn-sm" data-role="close">✕</button>
        </span>
      </div>
      <div class="chat-log" data-role="log"></div>
      <form class="chat-input" data-role="form">
        <input data-role="text" placeholder="Ask or tell me to do something…" autocomplete="off">
        <button class="btn btn-primary" type="submit">Send</button>
      </form>`;
    panel.dataset.built = '1';

    panel.querySelector('[data-role="close"]')!.addEventListener('click', () => (panel!.hidden = true));
    panel.querySelector('[data-role="clear"]')!.addEventListener('click', clearChat);
    panel.querySelector<HTMLFormElement>('[data-role="form"]')!.addEventListener('submit', send);
  }

  if (!loaded) await loadHistory();
  panel.querySelector<HTMLInputElement>('[data-role="text"]')?.focus();
}

function logEl(): HTMLElement {
  return panel!.querySelector<HTMLElement>('[data-role="log"]')!;
}

async function loadHistory(): Promise<void> {
  try {
    const res = await apiGet<{ messages: ChatMessage[] }>('ai', 'chat_history');
    logEl().innerHTML = '';
    if (!res.messages.length) {
      appendNote('Ask me about your day, or tell me to add a task, log an expense, and so on.');
    }
    for (const m of res.messages) appendMessage(m.role, m.content, parseActions(m.actions));
    loaded = true;
  } catch (e) {
    appendNote(e instanceof Error ? e.message : 'Could not load history.');
  }
}

function parseActions(raw: string | null | undefined): { tool: string; summary: string }[] {
  if (!raw) return [];
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function send(e: Event): Promise<void> {
  e.preventDefault();
  const input = panel!.querySelector<HTMLInputElement>('[data-role="text"]')!;
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  appendMessage('user', message, []);

  const thinking = appendNote('Thinking…');
  try {
    const res = await apiPost<ChatReply>('ai', 'chat', { message });
    thinking.remove();
    appendMessage('assistant', res.reply, res.actions);
    if (res.actions.length) {
      // A write happened — refresh the current view if it exposes a hash reload.
      window.dispatchEvent(new CustomEvent('inphub:data-changed'));
    }
  } catch (err) {
    thinking.remove();
    appendMessage('assistant', '', []);
    toast(err instanceof Error ? err.message : 'Chat failed', 'bad');
  }
}

function appendMessage(role: string, content: string, actions: { tool: string; summary: string }[]): void {
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

function appendNote(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'chat-msg assistant';
  el.style.opacity = '.7';
  el.textContent = text;
  const log = logEl();
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

async function clearChat(): Promise<void> {
  try {
    await apiPost('ai', 'clear_chat', {});
    loaded = false;
    await loadHistory();
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Failed', 'bad');
  }
}
