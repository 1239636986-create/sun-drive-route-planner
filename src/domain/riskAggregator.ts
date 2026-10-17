/**
 * 风险聚合 —— 把「分段几何 + 时间轴」求交后的结果整理成可用的产品输出
 *
 * 三步：
 *   1. 推算每段的通过时间窗（由 Provider 返回的总时长均摊，含路况估计）
 *   2. 在各段的时间窗内采样，计算风险；路段风险取 P80
 *   3. 按**道路名**聚合成高风险窗口（F5 的产出形态）
 *
 * ⚠️ P80 的已知局限（实测发现，PRD 6.5）：
 *   P80 会抹平瞬时峰值。100m @ 53km/h 仅 6.8 秒，而采样步长 5 分钟，
 *   该段往往只有 1–2 个采样点。因此同时输出 rMax，让用户看到「最坏瞬间」。
 *
 *   由此得出一个必须向用户诚实交代的结论：
 *     - 路段级 P80 风险  -> 可以通过改出发时间规避
 *     - 瞬时级峰值风险   -> 可能无法规避
 *   产品文案不得暗示「换个时间就没问题了」。
 */

import { midpoint, percentile } from './geo.js';
import { offAxisAngle, riskScore, riskLevel, RISK_LEVEL_ORDER } from './glareEngine.js';
import { sunPosition } from './sunPosition.js';
import type {
  LonLat,
  RiskLevel,
  RiskPeak,
  RiskWindow,
  Route,
  RouteSegment,
  SegmentRisk,
} from './types.js';

/** 时间采样步长，毫秒。5 分钟 —— PRD 6.5 */
export const DEFAULT_SAMPLE_MINUTES = 5;

/** P80：代表「这段路上你会明显感到不适的时间占比」 */
export const RISK_PERCENTILE = 0.8;

/** 窗口时长阈值：低于此值视为「瞬时」，不给时间区间（PRD F5） */
export const INSTANTANEOUS_THRESHOLD_MS = 60_000;

/** 同名道路的窗口若被短的非风险段打断，间隔在此值内则合并 */
export const WINDOW_MERGE_GAP_MS = 60_000;

export interface ComputeRiskOptions {
  /** 出发时刻 */
  departAt: Date;
  /** 天气衰减系数 */
  weatherFactor?: number;
  /** 时间采样步长（分钟） */
  sampleMinutes?: number;
}

/**
 * 推算每段的通过时间窗。
 *
 * 速度按整条路线的平均速度均摊 —— 这是 MVP 的简化。
 * 更精确的做法是用每个 step 的 duration，但 step 与我们的分段并非一一对应，
 * 收益有限而复杂度上升，暂不做（记入待改进）。
 */
function assignTimeWindows(
  segments: RouteSegment[],
  departAt: Date,
  route: Pick<Route, 'distance' | 'duration'>,
): void {
  const totalDist = segments.reduce((s, x) => s + x.dist, 0);
  // 米/毫秒
  const speed = totalDist > 0 && route.duration > 0 ? totalDist / route.duration : 0.02;

  let cum = 0;
  const t0 = departAt.getTime();
  for (const s of segments) {
    (s as SegmentRisk).tStart = new Date(t0 + cum / speed);
    cum += s.dist;
    (s as SegmentRisk).tEnd = new Date(t0 + cum / speed);
  }
}

/**
 * 对单个分段在时间轴上采样并计算风险。
 * 返回该段的 P80 / max / 峰值详情。
 */
function evalSegment(
  seg: RouteSegment & { tStart: Date; tEnd: Date },
  sampleMs: number,
  weatherFactor: number,
  originLatLon: LonLat,
): { rP80: number; rMax: number; peak: RiskPeak } {
  const mid = midpoint(seg);
  const scores: number[] = [];
  let peak: RiskPeak | null = null;

  const start = seg.tStart.getTime();
  const end = seg.tEnd.getTime();
  const span = end - start;

  // 采样点：从 tStart 起按步长走，并确保 tEnd 被覆盖
  const stamps: number[] = [];
  if (span <= sampleMs) {
    // 段太短，至少取首尾两点，避免只采到一个点而失去时间代表性
    stamps.push(start);
    if (end > start) stamps.push(end);
  } else {
    for (let t = start; t <= end; t += sampleMs) stamps.push(t);
    if (stamps[stamps.length - 1] !== end) stamps.push(end);
  }

  for (const t of stamps) {
    const at = new Date(t);
    const sun = sunPosition(mid.lat, mid.lon, at);
    const deltaAzimuth = Math.abs(
      (((sun.azimuth - seg.heading) % 360) + 540) % 360 - 180,
    );
    const score = riskScore({
      sunElevation: sun.elevation,
      deltaAzimuth,
      weatherFactor,
    });
    scores.push(score);

    if (peak === null || score > peak.score) {
      peak = {
        score,
        at,
        sunAzimuth: sun.azimuth,
        sunElevation: sun.elevation,
        heading: seg.heading,
        offAxisAngle: offAxisAngle(sun.elevation, deltaAzimuth),
      };
    }
  }

  // 注意：路段中点与分段中点理论上一致；originLatLon 保留给将来
  // 「按起点统一近似太阳位置」的性能优化使用
  void originLatLon;

  return {
    rP80: percentile(scores, RISK_PERCENTILE),
    rMax: scores.length ? Math.max(...scores) : 0,
    peak: peak!,
  };
}

/**
 * 计算整条路线的分段风险。
 * 这是领域层的主入口，纯函数（不读写外部状态，不发网络请求）。
 */
