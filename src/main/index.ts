// Copyright (C) 2026 Over9rowth
// SPDX-License-Identifier: GPL-3.0-only
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';

let win: BrowserWindow | null = null;
const smoke = process.argv.includes('--smoke');

// 必须在 app ready 之前调用。
// 本机实测（scripts/probe，2026-10-29）：开启 GPU 合成时 MediaRecorder 对
// canvas.captureStream 只产出 0 字节分片（编码器静默失败）；禁用硬件加速走
// 软件编码器（libvpx）后录制的 WebM 有真实数据。因此本应用固定软件编码，
// 代价是视频解码/绘制走 CPU——对本工具的用途（短片循环）完全够用。
app.disableHardwareAcceleration();

// Squirrel 安装/卸载事件：自己维护开始菜单与桌面快捷方式。
// 背景：Setup.exe 装完不生成任何快捷方式（本机实测：Squirrel 的 post-install
// hook 只跑了 updateSelf，.lnk 没有创建）；而 Update.exe --createShortcut 建的
// 名字取自 exe 文件名（ASCII），开始菜单会显示 LoopSlicer 而不是中文产品名。
// 所以这里直接写 .lnk：名字用产品名，目标指向版本无关的根级 stub，
// 升级换 app-x.y.z 目录后快捷方式也不会失效。
// 注意不能匹配 --squirrel-firstrun，那是安装后自动启动应用的事件。
const PRODUCT_NAME = '现实循环切片机';
const squirrelEvent = process.platform === 'win32'
  ? ['--squirrel-install', '--squirrel-updated', '--squirrel-uninstall', '--squirrel-obsolete'].find((a) => process.argv.includes(a))
  : undefined;
if (squirrelEvent) {
  try {
    const exeName = path.basename(process.execPath);
    const appDir = path.resolve(path.dirname(process.execPath), '..');
    const stub = path.join(appDir, exeName);
    const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const links = [path.join(startMenu, PRODUCT_NAME + '.lnk'), path.join(app.getPath('desktop'), PRODUCT_NAME + '.lnk')];
    const removing = squirrelEvent === '--squirrel-uninstall' || squirrelEvent === '--squirrel-obsolete';
    if (removing) {
      for (const lnk of links) { try { require('node:fs').unlinkSync(lnk); } catch { /* 本来就不在 */ } }
    } else {
      for (const lnk of links) shell.writeShortcutLink(lnk, 'create', { target: stub, args: '', icon: stub, iconIndex: 0, description: PRODUCT_NAME });
    }
  } catch {
    // 写 lnk 失败时退回 Squirrel 自带机制，至少保证有一条能用的入口。
    try {
      const exeName = path.basename(process.execPath);
      const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
      const args = squirrelEvent === '--squirrel-uninstall' || squirrelEvent === '--squirrel-obsolete'
        ? ['--removeShortcut', exeName] : ['--createShortcut', exeName];
      require('node:child_process').spawnSync(updateExe, args, { timeout: 20000, windowsHide: true, stdio: 'ignore' });
    } catch { /* 尽力而为 */ }
  }
  app.exit(0);
}

function senderCheck(e: { sender: Electron.WebContents; senderFrame: Electron.WebFrameMain | null }) {
  if (!win || e.sender !== win.webContents || e.senderFrame !== win.webContents.mainFrame) throw Error('拒绝未知窗口');
}

/** 把渲染进程传来的导出数据规范成 Buffer 并校验 WebM（EBML）文件头 */
function toWebmBuffer(data: unknown): Buffer {
  const buf = Buffer.isBuffer(data) ? data
    : data instanceof ArrayBuffer ? Buffer.from(data)
    : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    : null;
  if (!buf || buf.length < 16) throw Error('导出数据无效或为空');
  if (!(buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3))
    throw Error('导出的文件不是 WebM（EBML 文件头不符）');
  return buf;
}

/** 打印 HTML -> PDF（A4） */
async function htmlToPdf(html: string): Promise<Buffer> {
  const win2 = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await win2.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 300));
    return await win2.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true });
  } finally {
    win2.destroy();
  }
}

