# 模型资产档案

核对日期：2026-10-16。用户已认可当前车辆与坡道外形；本次工程交付补齐消息接口，沿用现有界面、模型、轨迹逻辑和参考记录。以下数值来自当前项目文件，**属于可编辑的视觉重建假设，不是 Tesla 官方尺寸、CAD 或实测数据**。

## 文件与职责

| 文件 | 内容 / 入口 |
| --- | --- |
| [`src/car.js`](../src/car.js) | 程序化银灰色 2026 Roadster；`createRoadster()`、`CAR_DIMENSIONS`。车身、玻璃、灯具、轮组等独立网格及元数据均保留。 |
| [`src/track.js`](../src/track.js) | 灰色反弯坡面、红边、白中线和背部桁架；`createTrack(options)`、`TRACK_DEFAULTS`、`rampPoint(u, height)`；也包含合成演示轨迹 `makeDemoTrajectory()`。 |
| [`src/trajectory.js`](../src/trajectory.js) | `parseTrajectory()`、`normalizeTrajectory()`、`sampleTrajectory()`；负责文件校验及位置 / 姿态插值，不求解动力学。 |
| [`public/models/roadster-2026.glb`](../public/models/roadster-2026.glb) | 独立车辆，883,012 bytes。 |
| [`public/models/launch-ramp.glb`](../public/models/launch-ramp.glb) | 默认坡道及桁架，431,596 bytes。 |
| [`public/models/roadster-scene.glb`](../public/models/roadster-scene.glb) | 默认组合场景，1,316,120 bytes；车辆中心位于 `[-24, 0.63, 0]`，坡道保留原始坐标。 |
| [`scripts/export-assets.mjs`](../scripts/export-assets.mjs) | 从上述源码生成三个默认 GLB 和 `public/examples/illustrative-launch.json`；使用 Three.js `GLTFExporter`。 |
| [`scripts/check-assets.mjs`](../scripts/check-assets.mjs) | 重新加载 GLB 并检查资产与车辆边界。 |
| [`docs/TRAJECTORY.md`](TRAJECTORY.md) | 工程师轨迹数据契约、单位、四元数及导入限制。 |
| [`references/SOURCES.md`](../references/SOURCES.md) | Tesla 活动页、Dezeen、CBS/AFP、Euronews、Car and Driver、AP 的来源链接、访问情况与证据边界。 |

GLB 可由标准 `GLTFLoader` 独立加载，不要求使用本项目界面。当前模型使用几何体与材质，无需外部纹理图片。

## 坐标与车辆尺度

- 单位为米、秒，采用右手坐标系：`+X` 为车辆前方，`+Y` 向上，`+Z` 为车辆右侧。
- 车辆局部原点是视觉包围盒中心。名义长 × 宽 × 高为 **4.65 × 2.05 × 1.18 m**，分别对应 X、Z、Y 方向。
- 地面基准为世界 `y=0`。车辆中心的几何着地参考高度为 `1.18 / 2 = 0.59 m`；默认演示及组合导出额外保留 `0.04 m` 间隙，因此使用 `0.63 m`。
- 轮组保留独立 `Wheel_*` 节点；源码轮胎半径为 `0.355 m`，滚动轴为局部 Z。材质、轮轴位置、车身剖面等假设位于 `src/car.js`。
- `CAR_DIMENSIONS` 记录名义尺寸；网格由源码中的截面和部件尺寸生成。仅修改此常量不会自动按比例重建所有网格。整体缩放应作用于车辆根节点；改外形需修改相应几何定义。
- 轨迹的每个位置均表示车辆包围盒中心。四元数顺序为 `[x,y,z,w]`，将车辆局部坐标转换到世界坐标；恒等四元数 `[0,0,0,1]` 表示车头朝 +X。

## 坡道默认值与曲线

`createTrack(options)` 合并以下 `TRACK_DEFAULTS`；本轮界面改造保留这些源码默认值。

| 参数 | 默认值 | 当前源码含义 |
| --- | --- | --- |
| `height` | `23` m | 坡面中心线出口的 Y 高度；只按 `height / 23` 缩放曲线 Y 分量，X 保持不变。不是整套桁架包围盒高度。 |
| `width` | `5.6` m | 坡面横向宽度，Z 从 `-2.8` 到 `+2.8`；支撑和底座可超出坡面。 |
| `approach` | `25` m | 水平入口的 X 坐标为 `-approach`；默认从 `x=-25` 到弯曲起点 `x=-6`，水平段长 19 m。 |
| `thickness` | `0.28` m | 下层钢面相对坡面沿局部法线的偏移量。 |

中心线处于 `z=0`，由两段三次贝塞尔曲线组成；以下坐标为默认 23 m 高度下的 `[x,y,z]`：

| 范围 | 起点 | 控制点 1 | 控制点 2 | 终点 |
| --- | --- | --- | --- | --- |
| `u=0…0.35` | `[-6,0,0]` | `[-1.8,0,0]` | `[0,2.8,0]` | `[0,7,0]` |
| `u=0.35…1` | `[0,7,0]` | `[0,14,0]` | `[-2.2,18,0]` | `[-5.5,23,0]` |

这形成入口过渡、近竖直段和上部向负 X 反弯的悬挑。曲率、悬挑、桁架杆径、支撑位置与材料参数均可在源码修改；没有测绘或结构计算背书。

## 轨迹保留与重用

- [`public/examples/illustrative-launch.json`](../public/examples/illustrative-launch.json) 来自 `makeDemoTrajectory()`：默认 10 秒，包含接近、爬坡、空中翻转和着地后的移动。默认车辆离坡面距离为 `vehicleHeight / 2 + 0.04`。
- [`engineer-trajectory.json`](../public/examples/engineer-trajectory.json) 与 [`engineer-trajectory.csv`](../public/examples/engineer-trajectory.csv) 是工程接口示例。所有内置示例均为人工合成，不是实车记录或物理仿真结果。
- 导入保留空间坐标，只将首个时间归零。位置线性插值；姿态采用归一化四元数的最短弧 slerp。缺少姿态时仅按路径推导航向和俯仰，不推断真实侧倾或翻滚。
- 修改车辆尺度或坡道不等于重算工程师轨迹；轨迹需要由其数据来源重新输出。完整约束见 `docs/TRAJECTORY.md`。

## 资产基线与旧界面归档

本次交付的模型与源码 SHA256 记录在 [PRESERVED-ASSETS.json](PRESERVED-ASSETS.json)：

```text
public/models/roadster-2026.glb  6e6ea33ceafe6100bffadb7dce01322ea012fa4b8f4fc91a1a4d2c49beacc385
public/models/launch-ramp.glb    d21c32c1cea0515f64abdd1befd4f9084c40f9bb3bb4069ad68143aeead56f37
public/models/roadster-scene.glb 90d4732f97bb3a581eef37053d29b2da8340b4f42f18f404e598b4998bfed941

src/car.js        17ab1a419283d8cf163e8b188ac6ca6e91cda43a020bd5ce6a778e0177c54fb8
src/track.js      facb2ce7245ebeea3b3d7d0d59ef8f61f18712c1b94aca218a197c12bdbb548b
src/trajectory.js 69edf30c75d1063c76c0ba1efd510e03a780be8ed051caefc289bd38d5319231
```

本次交付继续引用 `public/models/` 与上述模型源码，不重新生成或覆盖这三个 GLB。`scripts/check-preservation.mjs` 同时验证模型、样式、背景和产品界面标记保持一致。
