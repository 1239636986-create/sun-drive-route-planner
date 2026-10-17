/**
 * 出发时间优化 —— PRD F6（v0.3 设计，Q10 决策：以「到达时段」为硬约束）
 *
 * 三个必须遵守的设计约束，全部来自 M0 真实数据盲测的教训：
 *
 * ① 不能用「平均暴露度」做主指标
 *    实测：北京→天津 138.5km，用平均暴露度扫描全天，最优解是 19:00 出发
 *    （太阳已落山，暴露度 0.0）。数学正确、产品无价值。
 *    根因：该路线 85% 东西向，但致命的只有 3.1km 西向路段，
 *          平均值把致命点 ÷ 138km 稀释掉了。
 *    -> 主指标改为峰值风险。
 *
 * ② 必须有「到达时段」硬约束
 *    只要搜索窗口覆盖全天，优化器**必然**退化成「夜间出发」。
 *    这不是路线问题，是指标定义域问题。
 *
 * ③ 必须处理风险曲线的**不连续性**
 *    实测峰值风险不是出发时间的平滑函数：
 *      15:45 -> 100.0（昆仑路，通过时太阳高度角 0.04°）
 *      16:05 ->  23.2（分钟寺桥，24.7 分钟后太阳已落山）
 *    跳变 76.3 分。15 分钟单步长会漏掉 15:00–17:30 内 15 个高危时刻中的 13 个。
 *    -> 两阶段搜索：15 分钟粗扫 + 5 分钟精扫关键区间。
 *
 * ④ 输出「危险边界」比「最优时刻」更有用
 *    用户能理解「16:05 之后走就没事」，比「推荐 16:15 出发」可执行得多 ——
 *    后者距离危险区只差 15 分钟。
 */

import { computeSegmentRisks, riskDistribution } from './riskAggregator.js';
import { HIGH_RISK_THRESHOLD } from './glareEngine.js';
import type {
  DepartureCandidate,
  DeparturePlan,
  DepartureRange,
  Route,
  SegmentRisk,
} from './types.js';

/** 粗扫步长（分钟） */
export const COARSE_STEP_MINUTES = 15;
/** 精扫步长（分钟）—— 必须能分辨实测中那个 20 分钟宽的尖峰 */
export const FINE_STEP_MINUTES = 5;
/** 精扫时在最优解周围扩展的范围（分钟） */
export const REFINE_RADIUS_MINUTES = 60;
/** 危险窗口与安全推荐之间的最小安全间隔（分钟）—— 低于此值必须警告 */
export const WARNING_MARGIN_MINUTES = 15;

const MS_PER_MIN = 60_000;

/**
 * 用户可选的到达时段。
 * 支持跨午夜（如 23:00 – 02:00），由 resolveArrivalWindow 处理。
 */
export interface ArrivalWindow {
  /** 到达时段起点，只取时分，日期由基准日决定 */
  from: { hour: number; minute: number };
  /** 到达时段终点 */
  to: { hour: number; minute: number };
}

export interface OptimizeOptions {
  route: Route;
  arrival: ArrivalWindow;
  /** 用于解析到达时段日期的基准日（当天 00:00 的本地时刻） */
  baseDate: Date;
  /** 最早可出发时刻（选填硬下界） */
  earliestDepartAt?: Date;
  weatherFactor?: number;
  sampleMinutes?: number;
}

interface EvalPoint {
  departAt: Date;
  peakRisk: number;
  highRiskRatio: number;
  peakRoad: string;
}

/**
 * 解析到达时段为具体时刻区间。
 * 若时段终点早于起点，视为跨午夜。
 */
