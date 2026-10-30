# 移动端评估：现实循环切片机

日期：2026-10-29。本机 Android 构建条件：无 JDK、无 Android SDK（见 shadow-craft/docs/mobile-eval.md 同一套实测）。

## 结论

- **可行**：抽帧（canvas）、评分（纯 JS）、交叉溶解（canvas）、导出（MediaRecorder/WebCodecs）全部为浏览器能力，Capacitor 包装即可。
- **风险**：移动端 MediaRecorder/WebCodecs 编码器可用性需真机验证（本桌面环境已实测 MediaRecorder 失效、WebCodecs 可用——跨端时优先 WebCodecs 路线）；视频 seek 解码在低端机较慢。
- **工作量估计**：2–3 天（含真机调优与内存阈值收紧）。

## 状态

- [x] 移动端评估（本文件）
- [ ] Android APK 交付——**未验证**（工具链未装）
