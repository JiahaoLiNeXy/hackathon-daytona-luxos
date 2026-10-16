export const projectorMarkup = `
<main id="desk" class="desk">
 <section id="scene-panel" class="projection scene-panel" data-panel aria-label="Roadster model">
  <header class="panel-handle" data-drag-handle tabindex="0" aria-label="Move model panel"><span class="handle-grip">⠿</span><h1>Roadster</h1><span id="scene-state" class="scene-state">Ramp test</span></header>
  <div class="viewport" id="viewport"><div id="scene-legend" class="scene-legend" hidden><span class="before-key">Original path</span><span class="after-key">Adjusted path</span></div><div id="wall-hint" class="wall-hint" hidden>Drag the wall to move it</div></div>
  <div class="scene-tools"><div class="view-switch"><button id="view-scene" class="active">3D</button><button id="view-side">Side</button><button id="view-car">Car</button></div><button id="reset-view" aria-label="Reset view">↺</button><span class="tool-spacer"></span><button data-toggle-panel="edit-panel">Wall</button><button data-toggle-panel="motion-panel">Play</button><button data-toggle-panel="assets-panel">Files</button></div><span class="resize-mark"></span>
 </section>
 <section id="edit-panel" class="projection edit-panel" data-panel aria-label="Wall test">
  <header class="panel-handle" data-drag-handle tabindex="0" aria-label="Move test panel"><span class="handle-grip">⠿</span><h2>Wall test</h2><button class="icon-button close-panel" data-close-panel="edit-panel" aria-label="Close test panel">×</button></header>
  <div class="panel-content">
   <button id="wall-add" class="wide primary">+ Add wall</button>
   <div id="wall-fields" hidden>
    <div class="row"><label for="wall-x">Position</label><span class="input-unit"><input id="wall-x" type="number" min="-35" max="5" step="0.5" value="-18">m</span></div>
    <input id="wall-position" type="range" min="-35" max="5" step="0.25" value="-18" aria-label="Wall position">
    <div class="row"><label for="wall-height">Height</label><span class="input-unit"><input id="wall-height" type="number" min="1" max="25" step="0.5" value="3">m</span></div>
    <button id="wall-remove" class="quiet">Remove wall</button>
   </div>
   <div class="rule"></div><div class="row"><label for="entry-speed">Entry speed</label><span class="input-unit"><input id="entry-speed" type="number" min="5" max="40" step="0.5" value="22.2">m/s</span></div>
   <div class="experiment-actions"><button id="trial-button" class="primary" disabled>Run</button><button id="adjust-button" disabled>Adjust ramp</button></div>
   <p id="experiment-status" role="status" class="experiment-status">Add a wall to start</p>
   <div id="comparison-results" class="comparison-results" hidden><div><span>Before</span><strong id="before-result">—</strong></div><div><span>After</span><strong id="after-result">—</strong></div><p id="adjustment-detail"></p></div>
   <div id="comparison-actions" class="comparison-actions" hidden><button id="show-before">Original path</button><button id="show-after">Adjusted path</button><button id="show-compare" class="active">Compare</button></div>
   <small class="model-note">2D point-mass model · Vehicle envelope check</small>
  </div>
 </section>
 <section id="motion-panel" class="projection motion-panel is-hidden" data-panel aria-label="Playback results">
  <header class="panel-handle" data-drag-handle tabindex="0" aria-label="Move playback panel"><span class="handle-grip">⠿</span><h2>Play</h2><span id="source-name" class="source-tag">Ready to run</span><button class="icon-button close-panel" data-close-panel="motion-panel" aria-label="Close playback panel">×</button></header>
  <div class="panel-content"><div class="play-controls"><button id="play" class="primary">▶ Play</button><button id="restart" aria-label="Replay">↺</button><select id="speed" aria-label="Playback speed"><option value="0.25">¼×</option><option value="0.5">½×</option><option value="1" selected>1×</option><option value="2">2×</option></select><span id="time-label" class="time-label"></span></div><input id="timeline" type="range" min="0" max="0" step="0.001" value="0" aria-label="Time"><div id="physics-readout" class="physics-readout" hidden></div></div>
 </section>
 <section id="assets-panel" class="projection assets-panel is-hidden" data-panel aria-label="Files">
  <header class="panel-handle" data-drag-handle tabindex="0" aria-label="Move files panel"><span class="handle-grip">⠿</span><h2>Files</h2><button class="icon-button close-panel" data-close-panel="assets-panel" aria-label="Close files panel">×</button></header>
  <div class="panel-content"><button id="import-button" class="wide primary">Import path</button><div class="export-list"><button id="export-car">Export car <small>GLB ↧</small></button><button id="export-ramp">Export ramp <small>GLB ↧</small></button><button id="export-scene">Export scene <small>GLB ↧</small></button><button id="export-result">Export results <small>JSON ↧</small></button><button id="snapshot">Save image <small>PNG ↧</small></button></div><div class="rule"></div><button id="reset-experiment" class="wide">Reset test</button></div>
 </section>
 <section id="voice-panel" class="projection voice-panel is-hidden" data-panel aria-label="Voice feedback">
  <header class="panel-handle" data-drag-handle tabindex="0" aria-label="Move voice panel"><span class="handle-grip">⠿</span><h2>Voice</h2><span id="voice-phase" class="voice-phase"></span><button class="icon-button close-panel" data-close-panel="voice-panel" aria-label="Close voice panel">×</button></header>
  <div class="panel-content"><p id="voice-transcript" class="voice-transcript"></p><p id="voice-action" class="voice-action" role="status" aria-live="polite"></p></div>
 </section>
 <input id="file-input" type="file" accept=".json,.csv" hidden><div id="toast" class="toast" role="status"></div>
</main>`;
