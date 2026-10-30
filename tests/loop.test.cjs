'use strict';
// 循环切片引擎单元测试：全部用程序合成的已知运动模式帧序列（不依赖任何真实素材）。
const test = require('node:test');
const assert = require('node:assert');
const loop = require('../src/domain/loop.cjs');

const W = 16, H = 9, BG = 40, DOT = 200, INTERVAL = 0.1;

function blankFrame(bg = BG) { return new Uint8Array(W * H).fill(bg); }

function drawDot(frame, x, y, v = DOT) {
  // 5×5 的点：保证任何位置都盖住引擎 stride=4 采样列（每 4 列取 1 列）中的至少一列，
  // 否则小点会在边界比较里"隐身"，测的不是真实生产设置。
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const px = x + dx, py = y + dy;
    if (px >= 0 && px < W && py >= 0 && py < H) frame[py * W + px] = v;
  }
}

/** 周期性运动：一个 3×3 的点在 x 方向匀速移动，每 period 帧回到起点（首尾完全重合） */
function periodicFrames(count, period, phase = 0, bg = BG) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    const f = blankFrame(bg);
    const t = ((i - phase) % period + period) % period;
    drawDot(f, 2 + Math.round((t / period) * (W - 5)), 4);
    frames.push(f);
  }
  return frames;
}

// ---------- 基础量 ----------

test('frameDiff：相同帧差异为 0，恒定偏移差异等于偏移量', () => {
  const a = blankFrame(), b = blankFrame();
  assert.strictEqual(loop.frameDiff(a, b, 1), 0);
  const c = Uint8Array.from(a, (v) => Math.min(255, v + 10));
  assert.ok(Math.abs(loop.frameDiff(a, c, 1) - 10) < 1e-9);
});

test('frameDiff：尺寸不一致必须报错', () => {
  assert.throws(() => loop.frameDiff(new Uint8Array(4), new Uint8Array(5), 1), /尺寸不一致/);
});

test('adjacentDiffs：相邻帧差异正确', () => {
  const f1 = blankFrame(), f2 = blankFrame(), f3 = blankFrame();
  for (let p = 0; p < W * H; p++) { f2[p] = 50; f3[p] = 40; }
  const d = loop.adjacentDiffs([f1, f2, f3], 1);
  assert.strictEqual(d.length, 2);
  assert.ok(Math.abs(d[0] - 10) < 1e-9 && Math.abs(d[1] - 10) < 1e-9);
});

test('motionWeightOf：死画面与跳变都压到 0，中间满权重', () => {
  assert.strictEqual(loop.motionWeightOf(0), 0);
  assert.ok(loop.motionWeightOf(0.4) > 0 && loop.motionWeightOf(0.4) < 1);
  assert.strictEqual(loop.motionWeightOf(1), 1);
  assert.strictEqual(loop.motionWeightOf(loop.JARRING_MOTION), 1);
  assert.ok(loop.motionWeightOf(50) > 0 && loop.motionWeightOf(50) < 1);
  assert.strictEqual(loop.motionWeightOf(61), 0);
});

test('boundarySimOf：首尾完全一样=100%，差异越大贴合度越低', () => {
  assert.strictEqual(loop.boundarySimOf(0), 1);
  assert.ok(Math.abs(loop.boundarySimOf(4) - 0.5) < 1e-9);
  assert.ok(loop.boundarySimOf(20) < 0.2);
});

// ---------- 评分排序 ----------

test('周期 2.0s 的序列：最佳窗口时长应接近 2.0s 且首尾几乎重合', () => {
  // 10 秒、周期 2.0s（20 帧）的匀速运动点
  const frames = periodicFrames(100, 20);
  const got = loop.findBestWindows(frames, { frameInterval: INTERVAL });
  assert.ok(got.length >= 1, '至少返回一个候选');
  const top = got[0];
  assert.ok(Math.abs(top.duration - 2.0) <= 0.2, `最佳窗口时长 ${top.duration} 应≈2.0`);
  assert.ok(top.boundaryDiff < 1.5, `最佳窗口首尾差 ${top.boundaryDiff} 应接近 0`);
  assert.ok(top.fitPercent >= 90, `贴合度 ${top.fitPercent}% 应≥90%`);
  assert.ok(top.score > 0.5, `评分 ${top.score} 应显著大于 0`);
});

test('排序正确：首尾重合的窗口得分严格高于首尾错开的窗口', () => {
  // 周期 3.0s：时长 2.0s 的窗口首尾必然错开约 8px
  const frames = periodicFrames(80, 30);
  const got = loop.findBestWindows(frames, { frameInterval: INTERVAL });
  const top = got[0];
  assert.ok(Math.abs(top.duration - 3.0) <= 0.2, `最佳窗口时长 ${top.duration} 应≈3.0`);
  const off = got.find((c) => Math.abs(c.duration - 2.0) <= 0.05);
  if (off) {
    assert.ok(top.score > off.score, `重合窗口得分 ${top.score} 应高于错开窗口 ${off.score}`);
    assert.ok(top.fitPercent > off.fitPercent + 20, `贴合度 ${top.fitPercent}% 应显著高于 ${off.fitPercent}%`);
  }
});

