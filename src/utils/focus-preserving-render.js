const DEFAULT_FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function identityOf(element) {
  if (!element) return '';
  if (element.dataset?.focusKey) return `key:${element.dataset.focusKey}`;
  if (element.id) return `id:${element.id}`;
  return '';
}

function isUsable(element) {
  return !!element && element.disabled !== true && element.hidden !== true && !element.closest?.('[hidden]');
}

function getSelectionInfo(element) {
  if (!element) return { start: null, end: null, direction: 'none' };
  try {
    if (
      element.tagName === 'TEXTAREA' ||
      (element.tagName === 'INPUT' &&
        ['text', 'search', 'url', 'tel', 'password', 'email', ''].includes(element.type?.toLowerCase() || ''))
    ) {
      return {
        start: element.selectionStart,
        end: element.selectionEnd,
        direction: element.selectionDirection || 'none',
      };
    }
  } catch (_) {}
  return { start: null, end: null, direction: 'none' };
}

/**
 * Captures only the state a small innerHTML-based view promises to preserve.
 * Callers name their live fields and scroll containers explicitly.
 */
export function createFocusPreservingRenderer(
  root,
  {
    valueSelectors = [],
    scrollSelectors = [],
    focusableSelector = DEFAULT_FOCUSABLE,
    fallback,
    keepFocusInside = () => false,
  } = {},
) {
  const focusables = () => [...root.querySelectorAll(focusableSelector)];
  const findByIdentity = (identity) => focusables().find((element) => identityOf(element) === identity) || null;
  const resolveElement = (selector) =>
    selector === ':scope' || selector === '' || root.matches?.(selector) ? root : root.querySelector(selector);

  function capture() {
    const active = root.ownerDocument?.activeElement;
    const ordered = focusables();
    const activeSelection = getSelectionInfo(active);
    return {
      values: valueSelectors.map((selector) => {
        const element = root.querySelector(selector);
        const selection = getSelectionInfo(element);
        return {
          selector,
          value: element?.value,
          selectionStart: selection.start,
          selectionEnd: selection.end,
          selectionDirection: selection.direction,
        };
      }),
      scroll: scrollSelectors.map((selector) => {
        const element = resolveElement(selector);
        return { selector, top: element?.scrollTop || 0, left: element?.scrollLeft || 0 };
      }),
      focus: {
        wasInside: !!active && root.contains(active),
        identity: identityOf(active),
        index: ordered.indexOf(active),
        order: ordered.map(identityOf),
        selectionStart: activeSelection.start,
        selectionEnd: activeSelection.end,
        selectionDirection: activeSelection.direction,
      },
    };
  }

  function restore(snapshot) {
    for (const field of snapshot.values) {
      const element = root.querySelector(field.selector);
      if (!element || field.value === undefined) continue;
      element.value = field.value;
      if (field.selectionStart !== null && field.selectionStart !== undefined) {
        element.setSelectionRange?.(
          field.selectionStart,
          field.selectionEnd ?? field.selectionStart,
          field.selectionDirection || 'none',
        );
      }
    }
    for (const position of snapshot.scroll) {
      const element = resolveElement(position.selector);
      if (!element) continue;
      element.scrollTop = position.top;
      element.scrollLeft = position.left;
    }

    const document = root.ownerDocument;
    const mustRestore =
      snapshot.focus.wasInside ||
      (keepFocusInside() && (!document.activeElement || document.activeElement === document.body));
    if (!mustRestore) return;

    let target = findByIdentity(snapshot.focus.identity);
    if (!isUsable(target)) target = null;
    if (!target) {
      target = fallback?.({ snapshot, findByIdentity, focusables }) || null;
      if (!isUsable(target)) target = null;
    }
    if (!target && snapshot.focus.index >= 0) {
      for (let distance = 1; distance < snapshot.focus.order.length; distance++) {
        const before = findByIdentity(snapshot.focus.order[snapshot.focus.index - distance]);
        const after = findByIdentity(snapshot.focus.order[snapshot.focus.index + distance]);
        target = isUsable(before) ? before : isUsable(after) ? after : null;
        if (target) break;
      }
    }
    if (!target) target = focusables().find(isUsable) || null;
    if (!target) return;
    try {
      target.focus({ preventScroll: true });
    } catch (_) {
      target.focus();
    }
    if (
      snapshot.focus.selectionStart !== null &&
      snapshot.focus.selectionStart !== undefined &&
      typeof target.setSelectionRange === 'function'
    ) {
      try {
        target.setSelectionRange(
          snapshot.focus.selectionStart,
          snapshot.focus.selectionEnd ?? snapshot.focus.selectionStart,
          snapshot.focus.selectionDirection || 'none',
        );
      } catch (_) {}
    }
  }

  return {
    capture,
    restore,
    render(renderView, { preserve = true } = {}) {
      const snapshot = preserve ? capture() : null;
      renderView();
      if (snapshot) restore(snapshot);
    },
  };
}