app.whenReady().then(async () => {
  if (!smoke) {
    ipcMain.handle('save-webm', async (e, data: unknown, suggestedName: unknown) => {
      senderCheck(e);
      const buf = toWebmBuffer(data);
      const name = typeof suggestedName === 'string' && suggestedName.endsWith('.webm') ? suggestedName : '循环片段.webm';
      const r = await dialog.showSaveDialog(win!, {
        defaultPath: name,
        filters: [{ name: 'WebM 视频', extensions: ['webm'] }],
      });
      if (r.canceled || !r.filePath) return null;
      await fs.writeFile(r.filePath, buf);
      return { path: r.filePath, bytes: buf.length };
    });

    ipcMain.handle('export-manual-pdf', async (e) => {
      senderCheck(e);
      const html = await fs.readFile(path.join(__dirname, '../manual.html'), 'utf8');
      const r = await dialog.showSaveDialog(win!, {
        defaultPath: '现实循环切片机-说明书.pdf',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (r.canceled || !r.filePath) return null;
      const pdf = await htmlToPdf(html);
      await fs.writeFile(r.filePath, pdf);
      return { path: r.filePath, bytes: pdf.length };
    });
  }

  if (smoke) {
    // 冒烟模式：渲染进程自动跑完整管线（合成视频 → 找循环 → 导出 WebM），结果回传校验
    const os = await import('node:os');
    ipcMain.on('smoke-ready', (e, payload) => {
      try {
        senderCheck(e);
        console.log('[smoke] renderer ready, mounted=' + payload.mounted + ' engineOk=' + payload.engineOk);
        if (!payload.mounted || !payload.engineOk) { app.exit(1); return; }
        win!.webContents.send('smoke:run');
      } catch { app.exit(1); }
    });
    ipcMain.handle('smoke:result', async (e, payload) => {
      try { senderCheck(e); } catch { app.exit(1); return; }
      try {
        const r = typeof payload === 'string' ? JSON.parse(payload) : payload;
        const report = r?.report;
        if (!report || report.error) throw Error('渲染进程报告: ' + (report?.error ?? '无报告'));
        const inp = report.input ?? {};
        const out = report.output ?? {};
        console.log(`[smoke] 合成输入: 时长 ${inp.durationSec}s, 抽帧 ${inp.frames} 帧, 候选 ${inp.candidatesCount} 个`);
        console.log(`[smoke] 最佳循环: 从 ${inp.top?.startTime}s 起 长 ${inp.top?.duration}s, 首尾差 ${inp.top?.boundaryDiff}, 贴合度 ${inp.top?.fitPercent}%`);
        if (!(inp.frames >= 20)) throw Error('抽帧数量异常: ' + inp.frames);
        if (!(inp.candidatesCount >= 1)) throw Error('没有找到循环候选');
        if (!(inp.top?.duration >= 1.0 && inp.top?.duration <= 3.0)) throw Error('最佳窗口时长异常: ' + inp.top?.duration);
        if (!(inp.top?.fitPercent >= 60)) throw Error('最佳窗口贴合度过低: ' + inp.top?.fitPercent + '%');
        if (!(inp.top?.boundaryDiff < 10)) throw Error('最佳窗口首尾差异过大: ' + inp.top?.boundaryDiff);
        if (typeof out.mime !== 'string' || !out.mime.startsWith('video/webm')) throw Error('导出格式异常: ' + out.mime);
        if (!(out.bytes >= 1000)) throw Error('导出文件过小: ' + out.bytes + ' 字节');
        const buf = toWebmBuffer(r.webm);
        if (buf.length !== out.bytes) throw Error(`字节数不符: 渲染层报 ${out.bytes}, 实际 ${buf.length}`);
        const dest = path.join(os.tmpdir(), `loopslicer-smoke-output-${Date.now()}.webm`);
        await fs.writeFile(dest, buf);
        const back = await fs.readFile(dest);
        if (back.length !== buf.length) throw Error('写盘后字节数不符');
        console.log(`[smoke] 导出 WebM ok: ${dest} (${back.length} 字节, ${out.mime}, EBML 头校验通过)`);
        console.log('SMOKE PASS');
        app.exit(0);
      } catch (err) {
        console.log('[smoke] FAIL: ' + String((err as Error).message ?? err));
        app.exit(1);
      }
    });
    setTimeout(() => { console.log('[smoke] 超时未收到渲染进程结果'); app.exit(1); }, 120_000);
  }

  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: '现实循环切片机',
    // 冒烟也用真实可见窗口：canvas.captureStream 依赖真实合成绘制，
    // 隐藏窗口（show:false）里合成器几乎不出帧，录出来是空文件（探针实测）。
    show: true,
    backgroundColor: '#faf7f2',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false, // 被遮挡时不节流计时器/绘制，导出进度与录制才稳定
    },
  });
  win.on('page-title-updated', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  await win.loadFile(path.join(__dirname, '../renderer/index.html'), smoke ? { query: { smoke: '1' } } : undefined);
});

app.on('window-all-closed', () => app.quit());
