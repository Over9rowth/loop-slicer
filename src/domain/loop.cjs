// Copyright (C) 2026 Over9rowth
// SPDX-License-Identifier: GPL-3.0-only
// 循环切片引擎（纯 JS，可被 node 直接测试，也可被渲染进程打包使用）。
//
// 输入：一段"灰度帧序列"——由 UI 层对视频逐帧 seek 后抽成 160×90 灰度图得到。
//   frames[i] = Uint8Array(w*h)，帧间隔固定（分析步长，默认 0.1 秒）。
//
// 评分模型（对应 docs/plan.md）：
//   窗口评分 = 首尾帧差异（越小越好）× 运动量加权（太小=死画面，太大=跳变）。
//   - boundaryDiff：窗口首帧与末帧的平均绝对灰度差（0..255）。循环要求首尾几乎一样。
//   - motion：窗口内相邻帧平均差异。画面完全不动（死画面）循环了也没意义；
//     每帧都剧烈变化（跳变/抖动）做循环会很难看。两者都压低权重。
//   - score = boundarySim × motionWeight ∈ [0,1]，越大越适合做无缝循环。
'use strict';

/** 死画面阈值：相邻帧平均灰度差低于此值，画面基本不动 */
const DEAD_MOTION = 0.6;
/** 跳变阈值：相邻帧平均灰度差高于此值，画面变化过于剧烈 */
const JARRING_MOTION = 45;
/** 完全无权重区（低于 ramp 下限 / 高于 jump 上限） */
const DEAD_FLOOR = 0.2;
const JARRING_CEIL = 60;
/** 首尾贴合度的软化常数：boundaryDiff=4 时贴合度约 50% */
const BOUNDARY_SOFTEN = 4;
/** 边界/运动差异计算的像素采样步长（性能保护，160×90 时取 1/4 像素） */
const PIXEL_STRIDE = 4;

/** 两帧平均绝对灰度差（0..255）。stride 用于性能：只采样部分像素。 */
function frameDiff(a, b, stride = PIXEL_STRIDE) {
  if (a.length !== b.length) throw new Error('两帧尺寸不一致');
  let sum = 0, n = 0;
  for (let p = 0; p < a.length; p += stride) { sum += Math.abs(a[p] - b[p]); n++; }
  return n ? sum / n : 0;
}

/** 相邻帧差异数组，长度 = frames.length - 1 */
function adjacentDiffs(frames, stride = PIXEL_STRIDE) {
  const out = new Float64Array(Math.max(0, frames.length - 1));
  for (let i = 0; i < out.length; i++) out[i] = frameDiff(frames[i], frames[i + 1], stride);
  return out;
}

function median(xs) {
  if (!xs.length) return 0;
  const s = Float64Array.from(xs).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 运动量加权：太小（死画面）与太大（跳变）都压低，中间段权重 1 */
function motionWeightOf(motion) {
  if (motion <= DEAD_FLOOR || motion >= JARRING_CEIL) return 0;
  if (motion < DEAD_MOTION) return (motion - DEAD_FLOOR) / (DEAD_MOTION - DEAD_FLOOR);
  if (motion > JARRING_MOTION) return 1 - (motion - JARRING_MOTION) / (JARRING_CEIL - JARRING_MOTION);
  return 1;
}

/** 首尾贴合度 0..1（1 = 首尾完全一样） */
function boundarySimOf(boundaryDiff) {
  return 1 / (1 + boundaryDiff / BOUNDARY_SOFTEN);
}

/**
 * 找出最适合无缝循环的窗口。
 * 返回按评分从高到低、互不重叠的最多 count 个窗口：
 * { startIdx, endIdx, startTime, endTime, duration, boundaryDiff, motion, score, fitPercent }
 * opts: { frameInterval=0.1, minDur=1.5, maxDur=6.0, count=3, stride=PIXEL_STRIDE }
 */
function findBestWindows(frames, opts = {}) {
  const { frameInterval = 0.1, minDur = 1.5, maxDur = 6.0, count = 3, stride = PIXEL_STRIDE } = opts;
  const n = frames.length;
  if (n < 2) return [];
  const diffs = adjacentDiffs(frames, stride);
  // 前缀和：窗口 [i, j) 内相邻帧差异之和（j 为末帧下标，含 j-1 的差异）
  const prefix = new Float64Array(diffs.length + 1);
  for (let i = 0; i < diffs.length; i++) prefix[i + 1] = prefix[i] + diffs[i];

  const kMin = Math.max(1, Math.round(minDur / frameInterval));
  const kMax = Math.min(n - 1, Math.floor(maxDur / frameInterval + 1e-9));
  const candidates = [];
  for (let k = kMin; k <= kMax; k++) {
    for (let i = 0; i + k < n; i++) {
      const j = i + k; // 末帧下标（含）
      const motion = (prefix[j] - prefix[i]) / k; // 相邻帧差异平均
      const weight = motionWeightOf(motion);
      if (weight === 0) continue; // 死画面或跳变，直接淘汰（省掉首尾比较）
      const boundaryDiff = frameDiff(frames[i], frames[j], stride);
      const score = boundarySimOf(boundaryDiff) * weight;
      candidates.push({
        startIdx: i, endIdx: j,
        startTime: +(i * frameInterval).toFixed(3),
        endTime: +((i + k) * frameInterval).toFixed(3),
        duration: +(k * frameInterval).toFixed(3),
        boundaryDiff, motion, score,
        fitPercent: Math.round(boundarySimOf(boundaryDiff) * 100),
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.startIdx - b.startIdx);
  const picked = [];
  for (const c of candidates) {
    if (picked.length >= count) break;
    if (picked.every((p) => c.endIdx <= p.startIdx || c.startIdx >= p.endIdx)) picked.push(c);
  }
  return picked;
}

/**
 * 溶解计划：窗口末尾 fadeSec 与开头线性交叉溶解。
 * weights[m] = 第 m 个溶解帧上"开头内容"的透明度（0→1 线性），共 fadeFrames 个。
 * 播放/导出时：主画面继续播，叠加"从窗口开头重新开始播放"的画面，透明度按 weights 线性上升。
 */
function crossfadePlan(windowSec, frameInterval, fadeSec = 0.3) {
  if (!(windowSec > 0)) throw new Error('窗口时长必须大于 0');
  if (!(frameInterval > 0)) throw new Error('帧间隔必须大于 0');
  let fade = Math.min(fadeSec, windowSec / 2);
  let fadeFrames = Math.max(1, Math.round(fade / frameInterval));
  fadeFrames = Math.min(fadeFrames, Math.floor(windowSec / frameInterval - 1e-9));
  const weights = [];
  for (let m = 0; m < fadeFrames; m++) weights.push(m / fadeFrames);
  return {
    fadeSec: +(fadeFrames * frameInterval).toFixed(3),
    fadeFrames,
    fadeStartSec: +(windowSec - fadeFrames * frameInterval).toFixed(3),
    weights,
  };
}

/** 运动量的人话描述（界面用，零术语） */
function motionLabel(motion) {
  if (motion < DEAD_MOTION) return '几乎不动';
  if (motion < 3) return '很轻微';
  if (motion < 10) return '适中';
  if (motion < JARRING_MOTION) return '比较明显';
  return '非常剧烈';
}

module.exports = {
  frameDiff, adjacentDiffs, median,
  motionWeightOf, boundarySimOf,
  findBestWindows, crossfadePlan, motionLabel,
  DEAD_MOTION, JARRING_MOTION, PIXEL_STRIDE,
};
