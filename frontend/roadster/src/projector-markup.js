export const projectorMarkup = `
<main id="desk" class="desk">
 <section id="scene-panel" class="projection scene-panel" data-panel aria-label="Roadster 模型">
  <header class="panel-handle" data-drag-handle tabindex="0" aria-label="移动模型"><span class="handle-grip">⠿</span><h1>Roadster</h1><span id="scene-state" class="scene-state">坡道试验</span></header>
  <div class="viewport" id="viewport"><div id="scene-legend" class="scene-legend" hidden><span class="before-key">原路线</span><span class="after-key">新路线</span></div><div id="wall-hint" class="wall-hint" hidden>拖动墙改变位置</div></div>
  <div class="scene-tools"><div class="view-switch"><button id="view-scene" class="active">立体</button><button id="view-side">侧面</button><button id="view-car">车模</button></div><button id="reset-view" aria-label="重置视角">↺</button><span class="tool-spacer"></span><button data-toggle-panel="edit-panel">墙</button><button data-toggle-panel="motion-panel">播放</button><button data-toggle-panel="assets-panel">文件</button></div><span class="resize-mark"></span>
 </section>
 <section id="edit-panel" class="projection edit-panel" data-panel aria-label="避障试验">
  <header class="panel-handle" data-drag-handle tabindex="0" aria-label="移动试验"><span class="handle-grip">⠿</span><h2>避障试验</h2><button class="icon-button close-panel" data-close-panel="edit-panel" aria-label="收起试验">×</button></header>
  <div class="panel-content">
   <button id="wall-add" class="wide primary">＋ 放墙</button>
   <div id="wall-fields" hidden>
    <div class="row"><label for="wall-x">位置</label><span class="input-unit"><input id="wall-x" type="number" min="-35" max="5" step="0.5" value="-18">m</span></div>
    <input id="wall-position" type="range" min="-35" max="5" step="0.25" value="-18" aria-label="墙位置">
    <div class="row"><label for="wall-height">高度</label><span class="input-unit"><input id="wall-height" type="number" min="1" max="25" step="0.5" value="3">m</span></div>
    <button id="wall-remove" class="quiet">移除墙</button>
   </div>
   <div class="rule"></div><div class="row"><label for="entry-speed">入场速度</label><span class="input-unit"><input id="entry-speed" type="number" min="5" max="40" step="0.5" value="22.2">m/s</span></div>
   <div class="experiment-actions"><button id="trial-button" class="primary" disabled>试跑</button><button id="adjust-button" disabled>调整跑道</button></div>
   <p id="experiment-status" role="status" class="experiment-status">放一堵墙，开始试验</p>
   <div id="comparison-results" class="comparison-results" hidden><div><span>调整前</span><strong id="before-result">—</strong></div><div><span>调整后</span><strong id="after-result">—</strong></div><p id="adjustment-detail"></p></div>
   <div id="comparison-actions" class="comparison-actions" hidden><button id="show-before">原路线</button><button id="show-after">新路线</button><button id="show-compare" class="active">对比</button></div>
   <small class="model-note">二维质点计算 · 车身包络检查</small>
  </div>
 </section>
 <section id="motion-panel" class="projection motion-panel is-hidden" data-panel aria-label="播放结果">
  <header class="panel-handle" data-drag-handle tabindex="0" aria-label="移动播放"><span class="handle-grip">⠿</span><h2>播放</h2><span id="source-name" class="source-tag">待试跑</span><button class="icon-button close-panel" data-close-panel="motion-panel" aria-label="收起播放">×</button></header>
  <div class="panel-content"><div class="play-controls"><button id="play" class="primary">▶ 播放</button><button id="restart" aria-label="重播">↺</button><select id="speed" aria-label="播放速度"><option value="0.25">¼×</option><option value="0.5">½×</option><option value="1" selected>1×</option><option value="2">2×</option></select><span id="time-label" class="time-label"></span></div><input id="timeline" type="range" min="0" max="0" step="0.001" value="0" aria-label="时间"><div id="physics-readout" class="physics-readout" hidden></div></div>
 </section>
 <section id="assets-panel" class="projection assets-panel is-hidden" data-panel aria-label="文件">
  <header class="panel-handle" data-drag-handle tabindex="0" aria-label="移动文件"><span class="handle-grip">⠿</span><h2>文件</h2><button class="icon-button close-panel" data-close-panel="assets-panel" aria-label="收起文件">×</button></header>
  <div class="panel-content"><button id="import-button" class="wide primary">导入轨迹</button><div class="export-list"><button id="export-car">导出车模 <small>GLB ↧</small></button><button id="export-ramp">导出跑道 <small>GLB ↧</small></button><button id="export-scene">导出场景 <small>GLB ↧</small></button><button id="export-result">导出计算 <small>JSON ↧</small></button><button id="snapshot">保存画面 <small>PNG ↧</small></button></div><div class="rule"></div><button id="reset-experiment" class="wide">重置试验</button></div>
 </section>
 <input id="file-input" type="file" accept=".json,.csv" hidden><div id="toast" class="toast" role="status"></div>
</main>`;
