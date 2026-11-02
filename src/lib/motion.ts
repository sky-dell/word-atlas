import { flushSync } from "react-dom";

type VTDocument = Document & {
  startViewTransition?: (cb: () => void) => {
    finished: Promise<void>;
    ready?: Promise<void>;
  };
};

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Run a DOM-changing update inside a View Transition when the browser supports it. */
export function transition(update: () => void) {
  const d = document as VTDocument;
  if (!d.startViewTransition || reduced()) {
    update();
    return;
  }
  const t = d.startViewTransition(() => flushSync(update));
  void t.ready?.catch(() => {});
  void t.finished.catch(() => {});
}

/** Morph an element (e.g. a gallery tile's illustration) into the word card. */
export function morphFrom(
  el: HTMLElement | null | undefined,
  update: () => void,
) {
  const d = document as VTDocument;
  if (!el || !d.startViewTransition || reduced()) {
    update();
    return;
  }
  el.style.viewTransitionName = "word-art";
  const t = d.startViewTransition(() => {
    el.style.viewTransitionName = "";
    flushSync(update);
  });
  void t.ready?.catch(() => {});
  void t.finished.then(
    () => {
      el.style.viewTransitionName = "";
    },
    () => {
      el.style.viewTransitionName = "";
    },
  );
}