function resolveArrivalWindow(
  arrival: ArrivalWindow,
  baseDate: Date,
): { from: Date; to: Date } {
  const mk = (h: number, m: number) => {
    const d = new Date(baseDate);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const from = mk(arrival.from.hour, arrival.from.minute);
  let to = mk(arrival.to.hour, arrival.to.minute);
  if (to.getTime() <= from.getTime()) {
    to = new Date(to.getTime() + 24 * 60 * MS_PER_MIN);
  }
  return { from, to };
}

/** 对单个出发时刻做一次完整仿真，得到该方案的指标 */
function evaluateDeparture(
  route: Route,
  departAt: Date,
  weatherFactor: number,
  sampleMinutes: number | undefined,
): EvalPoint {
  const segs = computeSegmentRisks(route, {
    departAt,
    weatherFactor,
    // 显式传 undefined 时由 riskAggregator 施加默认值。
    // 这里必须写出来，否则 TS 无法把可选参数喂给要求 number 的字段。
    ...(sampleMinutes === undefined ? {} : { sampleMinutes }),
  });

  let peakRisk = 0;
  let peakRoad = '';
  for (const s of segs) {
    if (s.rP80 > peakRisk) {
      peakRisk = s.rP80;
      peakRoad = s.road;
    }
  }

  const dist = riskDistribution(segs);
  const highRiskRatio = dist['高'] + dist['极高'];

  return { departAt, peakRisk, highRiskRatio, peakRoad };
}

/**
 * 把按时间排序的采样点归纳为连续区间。
 * 用于输出「危险出发窗口」与「安全出发窗口」。
 *
 * @param points 已按 departAt 升序
 * @param predicate 判定该点属于哪个区间类型
 */
function groupRanges(
  points: readonly EvalPoint[],
  predicate: (p: EvalPoint) => boolean,
  stepMinutes: number,
): DepartureRange[] {
  const ranges: DepartureRange[] = [];
  let cur: DepartureRange | null = null;

  for (const p of points) {
    if (!predicate(p)) {
      if (cur) {
        ranges.push(cur);
        cur = null;
      }
      continue;
    }
    if (cur === null) {
      cur = { from: p.departAt, to: p.departAt, boundRisk: p.peakRisk };
    } else {
      cur.to = p.departAt;
      cur.boundRisk = Math.max(cur.boundRisk, p.peakRisk);
    }
  }
  if (cur) ranges.push(cur);

  // 区间上界补一个步长，使其表示「覆盖到该时刻之前」而非「到该点为止」
  return ranges.map((r) => ({
    ...r,
    to: new Date(r.to.getTime() + stepMinutes * MS_PER_MIN),
  }));
}

/**
 * 把时刻按给定步长对齐到分钟边界。
 *
 * 为什么必须做：行程时长是浮点毫秒数（如 22.641509 分钟）。
 * 若不对齐，`arrFrom − duration` 会落在小数秒上，
 * 于是「出发时刻 + duration」在浮点意义上可能比窗口上界大几分之一毫秒，
 * 导致一个本应合法的候选被判为越界、或只有唯一候选能严丝合缝通过。
 */
function snapToMinute(ms: number, mode: 'floor' | 'ceil', stepMinutes = 1): number {
  const step = stepMinutes * MS_PER_MIN;
  const snapped = mode === 'floor'
    ? Math.floor(ms / step) * step
    : Math.ceil(ms / step) * step;
  // 归到整分钟，避免残留秒/毫秒
  return Math.round(snapped / MS_PER_MIN) * MS_PER_MIN;
}

/** 生成从 from 到 to 的等步长时刻序列，含两端 */
function timeSteps(from: Date, to: Date, stepMinutes: number): Date[] {
  const step = stepMinutes * MS_PER_MIN;
  const out: Date[] = [];
  for (let t = from.getTime(); t <= to.getTime(); t += step) out.push(new Date(t));
  const last = out[out.length - 1];
  if (!last || last.getTime() < to.getTime() - 1) out.push(new Date(to.getTime()));
  return out;
}

/**
 * 主入口：在满足到达时段约束的前提下，找出逆光风险最低的出发方案。
 */
export function optimizeDeparture(options: OptimizeOptions): DeparturePlan {
  const {
    route,
    arrival,
    baseDate,
    earliestDepartAt,
    weatherFactor = 1,
    sampleMinutes,
  } = options;

  // --- 由到达时段反推可行出发区间 ---
  // 行程时长是已知量（Provider 返回，含路况估计），所以这是唯一映射：
  //   出发区间 = [到达窗口起点 − 时长, 到达窗口终点 − 时长]
  const { from: arrFrom, to: arrTo } = resolveArrivalWindow(arrival, baseDate);
  const durMs = route.duration;

  // 向内对齐到整分钟：保证「出发 + 时长」严格落在到达窗口内，
  // 不会被浮点误差推出边界（见 snapToMinute 的说明）
  let loRaw = snapToMinute(arrFrom.getTime() - durMs, 'ceil');
  const hiRaw = snapToMinute(arrTo.getTime() - durMs, 'floor');

  if (earliestDepartAt && earliestDepartAt.getTime() > loRaw) {
    loRaw = snapToMinute(earliestDepartAt.getTime(), 'ceil');
  }

  const feasibleFrom = new Date(loRaw);
  const feasibleTo = new Date(hiRaw);

  // 约束不可满足：行程赶不上，或对齐到整分钟后窗口消失
  //
  // 注意：这里只判断「窗口是否为空」。
  // 若窗口很窄但仍能容纳至少一个出发时刻，应当照常给出方案 ——
  // 用户的约束是可满足的，不该被报成失败。
  if (hiRaw < loRaw) {
    return {
      candidates: [],
      dangerousRanges: [],
      safeRanges: [],
      peakLowerBound: Number.POSITIVE_INFINITY,
      unavoidable: true,
      feasibleFrom,
      feasibleTo,
    };
  }

  // --- 阶段 ①：粗扫 ---
  const coarseStamps = timeSteps(feasibleFrom, feasibleTo, COARSE_STEP_MINUTES);
  const coarse: EvalPoint[] = coarseStamps.map((d) =>
    evaluateDeparture(route, d, weatherFactor, sampleMinutes),
  );

  const best = coarse.reduce((a, b) => (b.peakRisk < a.peakRisk ? b : a), coarse[0]!);

  // --- 阶段 ②：精扫 ---
  // 关键：精扫范围要覆盖「最优解附近」以及「所有等级跃迁边界」附近，
  // 因为风险曲线不连续，窄窗口可能整体落在粗扫的两个采样点之间。
  const transitions: Date[] = [];
  for (let i = 1; i < coarse.length; i++) {
    const prevHigh = coarse[i - 1]!.peakRisk >= HIGH_RISK_THRESHOLD;
    const curHigh = coarse[i]!.peakRisk >= HIGH_RISK_THRESHOLD;
    if (prevHigh !== curHigh) transitions.push(coarse[i - 1]!.departAt, coarse[i]!.departAt);
  }

  const refineCenters = [
    best.departAt,
    ...transitions,
  ];

  const fineStamps = new Map<number, Date>();
  const radius = REFINE_RADIUS_MINUTES * MS_PER_MIN;
  const fineStep = FINE_STEP_MINUTES * MS_PER_MIN;

  for (const center of refineCenters) {
    const lo = Math.max(feasibleFrom.getTime(), center.getTime() - radius);
    const hi = Math.min(feasibleTo.getTime(), center.getTime() + radius);
    for (let t = lo; t <= hi; t += fineStep) fineStamps.set(t, new Date(t));
  }
  // 精扫结果必须包含粗扫全部点，保证区间划分连续
  for (const p of coarse) fineStamps.set(p.departAt.getTime(), p.departAt);

  const fineMap = new Map<number, EvalPoint>();
  for (const p of coarse) fineMap.set(p.departAt.getTime(), p);
  for (const [t, d] of fineStamps) {
    if (!fineMap.has(t)) fineMap.set(t, evaluateDeparture(route, d, weatherFactor, sampleMinutes));
  }

  const all: EvalPoint[] = [...fineMap.values()].sort(
    (a, b) => a.departAt.getTime() - b.departAt.getTime(),
  );

  // --- 输出：候选、危险窗、安全窗、峰值下界 ---
  const sorted = [...all].sort(
    (a, b) =>
      a.peakRisk - b.peakRisk ||
      a.highRiskRatio - b.highRiskRatio ||
      a.departAt.getTime() - b.departAt.getTime(),
  );

  // Top 3 需去重：间隔小于精扫步长的视为同一方案
  const candidates: DepartureCandidate[] = [];
  for (const p of sorted) {
    if (
      candidates.some(
        (c) => Math.abs(c.departAt.getTime() - p.departAt.getTime()) < FINE_STEP_MINUTES * MS_PER_MIN,
      )
    ) {
      continue;
    }
    candidates.push({
      departAt: p.departAt,
      arriveAt: new Date(p.departAt.getTime() + durMs),
      peakRisk: p.peakRisk,
      highRiskRatio: p.highRiskRatio,
      peakRoad: p.peakRoad,
    });
    if (candidates.length >= 3) break;
  }

  const dangerousRanges = groupRanges(all, (p) => p.peakRisk >= HIGH_RISK_THRESHOLD, FINE_STEP_MINUTES);
  const safeRanges = groupRanges(all, (p) => p.peakRisk < HIGH_RISK_THRESHOLD, FINE_STEP_MINUTES);

  const peakLowerBound = all.reduce((m, p) => Math.min(m, p.peakRisk), Number.POSITIVE_INFINITY);

  return {
    candidates,
    dangerousRanges,
    safeRanges,
    peakLowerBound,
    unavoidable: peakLowerBound >= HIGH_RISK_THRESHOLD,
    feasibleFrom,
    feasibleTo,
  };
}

/**
 * 判断最优候选是否贴着危险窗口 —— 若是，UI 必须警告。
 *
 * 实测场景：16:15 出发是安全的，但仅比危险窗口（15:05–16:05）晚 10 分钟。
 * 这种「差一点就中招」的方案必须明示，不能只报一个漂亮的分数。
 */
export function isNearDanger(
  candidate: DepartureCandidate,
  plan: DeparturePlan,
): boolean {
  const margin = WARNING_MARGIN_MINUTES * MS_PER_MIN;
  return plan.dangerousRanges.some((r) => {
    const gapAfter = candidate.departAt.getTime() - r.to.getTime();
    const gapBefore = r.from.getTime() - candidate.departAt.getTime();
    return (gapAfter >= 0 && gapAfter <= margin) || (gapBefore >= 0 && gapBefore <= margin);
  });
}

/** 供给 UI 直接使用的可读描述 */
export function describeRange(r: DepartureRange): string {
  const f = (d: Date) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${f(r.from)}–${f(r.to)}`;
}

/** 从分段风险中挑出最严重的一段，用于结论区展示 */
export function worstSegment(segments: readonly SegmentRisk[]): SegmentRisk | null {
  let worst: SegmentRisk | null = null;
  for (const s of segments) {
    if (!worst || s.rP80 > worst.rP80) worst = s;
  }
  return worst;
}
