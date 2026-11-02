import { useSyncExternalStore } from "react";
import { transition } from "./motion";

export type Route =
  | { page: "today" }
  | { page: "atlas"; topic?: string; level?: string; q?: string; view?: string }
  | { page: "learn" }
  | { page: "practice" }
  | { page: "read"; tab?: "short" | "books" | "karoline"; id?: string; book?: string; chapter?: string }
  | { page: "paraphrase"; id?: string }
  | { page: "confuse"; id?: string }
  | { page: "me" }
  | { page: "account" }
  | { page: "admin" }
  | { page: "about" };

export interface Location {
  route: Route;
  /** Word sheet open on top of the route. */
  word: string | null;
}

function parse(hash: string): Location {
  const [path, query = ""] = hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  const word = params.get("w");
  const seg = path.split("/").filter(Boolean);
  let route: Route = { page: "today" };
  if (seg[0] === "atlas")
    route = { page: "atlas", topic: params.get("topic") || undefined, level: params.get("level") || undefined, q: params.get("q") || undefined, view: params.get("view") || undefined };
  else if (seg[0] === "learn") route = { page: "learn" };
  else if (seg[0] === "practice") route = { page: "practice" };
  else if (seg[0] === "me") route = { page: "me" };
  else if (seg[0] === "account") route = { page: "account" };
  else if (seg[0] === "admin") route = { page: "admin" };
  else if (seg[0] === "about") route = { page: "about" };
  else if (seg[0] === "read" || seg[0] === "books") {
    const tab = seg[0] === "books" || seg[1] === "books" ? "books" : params.get("tab");
    route = { page: "read", tab: tab === "short" || tab === "books" || tab === "karoline" ? tab : undefined,
      id: params.get("id") || undefined, book: params.get("book") || undefined, chapter: params.get("chapter") || undefined };
  }
  else if (seg[0] === "paraphrase" || seg[0] === "confuse")
    route = { page: seg[0], id: params.get("id") || undefined };
  else if (seg[0] === "w" && seg[1]) {
    try { return { route: { page: "atlas" }, word: decodeURIComponent(seg[1]) }; }
    catch { return { route: { page: "atlas" }, word: null }; }
  }
  return { route, word };
}

export function href(route: Route, word?: string | null) {
  const params = new URLSearchParams();
  if (route.page === "atlas") {
    if (route.topic) params.set("topic", route.topic);
    if (route.level) params.set("level", route.level);
    if (route.q) params.set("q", route.q);
    if (route.view) params.set("view", route.view);
  }
  if (route.page === "read" || route.page === "paraphrase" || route.page === "confuse") {
    if (route.id) params.set("id", route.id);
    if (route.page === "read") {
      if (route.tab) params.set("tab", route.tab);
      if (route.book) params.set("book", route.book);
      if (route.chapter) params.set("chapter", route.chapter);
    }
  }
  if (word) params.set("w", word);
  const q = params.toString();
  return `#/${route.page === "today" ? "" : route.page}${q ? `?${q}` : ""}`;
}

let loc = parse(location.hash);
const subs = new Set<() => void>();
window.addEventListener("hashchange", () => {
  const next = parse(location.hash);
  const pageChange = next.route.page !== loc.route.page;
  const update = () => {
    loc = next;
    subs.forEach((f) => f());
  };
  // Crossfade between pages; the word sheet animates on its own.
  if (pageChange && !next.word) transition(update);
  else update();
});

export const useLocation = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => loc,
  );

export function go(route: Route, word?: string | null, replace = false) {
  const h = href(route, word);
  if (replace) history.replaceState(null, "", h);
  else history.pushState(null, "", h);
  const next = parse(h);
  const pageChange = next.route.page !== loc.route.page;
  const update = () => {
    loc = next;
    subs.forEach((f) => f());
  };
  if (pageChange && !replace) transition(update);
  else update();
}

export const openWord = (id: string) => go(loc.route, id);
export const closeWord = () => go(loc.route, null);
export const currentLocation = () => loc;
