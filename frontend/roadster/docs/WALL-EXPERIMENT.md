# 桌面投影避障试验

所有操作、结果与动画位于桌面 projector UI 中。`physics-handoff.html` 现在直接进入同一桌面，不再显示外层工程按钮或 JSON 调试栏。

## 操作

1. 无墙时点模型上的 **Run**，即可实时计算并播放原来的高弯折返跑道。
2. 点 **Add wall**，或在模型上把墙拖到新位置。松手后自动开始原路线试跑；输入位置、高度或速度后也会重新试跑。
3. 原车跑到碰撞处后，自动按当前墙的位置调整跑道、重新求解，再播放前后对比。**Run** 可重做整个流程；**Adjust ramp** 也可手动触发。
4. **Original path / Adjusted path / Compare** 可查看已计算结果；播放、暂停和时间轴都在桌面模块内。

移动墙会取消旧的计算与自动调整链。拖动过程中不逐帧启动求解，松手后才提交最终位置。原路线本来就安全时不强行改动；有限搜索失败会显示没有找到路线，不播放替代动画。

搜索先尝试改变进场段；若墙挡住原坡道连接点、导致该类候选全部不可用，再有限搜索连接位置的水平移动。后者保留原高弯/顶部折返的相对形状，保留起点和物理参数，并在结果中显示 `joinShiftXM`。它不保证任何墙位置都能找到方案。

## 运行

需要 Node.js 18+ 与 Python 3.9+（macOS/Linux 命令 `python3`，Windows `python`），无 pip 包或 API key 依赖。

```sh
npm ci
npm run dev
```

打开 `http://127.0.0.1:4178/`。也可 `npm run build` 后停止 dev，再运行 `npm run preview`。Vite 的 dev/preview 均提供同源求解接口。仅复制 `dist/` 到静态托管可以显示模型，但不能运行实时计算；宿主需要同时接入服务。

## 实时服务接口

`POST /api/obstacle`，`Content-Type: application/json`：

```json
{
  "action": "trial",
  "problemSpec": {
    "ramp_curve_m": [{"x":-25,"y":0},{"x":-6,"y":0},{"x":0,"y":7}],
    "entry_speed_ms":22.2,
    "car_mass_kg":1300,
    "downforce_capability_n":150000,
    "ground_profile":{"type":"flat","landing_level_m":0}
  },
  "wall":{"enabled":true,"x":-18,"height":3,"width":8,"thickness":0.35},
  "scale":1
}
```

`action: "trial"` 也允许 `wall.enabled=false`，计算无墙行驶；此时没有进行墙体检查。`action: "adjust"` 要求启用墙并执行搜索。返回 `{before, after, search}`：每个结果包含原始 `problemSpec`、完整 Physics `result`、`assessment`；`after` 无解时为 `null`，成功时另含 `adjustment`。示例 JSON 仅说明契约，不是预设成功案例。

- `assessment.status` 是 `clear` / `collision` / `invalid`。`firstHit` 给出播放时间和原始/显示位置；不是精确刚体接触时刻。
- `result.execution.sandbox_id` 为此次进程的 `local-live-*`。没有调用 Daytona，也没有伪装成云端执行。
- 请求只接受有限范围数值；固定可信 Python 文件执行，不接收客户端代码。支持取消，限制并发、输入大小、执行时长与输出大小。
- 当前搜索针对从水平进场段连接到回弯主体的坡道，可在有限范围内移动连接位置。未找到方案只说明本次有限搜索失败，不证明所有可能设计都无解。

## 前端调用

原来的 `setRampCurve(points)` / `loadPhysicsResult(payload)` / `loadTrajectory(data)` / `play()` / `pause()` / `seek(seconds)` 和浮动模块接口保留。新增：

```js
const sim = window.roadsterSim;
sim.setWall({enabled:true,x:-18,height:3});
await sim.run(); // 原路线试跑 -> 播放到碰撞 -> 调整 -> 重算 -> 对比播放
// 分步控制仍可使用 await sim.runTrial() / await sim.adjustRamp()
const state = sim.getState();
```

同源 iframe 的 `roadster:command` 桥支持这些异步调用，在计算完成后返回带相同 `requestId` 的 `roadster:result` / `roadster:error`。跨源命令不处理。调用方改变条件会取消过时请求，旧结果不会覆盖新条件。

四个模块 id 不变：`scene-panel`、`edit-panel`、`motion-panel`、`assets-panel`。切换入口位于模型投影内，模块可拖动、收起；没有页面外的固定工具栏。

## 计算边界与来源

- 复用提供的 Physics Agent 固定 Python 算法，原数学公式未修改；出处与包装差异见 [SOURCE.md](../server/vendor/SOURCE.md)。本机包包含求解文件，不依赖隔壁仓库的实时状态。
- 仍是无摩擦二维质点/弹道模型，展示姿态来自速度方向。22.2 m/s、1300 kg、150000 N 是可比较的试验假设，不能当成已确认实车数据。
- 车模中心的半车高显示补偿与之前接口一致，原始 `position` 坐标不修改。
- 完整播放轨迹的每个相邻采样区间使用 Three.js OBB 与平移/旋转运动包络递归检查，默认安全余量 0.15 m，命中区间的剩余包络误差不超过 0.03 m。会检查进入坡道和回向飞行，不能仅凭某个离散采样没有碰撞就宣布通过。
- `clearanceM` 为 `null`，没有声称计算了精确最小净空。通过表示在该可视模型及车身包络下避开墙，不是轮胎、悬架、结构承载或真实车辆安全验证。钢支撑保持视觉模型，不参与结构计算。

实现使用 [Three.js OBB](https://threejs.org/docs/pages/OBB.html) 与 [Vite middleware](https://vite.dev/guide/api-plugin.html#configureserver)；不需要新增物理引擎或 Web 框架。
