const DEFAULT_MARGIN = 12;
const INTERACTIVE = 'button, a[href], input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="slider"], [role="textbox"]';

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const dimension = value => Math.max(0, finite(value));

/**
 * Constrain a panel origin to its desk, in CSS pixels.
 * Oversized panels retain a reachable top-left header instead of acquiring a
 * negative origin. CSS should provide internal scrolling for their contents.
 */
export function constrainPosition(position, panelSize, deskSize, options = {}) {
  const margin = Math.max(0, finite(options.margin, DEFAULT_MARGIN));
  const bottomInset = Math.max(0, finite(options.bottomInset));
  const keepWidth = Math.max(1, finite(options.minimumVisibleWidth, 96));
  const keepHeight = Math.max(1, finite(options.handleHeight, 44));
  function axis(value, panelExtent, deskExtent, minimumVisible) {
    const panel = dimension(panelExtent), desk = dimension(deskExtent);
    const visible = Math.min(panel, minimumVisible, desk);
    const minimum = Math.min(margin, Math.max(0, desk - visible));
    const fits = panel + margin * 2 <= desk;
    const maximum = Math.max(minimum, desk - (fits ? panel : visible) - margin);
    return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
  }
  return {
    x: axis(position.x, panelSize.width, deskSize.width, keepWidth),
    y: axis(position.y, panelSize.height, Math.max(0, dimension(deskSize.height) - bottomInset), keepHeight),
  };
}

/**
 * Native floating-panel controller. Panels: [data-panel] with a unique id;
 * handles: [data-drag-handle]; launchers: [data-toggle-panel="id"];
 * close buttons: [data-close-panel="id"]. All live inside `root`.
 */
