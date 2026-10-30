# 现实循环切片机 docs/implementation-status.md（追加式）

## 2026-10-29 初建（首轮开发）

本轮目标：按 docs/plan.md 开发"现实循环切片机"——从用户视频找最适合无缝循环的片段，生成动态壁纸素材。三步向导 UI、真实评分引擎、MediaRecorder 实时导出、Squirrel 安装包与安装/卸载实测。工程骨架照抄 shadow-craft（Electron+React+TS+esbuild）。

### 已实现（代码存在，能编译）

- 工程骨架：package.json（name: loop-slicer，productName: 现实循环切片机，maker-squirrel 显式 title="现实循环切片机"，executableName: LoopSlicer）、tsconfig、scripts/{build,smoke,make-offline}.mjs。
- 循环引擎 `src/domain/loop.cjs`：frameDiff / adjacentDiffs / findBestWindows（滑窗 1.5–6s、评分=首尾帧差异×运动量加权、死画面与跳变双门槛、不重叠 top-3）/ crossfadePlan（末尾 0.3s 线性溶解权重）/ motionLabel。
- 单元测试 `tests/loop.test.cjs`：15 项，全部程序合成帧序列夹具（周期运动点、静止序列、噪声序列、双场景、溶解计划）。
- 三步向导 UI `src/renderer/App.tsx`：导入视频（>60s 提示裁剪）→ 逐帧 seek 160×90 灰度抽帧 → 推荐 3 卡片（首尾贴合百分比 + 画面变化人话标签）+ 开始/长度滑块 → 双视频交叉溶解循环预览 + MediaRecorder 实时导出 WebM（进度如实）。
- 主进程 `src/main/index.ts`：save-webm（对话框 + EBML 头校验）、export-manual-pdf（printToPDF）、--smoke 模式、Squirrel 安装/卸载事件自管理快捷方式（见下）。
- 说明书 `resources/manual.html`（是什么/准备什么/三步/常见问题/它不是什么/原理）、README.md、LICENSE。

### 已实测（2026-10-29，命令与数字）

1. **npm install**：481 包，37s，退出码 0。
2. **npm test（单元测试）**：15/15 通过（2026-10-29 04:30 后复跑仍 15/15）。
3. **反向对照**（18 号规范第三节，记录在 docs/reverse-contrast.log）：
   - 第 1 轮：把 `motionWeightOf` 改成恒返 1（死画面/跳变不再压低）→ `npm test` 15 项中 4 项变红（not ok 4/8/9/10：静止序列返回了候选、噪声序列返回了候选、死运动区窗口被推荐）。
   - 第 2 轮：把 `boundarySimOf` 改成 `boundaryDiff/(boundaryDiff+4)`（首尾差异越大贴合度越高）→ 4 项变红（not ok 5/6/7/11：最佳窗口不再是首尾重合窗口、排序颠倒、双场景覆盖断言失败）。
   - 恢复后复跑：15/15 全绿。两次改错都被测试抓住，断言"能失败"得到证明。
4. **typecheck**：`npx tsc --noEmit` 退出码 0。
5. **npm run smoke（端到端）**：真实 Electron 启动 → 渲染进程用 canvas 画周期运动点录制 3 秒合成视频（MediaRecorder）→ 走用户同款管线（ObjectURL→逐帧 seek 抽 160×90 灰度帧→findBestWindows）→ 双视频交叉溶解导出 WebM → 主进程校验退出码。最近一次（2026-10-29 04:53）：合成输入 2.95s / 29 帧 / 1 个候选；最佳循环从 0.4s 起长 2s、首尾差 0.01、贴合度 100%；导出 11,909 字节 video/webm;codecs=vp9，EBML 头（1A 45 DF A3）校验通过 → SMOKE PASS，退出码 0。日志：docs/smoke.log。
6. **冒烟过程中实锤并修复的两个环境级问题**（探针脚本实测后移除，结论留存）：
   - 隐藏窗口（show:false）里合成器几乎不出帧（1 秒 4 次 rAF），且游离节点的 canvas.captureStream 无帧可录 → 冒烟窗口改为真实显示 + 录制用 canvas 挂进 DOM 屏幕外（position:fixed;left:-10000px）。
   - **GPU 硬件加速下 MediaRecorder 静默产出 0 字节**（show 窗口 + 挂 DOM 后 rAF 168 次、画布 41 次重绘，仍只有 1 个 size=0 分片、无 error 事件；sandbox:false 同样）；`app.disableHardwareAcceleration()` 走软件编码器后立即正常（1.2 秒录出 5,618 字节分片）。已在主进程固定软件编码，并注明代价。
