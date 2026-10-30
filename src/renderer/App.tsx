// Copyright (C) 2026 Over9rowth
// SPDX-License-Identifier: GPL-3.0-only
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { findBestWindows, motionLabel, type LoopWindow } from '../domain/loop.cjs';

declare global {
  interface Window {
    loopslicer: {
      saveWebm: (data: Uint8Array, suggestedName: string) => Promise<{ path: string; bytes: number } | null>;
      exportManualPdf: () => Promise<{ path: string; bytes: number } | null>;
      smokeReady: (p: { mounted: boolean; engineOk: boolean }) => void;
      onSmokeRun: (cb: () => void) => void;
      smokeResult: (payload: unknown) => Promise<void>;
    };
  }
}

const api = window.loopslicer;

const STEP = 0.1;            // 抽帧步长（秒）
const THUMB_W = 160, THUMB_H = 90;  // 分析用灰度缩略图尺寸
const MAX_ANALYZE_SEC = 60;  // 内存保护：最多分析前 60 秒
const MIN_DUR = 1.5, MAX_DUR = 6.0;
const FADE_SEC = 0.3;        // 首尾溶解时长

// ---------- 视频小工具 ----------

function waitMeta(v: HTMLVideoElement): Promise<void> {
  return new Promise((res, rej) => {
    if (v.readyState >= 1 && isFinite(v.duration)) return res();
    const ok = () => { v.removeEventListener('loadedmetadata', ok); v.removeEventListener('error', bad); res(); };
    const bad = () => { v.removeEventListener('loadedmetadata', ok); v.removeEventListener('error', bad); rej(new Error('视频读不出来，可能是不支持的格式，换一个文件试试')); };
    v.addEventListener('loadedmetadata', ok);
    v.addEventListener('error', bad);
    setTimeout(bad, 15000);
  });
}

function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((res) => {
    const done = () => { v.removeEventListener('seeked', done); clearTimeout(g); res(); };
    const g = setTimeout(done, 3000); // seek 卡住也要继续，如实往下走
    v.addEventListener('seeked', done);
    try { v.currentTime = t; } catch { done(); }
  });
}

/** MediaRecorder 产的 webm 常常没有时长（Infinity）：seek 到很远逼浏览器算一次 */
async function forceDuration(v: HTMLVideoElement): Promise<void> {
  await new Promise<void>((res) => {
    const done = () => { v.removeEventListener('seeked', done); clearTimeout(g); res(); };
    const g = setTimeout(done, 3000);
    v.addEventListener('seeked', done);
    try { v.currentTime = 1e7; } catch { done(); }
  });
  await seekTo(v, 0);
}

export function pickMime(): string {
  const list = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const m of list) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

function isEbml(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
}

/**
 * 把录制用 canvas 挂进 DOM 的屏幕外位置（必须有真实布局才会被合成器绘制，
 * canvas.captureStream 才有帧可录；display:none 或游离节点不行）。
 * 返回清理函数。
 */
function attachOffscreen(el: HTMLCanvasElement): () => void {
  el.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;';
  document.body.appendChild(el);
  return () => { el.remove(); };
}

// ---------- 分析：逐帧 seek → 160×90 灰度序列 ----------

interface AnalyzeResult { frames: Uint8Array[]; duration: number; capped: boolean; srcW: number; srcH: number; }

async function analyzeVideo(url: string, knownDuration: number | null, onProgress: ((done: number, total: number) => void) | null): Promise<AnalyzeResult> {
  const v = document.createElement('video');
  v.src = url; v.muted = true; v.playsInline = true; v.preload = 'auto';
  await waitMeta(v);
  let duration = v.duration;
  if (!isFinite(duration) || duration <= 0) {
    await forceDuration(v);
    duration = isFinite(v.duration) && v.duration > 0 ? v.duration : (knownDuration ?? 0);
  }
  if (!(duration > 0.3)) throw new Error('拿不到视频时长，或视频太短（不足 0.3 秒）');
  const capped = duration > MAX_ANALYZE_SEC + 1e-6;
  const maxT = Math.min(duration, MAX_ANALYZE_SEC);
  const c = document.createElement('canvas');
  c.width = THUMB_W; c.height = THUMB_H;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const n = Math.max(2, Math.floor(maxT / STEP + 1e-6));
  const frames: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const t = Math.min(i * STEP, maxT - 0.01);
    await seekTo(v, t);
    ctx.drawImage(v, 0, 0, THUMB_W, THUMB_H);
    const d = ctx.getImageData(0, 0, THUMB_W, THUMB_H).data;
    const g = new Uint8Array(THUMB_W * THUMB_H);
    for (let p = 0, q = 0; p < d.length; p += 4, q++) g[q] = (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) | 0;
    frames.push(g);
    onProgress?.(i + 1, n);
  }
  return { frames, duration, capped, srcW: v.videoWidth || THUMB_W, srcH: v.videoHeight || THUMB_H };
}

