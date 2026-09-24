/**
 * inphub: pieces shared by the two search boxes (the dashboard bar and the
 * command palette): Google suggestions through /api/suggest, the Google
 * results URL, and the /api/search result types + type → view map.
 *
 * Suggestions go through the server because Google's suggest endpoint sends
 * no CORS headers. The endpoint answers an empty list when Google is slow or
 * down, so callers only ever get fewer rows, never an error to show.
 */
import { apiGet } from './api.js?v=e4ef27a132';
import { escapeHtml } from './ui.js?v=e4ef27a132';
/** Result type → the view that can show it. The client owns route shape. */
export const RESULT_VIEWS = {
    todo: 'todos',
    expense: 'expenses',
    note: 'notes',
    habit: 'habits',
    goal: 'goals',
    repo: 'repos',
};
/** Queries shorter than this are not searched, matches MinChars in server/Endpoints/Search.cs. */
export const SEARCH_MIN_CHARS = 2;
const CACHE_MAX = 50;
const cache = new Map();
/** Google's `hl` from the browser language ("tr-TR" → "tr-TR", "tr" → "tr"). */
function language() {
    const lang = navigator.language || 'en';
    return /^[a-z]{2}(-[A-Z]{2})?$/.test(lang) ? lang : lang.slice(0, 2).toLowerCase();
}
/** Google suggestions for q. Cached, so backspacing re-uses earlier answers. */
export async function fetchSuggestions(q, signal) {
    const hit = cache.get(q);
    if (hit)
        return hit;
    const res = await apiGet('suggest', 'suggest', { q, hl: language() }, { signal });
    const items = Array.isArray(res.items) ? res.items : [];
    cache.set(q, items);
    if (cache.size > CACHE_MAX)
        cache.delete(cache.keys().next().value);
    return items;
}
export function googleUrl(q) {
    return 'https://www.google.com/search?q=' + encodeURIComponent(q);
}
export function searchGoogle(q) {
    window.location.href = googleUrl(q);
}
/**
 * A suggestion with what the user typed shown normally and the completion
 * dimmed, like a browser address bar. When the suggestion does not start with
 * the typed text the whole line is one style. Display only, never a filter.
 */
export function suggestionHtml(typed, s) {
    const t = typed.trim();
    // Compare the same-length slice, lowercasing can change a string's length
    // ("İ" → "i̇"), so startsWith() on lowered text could split mid-character.
    if (t && s.slice(0, t.length).toLocaleLowerCase() === t.toLocaleLowerCase()) {
        return `<span class="gs-typed">${escapeHtml(s.slice(0, t.length))}</span>`
            + `<span class="gs-rest">${escapeHtml(s.slice(t.length))}</span>`;
    }
    return `<span class="gs-rest">${escapeHtml(s)}</span>`;
}
export function isAbort(e) {
    return e instanceof DOMException && e.name === 'AbortError';
}