7. **打包**：subst X: 已映射，在 /x/loop-slicer 下 `MICROSCOPE_PROJECT_DIR=X:/loop-slicer node scripts/make-offline.mjs make` 两次成功（第 1 次后修复快捷方式问题重打）。产物（sha256sum 实测，见 docs/make.log）：
   - `LoopSlicer-0.1.0 Setup.exe` 155,282,944 字节 sha256=eda93843befba4b22bb03e84d30cb2b26e3f2b98d3375147442547cc8d2b45b2
   - `LoopSlicer-0.1.0-full.nupkg` 154,552,789 字节 sha256=1ee2afa08904c2e4791eb4669d9548c117745b9f111eeca1575fd4956d955563
   - `LoopSlicer-win32-x64-0.1.0.zip` 159,940,577 字节 sha256=089ba64138af2b00abb61cfde3299716cea5b8ade02ee6cddd8abbd790b67fbf
   - 打包版直接跑 `LoopSlicer.exe --smoke` 亦通过（第 1 次打包实测 SMOKE PASS，24,940 字节导出）。
8. **安装实测**（18 号规范第六节清单；Setup.exe 先复制到 %TEMP%\LoopSlicerSetup\ ASCII 路径，`env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS` 后 `--silent`）：
   - 退出码 0；安装目录 %LOCALAPPDATA%\LoopSlicer\{LoopSlicer.exe, Update.exe, app.ico, packages, app-0.1.0}；app-0.1.0 内含 LoopSlicer.exe 与 squirrel.exe。
   - 注册表（python winreg 逐项读，HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\LoopSlicer）：DisplayName=现实循环切片机、DisplayVersion=0.1.0、Publisher=Personal instruments、UninstallString="…\Update.exe" --uninstall、InstallLocation、DisplayIcon 全部在位。
   - 快捷方式：开始菜单 + 桌面均生成「现实循环切片机.lnk」（注意：Setup.exe 本身不建快捷方式、Update.exe --createShortcut 只会取 ASCII exe 名，故由应用处理 --squirrel-install/--squirrel-uninstall 自建自删，模式与 compression-microscope 一致）。
   - 启动：从**开始菜单快捷方式**启动，python ctypes EnumWindows 实测窗口进程 app-0.1.0\LoopSlicer.exe，标题 '现实循环切片机'，长度 7，码位逐字比对（0x73b0 0x5b9e 0x5faa 0x73af 0x5207 0x7247 0x673a）一致。
9. **卸载实测**：taskkill 结束应用后 `Update.exe --uninstall` 退出码 0；注册表键清除（OpenKey 抛 OSError）；两个 .lnk 均删除（python 复核不存在）；残留仅为 Squirrel 自删除机制固有项：`.dead` 标记、`Update.exe`、`app-0.1.0\{squirrel.exe, v8_context_snapshot.bin}`。与 18 号规范预期一致。
10. **说明书 PDF 出纸实测**（一次性脚本校验后删除）：dist/manual.html 经 printToPDF 实际产出 `<临时目录>\loopslicer-manual-check.pdf`，%PDF 头校验通过、313,895 字节、约 3 页（"/Type /Page" 计数）。排版内容的逐页人工过目仍未做（见下）。

### 尚未验证 / 未做

