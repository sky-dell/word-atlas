const KEY = 'word-atlas:entry-mode';

/** A tab-local UI preference only; never an authentication credential. */
export function hasGuestEntry() {
  try { return sessionStorage.getItem(KEY) === 'guest'; } catch { return false; }
}
export function rememberGuestEntry() {
  try { sessionStorage.setItem(KEY, 'guest'); } catch { /* In-memory entry still works. */ }
}
export function clearGuestEntry() {
  try { sessionStorage.removeItem(KEY); } catch { /* Not required for server authorization. */ }
}
