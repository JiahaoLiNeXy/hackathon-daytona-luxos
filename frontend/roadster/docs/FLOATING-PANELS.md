# Floating panels

`createFloatingPanels({ root, onVisibilityChange, bottomInset = 0 })` controls existing DOM in a
positioned desk. It creates no markup and changes no model or trajectory data.

```js
import { createFloatingPanels } from './floating-panels.js';

const panels = createFloatingPanels({
  root: document.querySelector('.desk'),
  bottomInset: 84, // Reserve the persistent module dock, in CSS pixels.
  onVisibilityChange(id, visible) {
    if (!visible && id === 'scene-panel') pause();
  },
});
panels.show('edit-panel');
```

- Panels are absolute-positioned elements with `data-panel` and a unique `id`.
- A `data-drag-handle` header becomes keyboard-focusable. Buttons, inputs, links,
  and editable regions inside it retain their normal interaction.
- `data-toggle-panel="id"` launches a panel; `data-close-panel="id"` hides it.
- `.is-hidden` must use opacity, visibility, and pointer-events, not `display:none`,
  so hidden panel sizes remain measurable. The controller also maintains `inert`,
  `aria-hidden`, and launcher `aria-pressed`.
- Initial CSS left/right/top/bottom positions remain intact until a move or a
  resize that needs clamping. Positions persist across hide/show.
- Panels are re-clamped and raised when changing from hidden to shown. Repeating
  `show(id)` on an already-visible panel leaves its position and layer unchanged.
  Where available, `ResizeObserver` also watches
  the desk and panel dimensions, covering native resizing and expanding content.
  Observer work is batched into an animation frame and skips unchanged positions.
- `bottomInset` reserves space at the bottom of the desk for a fixed dock. Pointer,
  keyboard, programmatic movement, showing, and resizing use the same reduced bounds.
- Raising the current top panel is a no-op. Panel layers are stably compacted
  before reaching 100 so repeated interaction cannot overtake a dock at z-index 10000.
- Arrow keys on a handle move 12 CSS px; Shift moves 40 px. Escape from anywhere
  inside a panel hides it and returns focus to an available launcher.
- Set responsive maximum width/height and internal overflow in CSS. The fallback
  for oversized modules keeps their top-left title visible, allowing dragging
  while reserving at least 96 px of header width and its actual height.

API: `show(id)`, `hide(id)`, and `toggle(id)` return whether the id exists;
`bringToFront(id)` raises a visible panel without changing focus and returns
`false` for hidden or unknown panels;
`move(id, {x,y})` returns the constrained position or `null`; `getState()` returns
a detached object keyed by id with `{visible,x,y,zIndex}`. Coordinates are `null`
until the controller first positions that panel. `destroy()` removes listeners
and restores handle interaction attributes, leaving the current layout in place.

`onVisibilityChange(id, visible)` runs only when visibility actually changes,
not during initialization or an idempotent show/hide.

Pure geometry tests: `node --test tests/floating-panels.test.js`.
