# 现实循环切片机（loop-slicer）

从你的一段视频里，自动找出**最适合无缝循环**的片段，导出成动态壁纸素材（WebM）。

## 它是什么

- 三步向导：导入视频 → 自动推荐 3 个最佳循环片段（可滑块微调）→ 循环预览并导出。
- 真实分析：`<video>` 逐帧 seek 抽成 160×90 灰度序列（0.1 秒步长，最多分析前 60 秒），滑窗 1.5–6 秒评分＝首尾帧差异 × 运动量加权，全在本地完成。
- 真实导出：末尾 0.3 秒与开头线性交叉溶解，canvas + `MediaRecorder` 重编码为 WebM（VP9/VP8），导出为实时时长，进度如实显示。

## 它不是什么

- 不生成、不脑补任何画面，只从你的视频里挑片段。
- 导出的素材没有声音。
- 输出只有 WebM 格式，不转 MP4/GIF。
- 不联网，视频不会离开你的电脑。
- 画面运动剧烈时，首尾溶解处会有轻微重影（溶接原理决定，导出前可预览确认）。

## 安装与使用

- 安装：运行 `交付物` 里的 `LoopSlicer-<版本>-Setup.exe`（未签名，系统如提示请选择"仍要运行"）。安装后从开始菜单打开「现实循环切片机」。
- 卸载：Windows 设置 → 应用 → 已安装的应用 → 现实循环切片机 → 卸载（与标准桌面程序一致）。

## 开发命令

```bash
npm install        # 安装依赖
npm test           # 引擎单元测试（node --test）
npm run build      # 先 tsc --noEmit 类型检查，再用 esbuild 构建 main/preload/renderer 到 dist/
npm run smoke      # 真实启动 Electron：合成视频→分析→循环导出→EBML 校验
npm run dev        # 构建 + 打开应用
npm run make       # electron-forge 打包（中文路径需先 subst，见 docs/implementation-status.md）
```

## 架构

- `src/main`：Electron 主进程（窗口、保存对话框、说明书 PDF、`--smoke` 冒烟校验）。
- `src/preload`：contextIsolation 下的窄接口（saveWebm / exportManualPdf / smoke 三件套）。
- `src/renderer`：React 三步向导 UI；分析、循环渲染、MediaRecorder 导出都在渲染进程。
- `src/domain/loop.cjs`：纯 JS 循环评分引擎（可被 node 直接测试），`tests/loop.test.cjs` 为合成序列夹具测试。
- `resources/manual.html`：内置图文说明书，经主进程 printToPDF 导出。

## 已知限制

- 源视频超过 60 秒只分析前 60 秒（内存保护，界面有提示）。
- 分析与推荐基于 160×90 灰度缩略图，靠色彩区分（近乎同灰度）画面的首尾贴合度可能偏高。
- 导出分辨率沿用源视频（最长边不超过 1920），导出耗时≈片段时长（实时重录）。
- Windows 安装包未做代码签名。

## 第三方

- Electron 44.9.3、React 19.1.1、esbuild 0.25.11、TypeScript 5.9.3、@electron-forge 7.10.2（MIT/BSD 系许可，见 node_modules 内各包声明）。

## 许可

MIT