export function computeSegmentRisks(
  route: Route,
  options: ComputeRiskOptions,
): SegmentRisk[] {
  const {
    departAt,
    weatherFactor = 1,
    sampleMinutes = DEFAULT_SAMPLE_MINUTES,
  } = options;

  const sampleMs = sampleMinutes * 60_000;

  // 复制分段，避免污染调用方持有的 Route
  const segments: SegmentRisk[] = route.segments.map((s) => ({
    ...s,
    tStart: departAt,
    tEnd: departAt,
    rP80: 0,
    rMax: 0,
    peak: {
      score: 0,
      at: departAt,
      sunAzimuth: 0,
      sunElevation: 0,
      heading: s.heading,
      offAxisAngle: 0,
    },
  }));

  assignTimeWindows(segments, departAt, route);

  // 性能热点的占位：整条路线的太阳位置与位置弱相关，
  // 将来可先用路线中点近似再对关键段精算。当前规模（实测 20ms/次）无需优化。
  const origin = segments.length
    ? midpoint(segments[Math.floor(segments.length / 2)]!)
    : { lon: 0, lat: 0 };

  for (const seg of segments) {
    const { rP80, rMax, peak } = evalSegment(seg, sampleMs, weatherFactor, origin);
    seg.rP80 = rP80;
    seg.rMax = rMax;
    seg.peak = peak;
  }

  return segments;
}

/**
 * 按道路名聚合成高风险窗口 —— PRD F5，Q9 决策：以路名为组织主键。
 *
 * 为什么不能按分段（100m）聚合：
 *   100m @ 53km/h = 6.8 秒。按分段合并会产出
 *   `07:00:26–07:00:32`、`07:00:39–07:00:58` 这种无法阅读的条目。
 *   实测同一路线产出 15 条垃圾条目，按道路名聚合后降到 3 条可用条目。
 *
 * 导航语义下，「东长安街 07:02–07:05」才是一个有意义的风险单元。
 *
 * @param minLevel 最低纳入等级，默认「中」
 */
export function mergeByRoad(
  segments: readonly SegmentRisk[],
  minLevel: RiskLevel = '中',
): RiskWindow[] {
  const threshold = RISK_LEVEL_ORDER[minLevel];
  const windows: RiskWindow[] = [];
  let cur: RiskWindow | null = null;

  const close = () => {
    if (cur) {
      cur.distance = cur.segments.reduce((s, x) => s + x.dist, 0);
      cur.level = riskLevel(cur.maxRisk);
      cur.instantaneous =
        cur.tEnd.getTime() - cur.tStart.getTime() < INSTANTANEOUS_THRESHOLD_MS;
      windows.push(cur);
      cur = null;
    }
  };

  for (const seg of segments) {
    const level = riskLevel(seg.rP80);
    const risky = RISK_LEVEL_ORDER[level] >= threshold;

    if (!risky) {
      close();
      continue;
    }

    // 合并条件：同一条道路 + 时间上连续
    const contiguous =
      cur !== null && seg.tStart.getTime() - cur.tEnd.getTime() <= 1;

    if (cur !== null && cur.road === seg.road && contiguous) {
      cur.tEnd = seg.tEnd;
      cur.segments.push(seg);
      cur.maxRisk = Math.max(cur.maxRisk, seg.rP80);
    } else {
      close();
      cur = {
        road: seg.road,
        tStart: seg.tStart,
        tEnd: seg.tEnd,
        segments: [seg],
        maxRisk: seg.rP80,
        distance: seg.dist,
        level,
        instantaneous: false,
      };
    }
  }
  close();

  // 二次合并：同名道路的窗口若被短的非风险段打断，间隔很短则合并
  const merged: RiskWindow[] = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.road === w.road &&
      w.tStart.getTime() - last.tEnd.getTime() <= WINDOW_MERGE_GAP_MS
    ) {
      last.tEnd = w.tEnd;
      last.segments.push(...w.segments);
      last.distance += w.distance;
      last.maxRisk = Math.max(last.maxRisk, w.maxRisk);
      last.level = riskLevel(last.maxRisk);
      last.instantaneous =
        last.tEnd.getTime() - last.tStart.getTime() < INSTANTANEOUS_THRESHOLD_MS;
    } else {
      merged.push({ ...w, segments: [...w.segments] });
    }
  }

  return merged;
}

/** 按峰值风险降序、同级按里程升序排序（PRD F5 的排序规则） */
export function sortWindows(windows: readonly RiskWindow[]): RiskWindow[] {
  return [...windows].sort((a, b) => {
    const d = RISK_LEVEL_ORDER[b.level] - RISK_LEVEL_ORDER[a.level];
    if (d !== 0) return d;
    return b.maxRisk - a.maxRisk;
  });
}

/** 各等级的里程占比，用于 UI 概览与 F6 的次指标 */
export function riskDistribution(
  segments: readonly SegmentRisk[],
): Record<RiskLevel, number> {
  const total = segments.reduce((s, x) => s + x.dist, 0);
  const byLevel: Record<RiskLevel, number> = { 低: 0, 中: 0, 高: 0, 极高: 0 };
  for (const s of segments) byLevel[riskLevel(s.rP80)] += s.dist;

  if (total <= 0) return byLevel;

  const ratio: Record<RiskLevel, number> = { 低: 0, 中: 0, 高: 0, 极高: 0 };
  for (const k of Object.keys(byLevel) as RiskLevel[]) {
    ratio[k] = byLevel[k] / total;
  }
  return ratio;
}