- PDF 说明书的逐页排版人工过目（printToPDF 出纸已实测：313,895 字节约 3 页，见上第 10 条）。
- 真实用户视频的人工全流程验收（找循环的"好看程度"主观评价；引擎侧已有合成序列客观测试）。
- 4K/高帧率源视频、10-bit/HDR、损坏文件等边界输入；导出文件在第三方壁纸软件（Wallpaper Engine/Lively）中的实机播放验证。
- GUI 的自动化界面链路测试（当前为真实窗口人工可开 + 冒烟管线自动化）。
- 移动端评估与 APK（plan.md 四项硬要求之一，未开始）。
- git 仓库与开源发布（按本轮边界明确不做）。

### 已知问题（如实记录）

- 导出分辨率沿用源视频（最长边 ≤1920），导出耗时≈片段时长（实时重录），输出仅 WebM、无声音——均为设计边界，UI 已注明。
- 首尾 0.3s 溶解在运动剧烈画面会有轻微重影（溶接原理），UI 已注明并在推荐卡片提示。
- 引擎以 160×90 灰度缩略图 + stride 4 像素采样评分，远小于 4 像素的局部变化可能影响贴合度判定（合成测试用 5px 宽点保证覆盖采样列）。

## 2026-10-29 R-STD 收尾（TASK-LS-01 → 0.1.1）

猫猫初审问题单 `MAJOR-LS-01/02`、`MINOR-LS-03` 的收尾。**功能代码零改动**，改的是工程与打包配置。

### 改了什么

| 文件 | 改动 |
|---|---|
| `package.json` | `version` 0.1.0 → 0.1.1；`author` → `Over9rowth`；`build` 前置 `tsc --noEmit`（ADR-G02）；补 `appCopyright`、`appVersion`、`icon`、完整 `win32metadata`；`ignore` 增加 `^/node_modules`、`^/out`、`^/out-`；squirrel maker 补 `setupIcon` |
| `LICENSE` | 版权行 → `Copyright (c) 2026 Over9rowth` |
| `.gitignore` / `.gitattributes` | 新增（`.gitattributes` 为 `* text=auto eol=lf`，二进制与安装包单独声明） |
| `resources/icon.svg` + 7 张 PNG + `icon.ico` | 新增。深色圆角底 + 青色循环箭头 + 琥珀播放三角 |
| `scripts/make-icon.mjs` | 新增。借隔壁 `compression-microscope` 的 sharp 渲染，不新增依赖 |
| `scripts/make-manual-pdf.mjs` | 新增。说明书 PDF 的可复现生成源 |
| `scripts/smoke.mjs` | 冒烟启动补 `--disable-gpu` 等参数（原因见下） |
| `docs/implementation-status.md`、`docs/make.log`、`docs/smoke.log` | 脱敏 3 处本机路径 |
| `README.md` | 开发命令里说明 `build` 含类型检查 |

### 已实测（2026-10-29 20:40—21:05）

