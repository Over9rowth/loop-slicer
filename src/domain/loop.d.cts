export declare function frameDiff(a: Uint8Array, b: Uint8Array, stride?: number): number;
export declare function adjacentDiffs(frames: Uint8Array[], stride?: number): Float64Array;
export declare function median(xs: ArrayLike<number>): number;
export declare function motionWeightOf(motion: number): number;
export declare function boundarySimOf(boundaryDiff: number): number;
export interface LoopWindow {
  startIdx: number;
  endIdx: number;
  startTime: number;
  endTime: number;
  duration: number;
  boundaryDiff: number;
  motion: number;
  score: number;
  fitPercent: number;
}
export declare function findBestWindows(frames: Uint8Array[], opts?: {
  frameInterval?: number;
  minDur?: number;
  maxDur?: number;
  count?: number;
  stride?: number;
}): LoopWindow[];
export interface CrossfadePlan {
  fadeSec: number;
  fadeFrames: number;
  fadeStartSec: number;
  weights: number[];
}
export declare function crossfadePlan(windowSec: number, frameInterval: number, fadeSec?: number): CrossfadePlan;
export declare function motionLabel(motion: number): string;
export declare const DEAD_MOTION: number;
export declare const JARRING_MOTION: number;
export declare const PIXEL_STRIDE: number;
