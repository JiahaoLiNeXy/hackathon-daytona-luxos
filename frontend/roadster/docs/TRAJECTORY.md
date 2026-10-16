# 轨迹导入约定

支持 UTF-8 JSON 和 CSV，文件小于 10 MiB，2–50,000 个采样点。导入只替换轨迹并定位到起点，不自动播放。示例 `public/examples/engineer-trajectory.json` / `.csv` 是人工合成的地面行驶与小跳跃，**不是 Tesla、SpaceX 或任何实车测试数据，也不是动力学仿真结果**。

坐标与时间约定：

- 米、秒、右手坐标系；`+X` 车头前方，`+Y` 向上，`+Z` 车辆右侧。世界坐标原点由提供方定义，导入不会平移位置。
- 每个位置指车辆包围盒中心；地面为世界 `y = 0`，正常着地时中心高度应为车高的一半。不要直接使用底盘、轮心或 GPS 天线位置。
- `t` 必须是有限数字且严格递增；首个时间会减去，使播放从 `0` 秒开始。`timeOffset` 保留原始首个时间。
- 姿态为从车辆局部坐标到世界坐标的单位四元数，顺序 **`[x,y,z,w]`**；导入会归一化非零四元数。恒等姿态 `[0,0,0,1]` 表示车头朝 `+X`、车顶朝 `+Y`。
- 位置采用线性插值，姿态采用最短弧球面插值（slerp），越界时间停在首尾采样点。轨迹包含急转、整圈翻滚时，应增加中间姿态采样；仅两个等价四元数不能表达完整一圈。
- 姿态必须全部提供或全部省略。省略时按相邻非重合路径点推导航向及俯仰（Y 轴航向后乘 Z 轴俯仰），无侧倾；纯竖直段沿用前一个航向，静止轨迹使用恒等姿态。推导不等于测得姿态，真实侧倾、倒置或翻滚需提供四元数。

JSON 可使用数组形式：

```json
{
  "version": 1,
  "label": "合成示例（非实测）",
  "units": "m",
  "upAxis": "Y",
  "samples": [
    {"t": 10, "position": [0, 0.63, 0], "quaternion": [0, 0, 0, 1]},
    {"t": 11, "position": [2, 0.63, 0], "quaternion": [0, 0, 0, 1]},
    {"t": 12, "position": [4, 1.2, 0], "quaternion": [0, 0, 0.0871557, 0.9961947]}
  ]
}
```

也支持每行 `{ "t": 0, "x": 0, "y": 0.63, "z": 0, "qx": 0, "qy": 0, "qz": 0, "qw": 1 }`。若给出元信息，只接受 `version: 1`、`units: "m"`、`upAxis: "Y"`；其他坐标系需在导出前转换。

CSV 表头为 `t,x,y,z,qx,qy,qz,qw`，省略姿态时为 `t,x,y,z`；允许调整列顺序。仅接受逗号分隔的十进制数字（可用科学记数法），不接受空数值或其他列。CSV 固定使用上述米 / 秒 / Y 向上约定。

模块接口：`parseTrajectory(text, filename)` 解析文件；`normalizeTrajectory(data)` 校验 JavaScript 对象；`sampleTrajectory(trajectory, t)` 返回 Three.js 的 `Vector3` 和 `Quaternion`。返回轨迹含 `samples`、`duration`、`timeOffset`、`label`、`warnings`、`source: "imported"`。调用方应展示 `warnings`，并自行管理暂停、播放和时间状态。