1. `npx tsc --noEmit` → 退出码 0。
2. `npm test` → **15/15 通过**（285 ms）。
3. `npm run build` → `tsc --noEmit && node scripts/build.mjs`，输出 `build ok`。
4. `npm run smoke` → **SMOKE PASS**：合成 2.99s 视频 / 29 帧 / 1 个候选；最佳循环 0.8s 起长 2s、首尾差 0.01、贴合度 100%；导出 24,295 字节 `video/webm;codecs=vp9`，EBML 头校验通过。日志 `docs/smoke-0.1.1.log`（已脱敏）。
5. 打包（subst X: + 离线镜像）→ `LoopSlicer-0.1.1 Setup.exe` 154,053,632 字节，sha256 `fc132aeb3af4c7cb3debf230d0c734de6d2123701ac09d62e8cf365b74c4f523`。
6. exe 版本信息（读安装包内 `app-0.1.1\LoopSlicer.exe` 的 VersionInfo）：`CompanyName Over9rowth` / `FileDescription 现实循环切片机` / `ProductName 现实循环切片机` / `FileVersion 0.1.1` / `ProductVersion 0.1.1` / `LegalCopyright Copyright (c) 2026 Over9rowth` / `OriginalFilename LoopSlicer.exe` / `InternalName LoopSlicer`。
7. 静默安装 → 退出码 0；注册表 `DisplayName 现实循环切片机`、`DisplayVersion 0.1.1`、**`Publisher Over9rowth`**（0.1.0 是 `Personal instruments`）、`InstallLocation %LOCALAPPDATA%\LoopSlicer`、`DisplayIcon` 均在位；安装目录出现 `app-0.1.1\`。
8. 快捷方式：开始菜单 + 桌面均生成「现实循环切片机.lnk」，解析出的目标为 `%LOCALAPPDATA%\LoopSlicer\LoopSlicer.exe`（版本无关 stub，存在）。
9. 安装版 `LoopSlicer.exe --smoke` → **SMOKE PASS**（合成 2.51s / 25 帧；导出 22,002 字节 WebM，EBML 校验通过），证明装出来的包能跑通完整管线。
10. 启动窗口：从 stub 启动后窗口标题 `现实循环切片机`，7 个码位逐字比对一致（0x73b0 0x5b9e 0x5faa 0x73af 0x5207 0x7247 0x673a）。
11. 卸载 `Update.exe --uninstall` → 退出码 0；注册表键清除（`OpenKey` 抛 `FileNotFoundError`）；两个 `.lnk` 均删除；残留仅 `.dead`(1B)、`Update.exe`、`app-0.1.1\squirrel.exe`，属 Squirrel 自删除机制固有项。
12. 说明书 PDF：`npm run manual` → 313,895 字节、`%PDF-1.4`、3 页；内嵌 2 个 `MicrosoftYaHei` 子集（`FontFile2` 计数 2），中文不依赖目标机装字体。
13. 本机路径复扫：`C:\Users` / `86180` / `有点意思` / `FeNix` 在 `src/ tests/ scripts/ resources/ docs/ README/ LICENSE/ package.json` 内 **0 命中**（`SPEC.md` 除外，见下）。

### 本轮踩到的三个坑（改的都是脚本，不是产品代码）

1. **冒烟在无 GPU 的会话里必崩**：`GPU process exited unexpectedly (exit_code=-1073741819)` → `GPU process isn't usable. Goodbye.`，渲染进程一起挂。应用本身已 `disableHardwareAcceleration()`，但仍会起 GPU 进程。`scripts/smoke.mjs` 现在显式带 `--disable-gpu --disable-gpu-sandbox --in-process-gpu --no-sandbox`，只影响本机自动化。
2. **`loadFile` 处理不了中文路径**：生成说明书 PDF 时 `loadFile` 拼出 `file:///<WORKSPACE_ROOT>\...` 并报 `ERR_FAILED (-2)`。改成读文件后走 `data:text/html` 载入即可。
3. **打包 779 MB**：上一版构建目录留在工程里被一起打了进去。已把 `^/out`、`^/out-` 加进 `packagerConfig.ignore`，并在打包前把旧目录移出工程；重打后 154 MB。

### 仍未验证

- 真实生活视频（咖啡热气、雨窗、树影）循环接缝的主观视觉验收 —— 需站长本人看。
- 第三方壁纸软件（Wallpaper Engine / Lively）实机导入播放。
- 本机 ShellExecute 打开 `.lnk` 没有拉起进程（`os.startfile` 与 `cmd /c start` 均如此，进程数为 0）；直接执行 stub 正常。**无法判定是沙箱会话限制还是快捷方式问题**，需在正常桌面会话复核。
- Android APK（仅 `docs/mobile-eval.md` 评估）。
- PDF 逐页人工排版过目。

### 一个需要猫猫决定的遗留

`SPEC.md` 第 26 行按设计把检索模式写成了字面量（含用户名），因此文件里确实存在 `<USER_HOME>` 这段文本。我没改 SPEC（属猫猫的派工文档），源码归档里也已排除 `SPEC.md` 与 `project_meta/`。要不要改写这一行，请猫猫定。