export function createFloatingPanels({ root, onVisibilityChange = () => {}, bottomInset = 0 }) {
  if (!root?.querySelectorAll || !root.ownerDocument) {
    throw new TypeError('createFloatingPanels requires a desk root element.');
  }
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const panels = new Map();
  const handleDefaults = [];
  let drag = null;
  let highestZ = 10;
  let topPanel = null;
  let destroyed = false;
  let resizeFrame = 0;

  const launchers = id => [...root.querySelectorAll('[data-toggle-panel]')]
    .filter(node => node.dataset.togglePanel === id);

  for (const element of root.querySelectorAll('[data-panel]')) {
    if (!element.id) throw new Error('Every floating panel needs an id.');
    if (panels.has(element.id)) throw new Error(`Duplicate floating panel id: ${element.id}`);
    const zIndex = Number.parseInt(win.getComputedStyle(element).zIndex, 10) || 10;
    highestZ = Math.max(highestZ, zIndex);
    const panel = { element, visible: !element.classList.contains('is-hidden'), x: null, y: null, zIndex };
    panels.set(element.id, panel);
    element.setAttribute('aria-hidden', String(!panel.visible));
    element.inert = !panel.visible;
    for (const launcher of launchers(element.id)) {
      launcher.setAttribute('aria-controls', element.id);
      launcher.setAttribute('aria-pressed', String(panel.visible));
    }
    for (const handle of element.querySelectorAll('[data-drag-handle]')) {
      handleDefaults.push({ handle, tabIndex: handle.getAttribute('tabindex'), touchAction: handle.style.touchAction, shortcuts: handle.getAttribute('aria-keyshortcuts') });
      if (!handle.hasAttribute('tabindex')) handle.tabIndex = 0;
      handle.style.touchAction = 'none';
      handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight Escape');
    }
  }
  normalizeStack();

  function panelFrom(target) {
    const element = target?.closest?.('[data-panel]');
    return element && root.contains(element) ? panels.get(element.id) : undefined;
  }
  function normalizeStack() {
    const ordered = [...panels.values()].sort((a, b) => a.zIndex - b.zIndex);
    ordered.forEach((panel, index) => {
      panel.zIndex = index + 1;
      panel.element.style.zIndex = String(panel.zIndex);
    });
    highestZ = ordered.length;
    topPanel = ordered.at(-1) || null;
  }
  function raise(panel) {
    if (panel === topPanel) return;
    if (highestZ >= 99) normalizeStack();
    panel.zIndex = ++highestZ;
    panel.element.style.zIndex = String(panel.zIndex);
    topPanel = panel;
  }
  function geometry(panel) {
    const deskRect = root.getBoundingClientRect();
    const rect = panel.element.getBoundingClientRect();
    return {
      position: {
        x: rect.left - deskRect.left - root.clientLeft + root.scrollLeft,
        y: rect.top - deskRect.top - root.clientTop + root.scrollTop,
      },
      size: { width: panel.element.offsetWidth || rect.width, height: panel.element.offsetHeight || rect.height },
      desk: { width: root.clientWidth, height: root.clientHeight },
      handleHeight: panel.element.querySelector('[data-drag-handle]')?.offsetHeight || 44,
    };
  }
  function place(panel, position, measured = geometry(panel)) {
    const constrained = constrainPosition(position, measured.size, measured.desk, { handleHeight: measured.handleHeight, bottomInset });
    panel.x = constrained.x;
    panel.y = constrained.y;
    Object.assign(panel.element.style, { left: `${panel.x}px`, top: `${panel.y}px`, right: 'auto', bottom: 'auto' });
    return { ...constrained };
  }
  function clampPanel(panel) {
    const measured = geometry(panel);
    const constrained = constrainPosition(measured.position, measured.size, measured.desk, { handleHeight: measured.handleHeight, bottomInset });
    // Retain CSS anchoring and avoid observer feedback from redundant writes.
    if (Math.abs(constrained.x - measured.position.x) > 0.5 || Math.abs(constrained.y - measured.position.y) > 0.5) {
      place(panel, constrained, measured);
    }
  }
  function finishDrag() {
    if (!drag) return;
    const ended = drag;
    drag = null;
    ended.panel.element.classList.remove('is-dragging');
    if (ended.handle.hasPointerCapture?.(ended.pointerId)) ended.handle.releasePointerCapture(ended.pointerId);
  }
  function setVisible(id, visible) {
    const panel = panels.get(id);
    if (!panel || destroyed) return false;
    const changed = panel.visible !== visible;
    if (!visible && drag?.panel === panel) finishDrag();
    const shouldRestoreFocus = !visible && panel.element.contains(doc.activeElement);
    panel.visible = visible;
    panel.element.classList.toggle('is-hidden', !visible);
    panel.element.setAttribute('aria-hidden', String(!visible));
    panel.element.inert = !visible;
    for (const launcher of launchers(id)) launcher.setAttribute('aria-pressed', String(visible));
    if (changed && visible) {
      clampPanel(panel);
      raise(panel);
    }
    if (shouldRestoreFocus) launchers(id).find(node => !node.disabled && !node.closest('[inert]'))?.focus({ preventScroll: true });
    if (changed) onVisibilityChange(id, visible);
    return true;
  }
  function onClick(event) {
    const close = event.target?.closest?.('[data-close-panel]');
    if (close && root.contains(close)) {
      if (setVisible(close.dataset.closePanel, false)) event.preventDefault();
      return;
    }
    const launcher = event.target?.closest?.('[data-toggle-panel]');
    if (launcher && root.contains(launcher)) {
      const panel = panels.get(launcher.dataset.togglePanel);
      if (panel && setVisible(panel.element.id, !panel.visible)) event.preventDefault();
    }
  }
  function onPointerDown(event) {
    const panel = panelFrom(event.target);
    if (!panel?.visible) return;
    raise(panel);
    const handle = event.target?.closest?.('[data-drag-handle]');
    if (!handle || !panel.element.contains(handle) || event.target.closest(INTERACTIVE)) return;
    if (event.button !== 0 || event.isPrimary === false || drag) return;
    const measured = geometry(panel);
    drag = {
      panel, handle, pointerId: event.pointerId,
      pointerX: event.clientX, pointerY: event.clientY,
      startX: measured.position.x, startY: measured.position.y,
    };
    handle.setPointerCapture(event.pointerId);
    panel.element.classList.add('is-dragging');
    handle.focus({ preventScroll: true });
    event.preventDefault();
  }
  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    place(drag.panel, {
      x: drag.startX + event.clientX - drag.pointerX,
      y: drag.startY + event.clientY - drag.pointerY,
    });
    event.preventDefault();
  }
  function onPointerEnd(event) {
    if (drag?.pointerId === event.pointerId) finishDrag();
  }
  function onKeyDown(event) {
    const panel = panelFrom(event.target);
    if (!panel?.visible) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setVisible(panel.element.id, false);
      return;
    }
    const handle = event.target?.closest?.('[data-drag-handle]');
    if (!handle || !panel.element.contains(handle) || event.target.closest(INTERACTIVE)) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    const measured = geometry(panel);
    const step = event.shiftKey ? 40 : 12;
    raise(panel);
    place(panel, { x: measured.position.x + direction[0] * step, y: measured.position.y + direction[1] * step }, measured);
  }
  function onFocus(event) {
    const panel = panelFrom(event.target);
    if (panel?.visible) raise(panel);
  }
  function onResize() {
    finishDrag();
    for (const panel of panels.values()) clampPanel(panel);
  }
  const listeners = [
    ['click', onClick], ['pointerdown', onPointerDown], ['pointermove', onPointerMove],
    ['pointerup', onPointerEnd], ['pointercancel', onPointerEnd], ['lostpointercapture', onPointerEnd],
    ['keydown', onKeyDown], ['focusin', onFocus],
  ];
  for (const [type, listener] of listeners) root.addEventListener(type, listener);
  win.addEventListener('resize', onResize);
  win.addEventListener('blur', finishDrag);
  const resizeObserver = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(() => {
    if (destroyed || resizeFrame) return;
    // Batch native resizing/content changes outside the observer delivery cycle.
    resizeFrame = win.requestAnimationFrame(() => {
      resizeFrame = 0;
      if (!destroyed) onResize();
    });
  }) : null;
  resizeObserver?.observe(root);
  for (const panel of panels.values()) resizeObserver?.observe(panel.element);

  return {
    show: id => setVisible(id, true),
    hide: id => setVisible(id, false),
    bringToFront: id => {
      const panel = panels.get(id);
      if (!panel?.visible || destroyed) return false;
      raise(panel);
      return true;
    },
    toggle: id => {
      const panel = panels.get(id);
      return panel ? setVisible(id, !panel.visible) : false;
    },
    move: (id, position) => {
      const panel = panels.get(id);
      if (!panel || destroyed) return null;
      return place(panel, position);
    },
    getState: () => Object.fromEntries([...panels].map(([id, panel]) => [id, {
      visible: panel.visible, x: panel.x, y: panel.y, zIndex: panel.zIndex,
    }])),
    destroy() {
      if (destroyed) return;
      finishDrag();
      destroyed = true;
      for (const [type, listener] of listeners) root.removeEventListener(type, listener);
      win.removeEventListener('resize', onResize);
      win.removeEventListener('blur', finishDrag);
      resizeObserver?.disconnect();
      if (resizeFrame) win.cancelAnimationFrame(resizeFrame);
      for (const { handle, tabIndex, touchAction, shortcuts } of handleDefaults) {
        if (tabIndex === null) handle.removeAttribute('tabindex'); else handle.setAttribute('tabindex', tabIndex);
        if (shortcuts === null) handle.removeAttribute('aria-keyshortcuts'); else handle.setAttribute('aria-keyshortcuts', shortcuts);
        handle.style.touchAction = touchAction;
      }
    },
  };
}
