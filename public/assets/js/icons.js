/**
 * inphub: line icons for the TS-rendered UI (widgets, Customize sheet).
 *
 * Same 24px grid and stroke as the nav icons in server/Pages/Index.cshtml.cs, stroked with
 * currentColor so they follow whatever colour their container sets.
 */
const PATHS = {
    todos: '<path d="M4 6.5l1.6 1.6L8.8 5M4 12.5l1.6 1.6 3.2-3.1M4 18.5l1.6 1.6 3.2-3.1"/><path d="M12.5 7H20M12.5 13H20M12.5 19H20"/>',
    money: '<rect x="3" y="6.5" width="18" height="13.5" rx="3"/><path d="M3 10.5h18M16 15.5h1.5M6 6.5l8.5-3 1.5 3"/>',
    repos: '<circle cx="6" cy="5.5" r="2"/><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7.5v9M18 10c0 4-6.5 3.5-11 7"/>',
    habits: '<path d="M12 21c-3.9 0-7-2.7-7-6.5 0-3.6 2.7-5.5 3.9-8.4.6 2 1.8 3 3.1 3.4.1-3.4 1.1-5.4 3.1-6.5.2 3.1 3.9 5.8 3.9 11.3 0 3.8-3.1 6.7-7 6.7z"/>',
    goals: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.8"/><circle cx="12" cy="12" r="1.2"/>',
    notes: '<path d="M6.5 3.5h8l4 4v11a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2z"/><path d="M14 3.5V8h4.5M8.5 13h7M8.5 16.5h4.5"/>',
    focus: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 2M9.5 2.8h5"/>',
    activity: '<path d="M3.8 12a8.2 8.2 0 1 0 2.4-5.8L3.8 8.5"/><path d="M3.8 4v4.5h4.5M12 7.5V12l3 2"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
    wallet: '<path d="M4 7.5a2.5 2.5 0 0 1 2.5-2.5H18v3"/><rect x="4" y="7.5" width="16.5" height="12" rx="2.5"/><path d="M20.5 11.5H17a2 2 0 0 0 0 4h3.5"/>',
    capture: '<path d="M12 20.5h8"/><path d="M16.2 3.8a2 2 0 0 1 2.9 2.9L7.5 18.3l-3.8 1 1-3.8z"/>',
    sparkles: '<path d="M11 3.5l1.6 4.4 4.4 1.6-4.4 1.6L11 15.5l-1.6-4.4L5 9.5l4.4-1.6zM18 14.5l.8 2.2 2.2.8-2.2.8L18 20.5l-.8-2.2-2.2-.8 2.2-.8z"/>',
    chevron: '<path d="M9.5 6l6 6-6 6"/>',
    grip: '<circle cx="9" cy="6" r="1.1" fill="currentColor"/><circle cx="15" cy="6" r="1.1" fill="currentColor"/><circle cx="9" cy="12" r="1.1" fill="currentColor"/><circle cx="15" cy="12" r="1.1" fill="currentColor"/><circle cx="9" cy="18" r="1.1" fill="currentColor"/><circle cx="15" cy="18" r="1.1" fill="currentColor"/>',
    customize: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><path d="M17 14v6M14 17h6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
};
export function icon(name, size = 20) {
    return `<svg class="ico" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
}