// ---------- 循环渲染（预览与导出共用同一套溶解逻辑） ----------

/**
 * 把 [start, start+dur] 的循环画面渲染成一段 WebM：
 * 正常播放窗口内容，最后 fadeSec 与"窗口开头"线性交叉溶解（开头画面叠加着淡入）。
 * 导出为实时时长（dur 秒的片段约需 dur 秒），进度通过 onProgress 如实上报。
 */
async function renderLoopToBlob(
  url: string, start: number, dur: number, outW: number, outH: number,
  onProgress?: (p: number) => void,
): Promise<{ blob: Blob; mime: string }> {
  const mime = pickMime();
  const va = document.createElement('video');
  const vb = document.createElement('video');
  for (const v of [va, vb]) { v.src = url; v.muted = true; v.playsInline = true; v.preload = 'auto'; }
  await Promise.all([waitMeta(va), waitMeta(vb)]);
  const cv = document.createElement('canvas');
  cv.width = outW; cv.height = outH;
  const ctx = cv.getContext('2d')!;
  const detach = attachOffscreen(cv); // 必须真实绘制，captureStream 才有帧
  const fadeSec = Math.min(FADE_SEC, dur / 4);
  await Promise.all([seekTo(va, start), seekTo(vb, start)]);
  ctx.drawImage(va, 0, 0, outW, outH); // 先画一帧，避免录到空画布
  const stream = cv.captureStream(60);
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : { videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise<void>((res) => { rec.onstop = () => res(); });
  rec.start(200);
  vb.pause();
  await va.play();
  let armed = true;
  try {
    await new Promise<void>((res, rej) => {
      const fail = setTimeout(() => rej(new Error('导出超时（视频播放没有走完）')), dur * 1000 + 10000);
      const tick = () => {
        const t = va.currentTime;
        if (t >= start + dur - 0.001 || va.ended) {
          clearTimeout(fail);
          // 最后一帧：开头内容叠加到完全不透明——正是循环回接的那一帧
          ctx.globalAlpha = 1; ctx.drawImage(vb, 0, 0, outW, outH); ctx.globalAlpha = 1;
          res();
          return;
        }
        const remain = start + dur - t;
        if (armed && remain <= fadeSec + 0.001) { armed = false; vb.currentTime = start; vb.play().catch(() => {}); }
        const alpha = armed ? 0 : Math.min(1, Math.max(0, (fadeSec - remain) / fadeSec));
        ctx.drawImage(va, 0, 0, outW, outH);
        if (alpha > 0) { ctx.globalAlpha = alpha; ctx.drawImage(vb, 0, 0, outW, outH); ctx.globalAlpha = 1; }
        onProgress?.(Math.min(0.999, Math.max(0, (t - start) / dur)));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  } finally {
    detach();
  }
  va.pause(); vb.pause();
  rec.stop();
  await stopped;
  onProgress?.(1);
  return { blob: new Blob(chunks, { type: mime || 'video/webm' }), mime: mime || 'video/webm' };
}

// ---------- 冒烟：合成输入（canvas 画运动点 → 录 3 秒 webm） ----------

async function recordSyntheticVideo(sec: number): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 180;
  const ctx = c.getContext('2d')!;
  const detach = attachOffscreen(c); // 必须真实绘制，captureStream 才有帧
  const stream = c.captureStream(30);
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise<void>((res) => { rec.onstop = () => res(); });
  rec.start(200);
  const t0 = performance.now();
  try {
    await new Promise<void>((res) => {
      const draw = () => {
        const t = (performance.now() - t0) / 1000;
        if (t >= sec) { res(); return; }
        // 两个周期运动的点（周期 2.0s 与 1.0s）：t=0 与 t=2 的画面完全重合 → 引擎应找出 ≈2s 的循环
        ctx.fillStyle = '#303030'; ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = '#f5f5f5';
        const x1 = 20 + ((t % 2) / 2) * 260;
        ctx.fillRect(x1, 50, 16, 16);
        const y2 = 20 + ((t % 1) / 1) * 130;
        ctx.fillRect(240, y2, 12, 12);
        requestAnimationFrame(draw);
      };
      requestAnimationFrame(draw);
    });
  } finally {
    detach();
  }
  rec.stop();
  await stopped;
  return new Blob(chunks, { type: mime || 'video/webm' });
}

/** 引擎装载自检：微小合成序列应找到 ≈2s 的贴合窗口（5 宽的点保证 stride=4 采样可见） */
function engineMiniSelfTest(): boolean {
  const W = 16, H = 9;
  const f = (x: number) => {
    const a = new Uint8Array(W * H).fill(40);
    for (let dy = 0; dy < 5; dy++) for (let dx = 0; dx < 5; dx++) a[(3 + dy) * W + (2 + x + dx)] = 200;
    return a;
  };
  const frames: Uint8Array[] = [];
  for (let i = 0; i < 40; i++) frames.push(f(Math.round(((i % 20) / 20) * 9)));
  const got = findBestWindows(frames, { frameInterval: 0.1 });
  return got.length >= 1 && got[0].fitPercent >= 90 && Math.abs(got[0].duration - 2.0) <= 0.3;
}

// ---------- 冒烟主流程：真实"导入→分析→循环导出"端到端 ----------

async function runSmoke() {
  try {
    const inputBlob = await recordSyntheticVideo(3.0);
    const url = URL.createObjectURL(inputBlob);
    const { frames, duration, srcW, srcH } = await analyzeVideo(url, 3.0, null);
    const candidates = findBestWindows(frames, { frameInterval: STEP, minDur: MIN_DUR, maxDur: MAX_DUR });
    if (!candidates.length) throw new Error('合成视频没找到循环候选');
    const top = candidates[0];
    const scale = Math.min(1, 1920 / Math.max(srcW, srcH));
    const outW = Math.max(2, Math.round((srcW * scale) / 2) * 2);
    const outH = Math.max(2, Math.round((srcH * scale) / 2) * 2);
    const { blob, mime } = await renderLoopToBlob(url, top.startTime, top.duration, outW, outH);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!isEbml(bytes)) throw new Error('渲染层导出的文件不是 WebM（EBML 头不符）');
    await api.smokeResult({
      report: {
        input: {
          durationSec: +duration.toFixed(2), frames: frames.length, candidatesCount: candidates.length,
          top: { startTime: top.startTime, duration: top.duration, boundaryDiff: +top.boundaryDiff.toFixed(2), fitPercent: top.fitPercent },
        },
        output: { bytes: bytes.length, mime, width: outW, height: outH },
      },
      webm: bytes,
    });
  } catch (err) {
    try { await api.smokeResult({ report: { error: String((err as Error).message ?? err) }, webm: new Uint8Array(0) }); } catch { /* 已退出 */ }
  }
}

// ---------- 界面 ----------

type Win = { start: number; duration: number; from: number }; // from: 候选序号，-1=手动微调

function App() {
  const [step, setStep] = useState(1);
  const [fileName, setFileName] = useState('');
  const [videoURL, setVideoURL] = useState<string | null>(null);
  const [srcDims, setSrcDims] = useState<{ w: number; h: number } | null>(null);
  const [sourceDur, setSourceDur] = useState(0);
  const [capped, setCapped] = useState(false);
  const [analyzing, setAnalyzing] = useState<{ done: number; total: number } | null>(null);
  const [candidates, setCandidates] = useState<LoopWindow[]>([]);
  const [win, setWin] = useState<Win | null>(null);
  const [exporting, setExporting] = useState<number | null>(null);
  const [saved, setSaved] = useState<{ path: string; bytes: number } | null>(null);
  const [status, setStatus] = useState('准备好啦：先选一段你喜欢的视频');
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState('');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const outSize = (() => {
    if (!srcDims) return { w: 640, h: 360 };
    const scale = Math.min(1, 1920 / Math.max(srcDims.w, srcDims.h));
    return {
      w: Math.max(2, Math.round((srcDims.w * scale) / 2) * 2),
      h: Math.max(2, Math.round((srcDims.h * scale) / 2) * 2),
    };
  })();

  async function onImport(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setErrMsg(''); setSaved(null); setCandidates([]); setWin(null);
    setFileName(f.name);
    const url = URL.createObjectURL(f);
    setVideoURL(url);
    setStatus('正在打开视频…');
    setBusy(true);
    try {
      // 先拿尺寸给导出用（分析内部会再开一个视频）
      const probe = document.createElement('video');
      probe.src = url; probe.muted = true; probe.playsInline = true; probe.preload = 'auto';
      await waitMeta(probe);
      setSrcDims({ w: probe.videoWidth || THUMB_W, h: probe.videoHeight || THUMB_H });
      setStatus('正在逐帧查看视频，找出适合循环的片段…');
      const r = await analyzeVideo(url, null, (done, total) => setAnalyzing({ done, total }));
      setAnalyzing(null);
      setSourceDur(r.duration);
      setCapped(r.capped);
      const cands = findBestWindows(r.frames, { frameInterval: STEP, minDur: MIN_DUR, maxDur: MAX_DUR });
      setCandidates(cands);
      if (!cands.length) {
        setStatus('这段视频里没找到适合循环的片段');
        setErrMsg('画面要么几乎不动，要么变化太剧烈。换一段有持续、轻微运动的视频试试（比如雨点打窗、咖啡热气、树影摇动）。');
        setBusy(false);
        return;
      }
      setWin({ start: cands[0].startTime, duration: cands[0].duration, from: 0 });
      setStep(2);
      setStatus(`找到 ${cands.length} 个不错的循环片段，选一个或用滑块微调`);
    } catch (err) {
      setAnalyzing(null);
      setErrMsg(String((err as Error).message ?? err));
      setStatus('导入出了点问题');
    }
    setBusy(false);
  }

  function pickCandidate(i: number) {
    const c = candidates[i];
    if (!c) return;
    setWin({ start: c.startTime, duration: c.duration, from: i });
    setStatus(`选了推荐 ${i + 1}：从第 ${c.startTime.toFixed(1)} 秒开始，长 ${c.duration.toFixed(1)} 秒`);
  }

  /** 第三步：循环预览（双视频交叉溶解，与导出画面一致） */
  useEffect(() => {
    if (step !== 3 || !videoURL || !win) return;
    const va = document.createElement('video');
    const vb = document.createElement('video');
    for (const v of [va, vb]) { v.src = videoURL; v.muted = true; v.playsInline = true; v.preload = 'auto'; }
    let raf = 0, stopped = false, armed = true;
    const start = win.start, dur = win.duration;
    const fadeSec = Math.min(FADE_SEC, dur / 4);
    const { w: outW, h: outH } = outSize;
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d')!;
    (async () => {
      try {
        await Promise.all([waitMeta(va), waitMeta(vb)]);
        await Promise.all([seekTo(va, start), seekTo(vb, start)]);
        if (stopped) return;
        await va.play().catch(() => {});
        const tick = () => {
          if (stopped) return;
          const t = va.currentTime;
          if (t >= start + dur - 0.002 || va.ended) { va.currentTime = start; vb.pause(); armed = true; }
          const remain = start + dur - va.currentTime;
          if (armed && remain <= fadeSec + 0.001) { armed = false; vb.currentTime = start; vb.play().catch(() => {}); }
          const alpha = armed ? 0 : Math.min(1, Math.max(0, (fadeSec - remain) / fadeSec));
          ctx.drawImage(va, 0, 0, outW, outH);
          if (alpha > 0) { ctx.globalAlpha = alpha; ctx.drawImage(vb, 0, 0, outW, outH); ctx.globalAlpha = 1; }
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch { /* 预览失败不打断界面 */ }
    })();
    return () => { stopped = true; cancelAnimationFrame(raf); va.pause(); vb.pause(); va.removeAttribute('src'); vb.removeAttribute('src'); };
  }, [step, videoURL, win, srcDims]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onExport() {
    if (!videoURL || !win) return;
    setBusy(true); setSaved(null); setExporting(0);
    setStatus(`正在导出（实时进行：${win.duration.toFixed(1)} 秒的片段约需 ${win.duration.toFixed(1)} 秒）…`);
    try {
      const { blob, mime } = await renderLoopToBlob(videoURL, win.start, win.duration, outSize.w, outSize.h, (p) => setExporting(p));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!isEbml(bytes)) throw new Error('导出的文件不是有效的 WebM，请重试');
      const r = await api.saveWebm(bytes, '循环片段.webm');
      if (r) { setSaved(r); setStatus(`已保存：${r.path}（${(r.bytes / 1024).toFixed(0)} KB，${mime}）`); }
      else setStatus('已取消保存（导出的画面没有丢失，可以重新导出）');
    } catch (err) {
      setStatus('出错了：' + String((err as Error).message ?? err));
    }
    setExporting(null);
    setBusy(false);
  }

  async function onManual() {
    setBusy(true);
    try { const r = await api.exportManualPdf(); setStatus(r ? `说明书已保存：${r.path}` : '已取消'); }
    catch (err) { setStatus('出错了：' + String((err as Error).message ?? err)); }
    setBusy(false);
  }

  // 冒烟接线
  useEffect(() => {
    if (!api?.onSmokeRun) return;
    api.onSmokeRun(() => { runSmoke(); });
  }, []);

  const maxStart = videoURL && sourceDur ? Math.max(0, +(sourceDur - MIN_DUR).toFixed(1)) : 0;
  const maxLen = win ? Math.min(MAX_DUR, +(sourceDur - win.start).toFixed(1)) : MAX_DUR;

  const step2Body = win && (
    <>
      <h2>第二步：挑一个循环片段</h2>
      <p className="hint">这是电脑从你的视频里挑出的最顺滑的几段，点卡片选择，也可以用下面的滑块微调。</p>
      <div className="cands">
        {candidates.map((c, i) => (
          <div key={i} className={`cand ${win.from === i ? 'sel' : ''}`} onClick={() => pickCandidate(i)}>
            <div className="name">推荐 {i + 1}</div>
            <div className="fitbar"><div style={{ width: `${c.fitPercent}%` }} /></div>
            <div className="meta">
              首尾贴合 {c.fitPercent}%<br />
              画面变化：{motionLabel(c.motion)}<br />
              从第 {c.startTime.toFixed(1)} 秒起 · 长 {c.duration.toFixed(1)} 秒
            </div>
          </div>
        ))}
      </div>
      <div className="opt">开始位置：第 {win.start.toFixed(1)} 秒
        <input type="range" min={0} max={maxStart} step={0.1} value={win.start}
          onChange={(e) => setWin((w) => w ? { start: +(+e.target.value).toFixed(1), duration: Math.min(w.duration, +(sourceDur - +e.target.value).toFixed(1)), from: -1 } : w)} />
      </div>
      <div className="opt">片段长度：{win.duration.toFixed(1)} 秒
        <input type="range" min={MIN_DUR} max={Math.max(MIN_DUR, maxLen)} step={0.1} value={Math.min(win.duration, Math.max(MIN_DUR, maxLen))}
          onChange={(e) => setWin((w) => w ? { ...w, duration: +(+e.target.value).toFixed(1), from: -1 } : w)} />
      </div>
      {win.from === -1 && <div className="hint" style={{ marginTop: 8 }}>已手动微调（不改变推荐结果本身）</div>}
      {candidates[0] && candidates[0].motion > 20 && (
        <div className="warn">提示：这段视频画面变化比较大，循环首尾的溶解处可能有轻微重影，预览时留意一下。</div>
      )}
      <div className="nextrow">
        <button className="btn ghost" onClick={() => setStep(1)}>← 换个视频</button>
        <button className="btn" onClick={() => { setStep(3); setStatus('正在循环预览，满意就点导出'); }}>下一步：预览并导出 →</button>
      </div>
    </>
  );

  return (
    <div className="app">
      <header>
        <span className="logo">🎬</span>
        <div>
          <h1>现实循环切片机</h1>
          <div className="sub">从一段视频里找出最适合无缝循环的片段，做成动态壁纸素材</div>
        </div>
        <div className="spacer" />
        <button className="link" onClick={onManual} disabled={busy}>📄 查看图文说明书（PDF）</button>
      </header>

      <div className="steps">
        {['导入视频', '挑循环片段', '预览并导出'].map((t, i) => (
          <div key={t} className={`step ${step === i + 1 ? 'active' : ''} ${step > i + 1 ? 'done' : ''}`}>
            <span className="n">{step > i + 1 ? '✓' : i + 1}</span>{t}
          </div>
        ))}
      </div>

      <main>
        <div className="panel">
          {step === 1 && <>
            <h2>第一步：选一段视频</h2>
            <p className="hint">雨中的窗户、咖啡的热气、摇动的树影——有持续轻微运动的画面最适合。不用学任何参数，剩下的交给电脑。</p>
            <label className="btn" style={{ display: 'inline-block' }}>选择视频文件（MP4 / WebM / MOV 等）<input type="file" accept="video/*" onChange={onImport} disabled={busy} /></label>
            {fileName && <span style={{ marginLeft: 12, color: 'var(--muted)', fontSize: 13 }}>{fileName}</span>}
            {videoURL && <video className="videoprev" src={videoURL} controls muted style={{ marginTop: 14 }} />}
            {analyzing && (
              <div className="notice">
                正在逐帧查看视频… {analyzing.done}/{analyzing.total} 帧
                <div className="progress"><div style={{ width: `${(analyzing.done / analyzing.total) * 100}%` }} /></div>
              </div>
            )}
            {capped && <div className="warn">这个视频超过 60 秒：为了不占满内存，电脑只分析了前 60 秒。</div>}
            {errMsg && <div className="warn">{errMsg}</div>}
            <div className="honest">
              <b>先说清楚三件事：</b>
              ① 导出的素材只有 <b>WebM</b> 格式（主流动态壁纸软件都认）；② 导出是实时进行的，<b>片段多长就导多久</b>；
              ③ 画面运动很剧烈时，循环首尾的溶解处<b>会有轻微重影</b>——导出前可以预览确认。
            </div>
          </>}

          {step === 2 && step2Body}

          {step === 3 && win && <>
            <h2>第三步：预览循环效果，导出</h2>
            <p className="hint">左边就是做出来后的循环样子（最后 0.3 秒会溶接回开头）。满意就点导出，选个保存位置。</p>
            <div className="readout">
              循环片段：从第 <b>{win.start.toFixed(1)} 秒</b> 开始，长 <b>{win.duration.toFixed(1)} 秒</b>
              ，画面 <b>{outSize.w}×{outSize.h}</b> 像素
              {saved && <>，已保存 <b>{(saved.bytes / 1024).toFixed(0)} KB</b></>}
            </div>
            <div className="bigbtns">
              <button className="btn big" onClick={onExport} disabled={busy}>💾 导出循环素材（WebM）</button>
              <button className="btn ghost" onClick={() => { setStep(2); setStatus('回到上一步，可以重新挑选或微调'); }} disabled={busy}>← 调整片段</button>
            </div>
            {exporting !== null && (
              <div className="notice">
                导出中（实时，不快进也不造假进度）… {(exporting * 100).toFixed(0)}%
                <div className="progress"><div style={{ width: `${exporting * 100}%` }} /></div>
              </div>
            )}
            <div className="honest">
              <b>导出的素材：</b>只有画面、没有声音；格式是 WebM；导出耗时约等于片段时长（实时重录）。
              如果画面运动剧烈，首尾溶解处可能有轻微重影——这是溶接本身的原理，不是坏了。
            </div>
            <div className="nextrow">
              <button className="btn ghost" onClick={() => setStep(1)}>← 导入别的视频</button>
              <span />
            </div>
          </>}
        </div>

        <div className="preview-wrap">
          {step === 3 ? (
            <div className="preview-card">
              <div className="t"><span>循环效果预览（一直在重复播放）</span><span>{outSize.w}×{outSize.h}</span></div>
              <canvas ref={canvasRef} width={outSize.w} height={outSize.h} />
            </div>
          ) : (
            <div className="preview-card">
              <div className="t"><span>它是怎么挑的（大白话）</span></div>
              <p style={{ fontSize: 13.5, lineHeight: 1.9, margin: '4px 0' }}>
                电脑把视频缩成小图，一帧一帧地看，找出一段<b>"开头和结尾长得几乎一样"</b>、
                而且中间<b>一直有适度动静</b>的片段——这样的片段首尾相接时看不出接缝，最适合做成循环的动态壁纸。
                它会推荐最顺的 3 段给你挑。
              </p>
            </div>
          )}
          <div className="preview-card">
            <div className="t"><span>适合做壁纸的素材</span><span>例子</span></div>
            <p style={{ fontSize: 13, lineHeight: 1.9, margin: '4px 0', color: 'var(--muted)' }}>
              雨点打在窗上 · 咖啡/茶的热气 · 摇动的树影 · 水族箱 · 火焰与烛光 · 缓慢的云 · 老式风扇。
              这些画面动静不大、周而复始，循环起来最自然。
            </p>
          </div>
        </div>
      </main>

      <div className="statusline">{status}{busy ? ' …' : ''}</div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

window.addEventListener('load', () => {
  if (new URLSearchParams(location.search).get('smoke') === '1') {
    setTimeout(() => {
      try {
        window.loopslicer?.smokeReady({
          mounted: !!document.getElementById('root')?.children.length,
          engineOk: engineMiniSelfTest(),
        });
      } catch { /* 非冒烟环境 */ }
    }, 300);
  }
});
