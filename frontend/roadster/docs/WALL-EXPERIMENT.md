# 桌面投影避障试验

所有操作、结果与动画位于桌面 projector UI 中。`physics-handoff.html` 现在直接进入同一桌面，不再显示外层工程按钮或 JSON 调试栏。

## 操作

1. 点 **放墙**，在模型上拖动墙，或修改位置/高度。
2. 点 **试跑**。当前坡道和速度送到本地 Python 求解器；车身包络碰墙时播放停在碰撞处。
3. 点 **调整跑道**。根据当前墙搜索平滑的进场坡道，逐个重新求解并检查完整行程；速度、质量和下压力不因搜索而改变。
4. **对比**把原路线和新路线放在同一坐标、同一镜头里。原车停在碰撞处，新车继续。也可单独看原路线或新路线。

移动墙、修改速度、换入跑道或改变车模尺寸后，旧结果失效，必须重新试跑。没有可行候选时明确显示“当前搜索范围内未找到可行跑道”，不会播放替代的成功动画。

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

`action: "adjust"` 执行搜索。返回 `{before, after, search}`：每个结果包含原始 `problemSpec`、完整 Physics `result`、`assessment`；`after` 无解时为 `null`，成功时另含 `adjustment`。示例 JSON 仅说明契约，不是预设成功案例。

- `assessment.status` 是 `clear` / `collision` / `invalid`。`firstHit` 给出播放时间和原始/显示位置；不是精确刚体接触时刻。
- `result.execution.sandbox_id` 为此次进程的 `local-live-*`。没有调用 Daytona，也没有伪装成云端执行。
- 请求只接受有限范围数值；固定可信 Python 文件执行，不接收客户端代码。支持取消，限制并发、输入大小、执行时长与输出大小。
- 当前搜索针对从水平进场段连接到回弯主体的坡道。未找到方案只说明本次有限搜索失败，不证明所有可能设计都无解。

## 前端调用

原来的 `setRampCurve(points)` / `loadPhysicsResult(payload)` / `loadTrajectory(data)` / `play()` / `pause()` / `seek(seconds)` 和浮动模块接口保留。新增：

```js
const sim = window.roadsterSim;
sim.setWall({enabled:true,x:-18,height:3});
await sim.runTrial();
await sim.adjustRamp();
sim.compare('compare'); // before / after / compare
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