test('一半死画面一半运动：绝不会推荐死画面窗口，最佳窗口落在运动区', () => {
  const frames = [...periodicFrames(30, 999, 0, BG)]; // 前 3 秒完全静止（period 超过长度，点不动）
  // 让前 3 秒真的静止：直接全部填背景
  for (const f of frames) f.fill(BG);
  const live = periodicFrames(50, 20, 30, BG); // 后 5 秒周期 2.0s 的运动
  const all = frames.concat(live);
  const got = loop.findBestWindows(all, { frameInterval: INTERVAL });
  assert.ok(got.length >= 1, '运动区应能找到候选');
  for (const c of got) {
    assert.ok(c.motion >= loop.DEAD_MOTION, `候选运动量 ${c.motion} 不得落在死画面区`);
    assert.ok(c.motion <= loop.JARRING_MOTION, `候选运动量 ${c.motion} 不得落在跳变区`);
  }
  assert.ok(got[0].startIdx >= 30, `最佳窗口应起始于运动区（startIdx=${got[0].startIdx}≥30）`);
});

test('无运动序列：不返回任何高运动量窗口（返回空）', () => {
  const frames = periodicFrames(60, 9999); // 全程静止
  const got = loop.findBestWindows(frames, { frameInterval: INTERVAL });
  assert.strictEqual(got.length, 0, '静止序列不应返回候选');
  for (const c of got) assert.ok(c.motion < loop.DEAD_MOTION);
});

test('纯噪声（剧烈跳变）序列：不返回候选', () => {
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const frames = [];
  for (let i = 0; i < 60; i++) {
    const f = new Uint8Array(W * H);
    for (let p = 0; p < f.length; p++) f[p] = rand() < 0.5 ? 0 : 255;
    frames.push(f);
  }
  const got = loop.findBestWindows(frames, { frameInterval: INTERVAL });
  assert.strictEqual(got.length, 0, '逐帧噪声不应返回候选');
});

test('两段各自循环的场景：推荐窗口互不重叠，且都能覆盖到两段', () => {
  const first = periodicFrames(40, 20, 0, BG);   // 前 4 秒：周期 2.0s，背景 40
  const second = periodicFrames(40, 20, 40, 80); // 后 4 秒：周期 2.0s，背景 80
  const got = loop.findBestWindows(first.concat(second), { frameInterval: INTERVAL, count: 3 });
  assert.strictEqual(got.length, 3, `应返回 3 个互不重叠候选，实际 ${got.length}`);
  for (let a = 0; a < got.length; a++) for (let b = a + 1; b < got.length; b++) {
    const A = got[a], B = got[b];
    const overlap = !(A.endIdx <= B.startIdx || A.startIdx >= B.endIdx);
    assert.ok(!overlap, `候选 ${a} 与 ${b} 重叠了`);
  }
  assert.ok(got.some((c) => c.startIdx < 40) && got.some((c) => c.startIdx >= 40), '推荐应覆盖前后两段场景');
});

// ---------- 溶解计划 ----------

test('crossfadePlan：0.3s 溶解 = 3 帧，权重线性 0→1', () => {
  const p = loop.crossfadePlan(3.0, 0.1, 0.3);
  assert.strictEqual(p.fadeFrames, 3);
  assert.ok(Math.abs(p.fadeSec - 0.3) < 1e-9);
  assert.ok(Math.abs(p.fadeStartSec - 2.7) < 1e-9);
  assert.strictEqual(p.weights.length, 3);
  assert.strictEqual(p.weights[0], 0);
  assert.ok(Math.abs(p.weights[2] - 2 / 3) < 1e-9);
  for (let m = 1; m < p.weights.length; m++) assert.ok(p.weights[m] > p.weights[m - 1], '权重必须单调上升');
});

test('crossfadePlan：溶解时长不会超过窗口一半', () => {
  const p = loop.crossfadePlan(0.4, 0.1, 0.3);
  assert.ok(p.fadeSec <= 0.2 + 1e-9, `溶解时长 ${p.fadeSec} 不得超过窗口一半 0.2`);
  assert.strictEqual(p.fadeFrames, 2);
});

test('crossfadePlan：非法输入必须报错', () => {
  assert.throws(() => loop.crossfadePlan(0, 0.1), /窗口时长/);
  assert.throws(() => loop.crossfadePlan(3, 0), /帧间隔/);
});

// ---------- 人话标签 ----------

test('motionLabel：运动量给出零术语描述', () => {
  assert.strictEqual(loop.motionLabel(0), '几乎不动');
  assert.strictEqual(loop.motionLabel(1.5), '很轻微');
  assert.strictEqual(loop.motionLabel(5), '适中');
  assert.strictEqual(loop.motionLabel(20), '比较明显');
  assert.strictEqual(loop.motionLabel(50), '非常剧烈');
});
