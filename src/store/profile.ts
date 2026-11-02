/** Guest storage deliberately retains the pre-account layout. Account IDs are opaque. */
let identity: string | null = null;
let generation = 0;
let transitioning = false;
const listeners = new Set<() => void>();
export const getProfile = () => identity;
export const profileGeneration = () => generation;
export const profileTransitioning = () => transitioning;
export const profilePrefix = (id: string | null = identity) => id === null ? '' : `word-atlas:account:${encodeURIComponent(id)}:`;
export const scopedKey = (key: string, id: string | null = identity) => `${profilePrefix(id)}${key}`;
export function subscribeProfile(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function beginProfileSwitch() { transitioning = true; }
export function activateProfile(id: string | null) { identity = id; generation++; }
export function finishProfileSwitch() { transitioning = false; listeners.forEach(l => l()); }
export function notifyExtras() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('word-atlas:extras-changed'));
}
export async function switchProfile(id: string | null) { return (await import('./store')).switchProfile(id); }
