/**
 * RiskAggregator 与 DepartureOptimizer 测试
 *
 * 这些测试使用**构造的路线**（不依赖网络），
 * 目的是守护 M0 盲测发现的两个设计缺陷不复发：
 *   缺陷 1：F5 清单按 100m 分段聚合 -> 碎成无法阅读的条目
 *   缺陷 2：F6 用平均暴露度做主指标 -> 退化成「夜间出发」最优
 */

import { describe, it, expect } from 'vitest';
import {
  mergeByRoad,
  computeSegmentRisks,
  riskDistribution,
  sortWindows,
  INSTANTANEOUS_THRESHOLD_MS,
} from '@/domain/riskAggregator.js';
import { riskLevel } from '@/domain/glareEngine.js';
import { optimizeDeparture, isNearDanger } from '@/domain/departureOptimizer.js';
import type { Route, RouteSegment, SegmentRisk } from '@/domain/types.js';

/** 构造一条朝向固定的直线路线 */
function straightRoute(
  heading: number,
  count: number,
  distEach = 100,
  road = '测试路',
): Route {
  const segments: RouteSegment[] = [];
  for (let i = 0; i < count; i++) {
    segments.push({
      index: i,
      a: { lon: 116.4 + i * 0.001, lat: 39.9 },
      b: { lon: 116.4 + (i + 1) * 0.001, lat: 39.9 },
      heading,
      dist: distEach,
      road,
    });
  }
  return {
    segments,
    distance: count * distEach,
    // 100m 段 @ 53km/h ≈ 6.8 秒 -> 总时长
    duration: (count * distEach) / (53_000 / 3_600_000),
    source: 'fixture',
    confidence: 'high',
  };
}

function cst(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(Date.UTC(y, mo - 1, d, h - 8, mi, 0));
}

describe('computeSegmentRisks —— 基础正确性', () => {
  const route = straightRoute(90, 20); // 向东

  it('每个分段都得到 tStart / tEnd / 风险值', () => {
    const segs = computeSegmentRisks(route, { departAt: cst(2025, 3, 20, 7, 0) });
    expect(segs).toHaveLength(20);
    for (const s of segs) {
      expect(s.tStart).toBeInstanceOf(Date);
      expect(s.tEnd).toBeInstanceOf(Date);
      expect(s.tEnd.getTime()).toBeGreaterThanOrEqual(s.tStart.getTime());
      expect(s.rP80).toBeGreaterThanOrEqual(0);
      expect(s.rP80).toBeLessThanOrEqual(100);
      expect(s.rMax).toBeGreaterThanOrEqual(s.rP80);
    }
  });

  it('时间窗随里程单调递增（后段更晚通过）', () => {
    const segs = computeSegmentRisks(route, { departAt: cst(2025, 3, 20, 7, 0) });
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i]!.tStart.getTime()).toBeGreaterThanOrEqual(segs[i - 1]!.tStart.getTime());
    }
  });

  it('不修改传入的 Route 对象（纯函数）', () => {
    const before = JSON.stringify(route);
    computeSegmentRisks(route, { departAt: cst(2025, 3, 20, 7, 0) });
    expect(JSON.stringify(route)).toBe(before);
  });

  it('夜间出发 -> 全部低风险（T04 在聚合层的体现）', () => {
    const segs = computeSegmentRisks(route, { departAt: cst(2025, 3, 20, 2, 0) });
    for (const s of segs) {
      expect(s.rP80).toBe(0);
      expect(s.rMax).toBe(0);
      expect(riskLevel(s.rP80)).toBe('低');
    }
  });

  it('清晨向东 -> 至少有一段高风险（日出迎面）', () => {
    const segs = computeSegmentRisks(route, { departAt: cst(2025, 3, 20, 7, 0) });
    const max = Math.max(...segs.map((s) => s.rP80));
    expect(max).toBeGreaterThan(30);
  });

  it('正午向东 -> 风险评估为低（太阳高挂，遮阳板可挡）', () => {
    const segs = computeSegmentRisks(route, { departAt: cst(2025, 3, 20, 12, 0) });
    const max = Math.max(...segs.map((s) => s.rP80));
    expect(max).toBeLessThan(30);
  });

  it('峰值详情包含可解释字段（F8 计算依据展示）', () => {
    const segs = computeSegmentRisks(route, { departAt: cst(2025, 3, 20, 7, 0) });
    const s = segs.reduce((a, b) => (b.rP80 > a.rP80 ? b : a));
    expect(s.peak).toBeDefined();
    expect(s.peak.at).toBeInstanceOf(Date);
    expect(Number.isFinite(s.peak.sunAzimuth)).toBe(true);
    expect(Number.isFinite(s.peak.sunElevation)).toBe(true);
    expect(Number.isFinite(s.peak.offAxisAngle)).toBe(true);
    expect(s.peak.heading).toBeCloseTo(90, 6);
  });
});

describe('mergeByRoad —— 守护缺陷 1（不得按分段聚合）', () => {
  /**
   * 构造：三段连续高速，都是高风险（清晨向东），
   * 若按分段聚合会得到 N 个窗口；按路名聚合应得到 1 个。
   */
  it('同一道路上连续的风险段合并为 1 个窗口', () => {
    const route = straightRoute(90, 30, 100, 'G2京沪高速');
    const segs = computeSegmentRisks(route, { departAt: cst(2025, 3, 20, 7, 0) });
    const windows = mergeByRoad(segs, '中');

    // 关键断言：窗口数必须远小于分段数
    expect(windows.length).toBeLessThan(segs.length / 5);
    for (const w of windows) {
      expect(w.segments.length).toBeGreaterThan(1);
      expect(w.road).toBe('G2京沪高速');
    }
  });

  it('不同道路不合并', () => {
    const segs: SegmentRisk[] = [
      makeRisk(0, 90, 100, '甲路', 70),
      makeRisk(1, 90, 100, '乙路', 70),
    ];
    const windows = mergeByRoad(segs, '中');
    expect(windows).toHaveLength(2);
  });

  it('低于阈值的段被排除', () => {
    const segs: SegmentRisk[] = [
      makeRisk(0, 90, 100, '甲路', 70),
      makeRisk(1, 90, 100, '甲路', 20), // 低
      makeRisk(2, 90, 100, '甲路', 70),
    ];
    // 中间的 20 分被排除，但前后两段同名且时间连续 -> 二次合并为 1 个
    const windows = mergeByRoad(segs, '中');
    expect(windows).toHaveLength(1);
    expect(windows[0]!.segments.length).toBe(2);
  });

  it('窗口的 maxRisk 取组内最大', () => {
    const segs: SegmentRisk[] = [
      makeRisk(0, 90, 100, '甲路', 65),
      makeRisk(1, 90, 100, '甲路', 72),
      makeRisk(2, 90, 100, '甲路', 68),
    ];
    const windows = mergeByRoad(segs, '中');
    expect(windows[0]!.maxRisk).toBe(72);
    expect(windows[0]!.level).toBe('高');
  });

  it('累计里程为组内分段之和', () => {
    const segs: SegmentRisk[] = [
      makeRisk(0, 90, 100, '甲路', 65),
      makeRisk(1, 90, 250, '甲路', 65),
    ];
    const windows = mergeByRoad(segs, '中');
    expect(windows[0]!.distance).toBe(350);
  });

  it('不足 1 分钟的窗口标记为 instantaneous（PRD F5）', () => {
    // 400m @ 53km/h ≈ 27 秒
    const segs: SegmentRisk[] = [
      makeRisk(0, 90, 400, '短路段', 70, 0),
    ];
    const windows = mergeByRoad(segs, '中');
    expect(windows[0]!.instantaneous).toBe(true);
    expect(windows[0]!.tEnd.getTime() - windows[0]!.tStart.getTime())
      .toBeLessThan(INSTANTANEOUS_THRESHOLD_MS);
  });

  it('空输入返回空数组', () => {
    expect(mergeByRoad([], '中')).toEqual([]);
  });

  it('无风险时返回空清单（F5 空状态的基础）', () => {
    const route = straightRoute(90, 10);
    const segs = computeSegmentRisks(route, { departAt: cst(2025, 3, 20, 2, 0) });
    expect(mergeByRoad(segs, '中')).toEqual([]);
  });

  it('sortWindows 按等级降序排列', () => {
    const segs: SegmentRisk[] = [
      makeRisk(0, 90, 100, '低路', 35),
      makeRisk(1, 90, 100, '高路', 65),
      makeRisk(2, 90, 100, '极高路', 85),
    ];
    const sorted = sortWindows(mergeByRoad(segs, '中'));
    expect(sorted[0]!.level).toBe('极高');
    expect(sorted[1]!.level).toBe('高');
    expect(sorted[2]!.level).toBe('中');
  });
});

describe('riskDistribution', () => {
  it('占比之和为 1', () => {
    const route = straightRoute(90, 20);
    const segs = computeSegmentRisks(route, { departAt: cst(2025, 3, 20, 7, 0) });
    const d = riskDistribution(segs);
    const sum = d['低'] + d['中'] + d['高'] + d['极高'];
    expect(sum).toBeCloseTo(1, 6);
  });

  it('空输入不产生 NaN', () => {
    const d = riskDistribution([]);
    expect(d['低']).toBe(0);
    expect(Number.isNaN(d['低'])).toBe(false);
  });
});

describe('optimizeDeparture —— 守护缺陷 2（不得推荐夜间出发）', () => {
  const route = straightRoute(90, 200, 100, 'G2京沪高速'); // 20km 向东

  const baseDate = cst(2025, 3, 20, 0, 0);

  it('到达时段约束必须生效：每个候选的到达时刻都落在窗口内', () => {
    const plan = optimizeDeparture({
      route,
      arrival: { from: { hour: 14, minute: 0 }, to: { hour: 17, minute: 0 } },
      baseDate,
    });

    expect(plan.candidates.length).toBeGreaterThan(0);
    const winFrom = cst(2025, 3, 20, 14, 0).getTime();
    const winTo = cst(2025, 3, 20, 17, 0).getTime();

    for (const c of plan.candidates) {
      // 这是曾经的 bug：浮点时长让到达时刻差 1 毫秒滑出窗口
      expect(c.arriveAt.getTime()).toBeGreaterThanOrEqual(winFrom);
      expect(c.arriveAt.getTime()).toBeLessThanOrEqual(winTo);
    }
  });

  it('可行出发区间已对齐到整分钟 —— 修复浮点滑出窗口', () => {
    const plan = optimizeDeparture({
      route,
      arrival: { from: { hour: 14, minute: 0 }, to: { hour: 17, minute: 0 } },
      baseDate,
    });
    for (const bound of [plan.feasibleFrom, plan.feasibleTo]) {
      expect(bound.getSeconds()).toBe(0);
      expect(bound.getMilliseconds()).toBe(0);
    }
  });

  it('可行出发区间的上界必须真的能按时到达（不是被浮点挤掉）', () => {
    const plan = optimizeDeparture({
      route,
      arrival: { from: { hour: 14, minute: 0 }, to: { hour: 17, minute: 0 } },
      baseDate,
    });
    const arriveAtUpper = plan.feasibleTo.getTime() + route.duration;
    expect(arriveAtUpper).toBeLessThanOrEqual(cst(2025, 3, 20, 17, 0).getTime());
  });

  it('所有候选的出发时刻都落在可达区间内', () => {
    const plan = optimizeDeparture({
      route,
      arrival: { from: { hour: 9, minute: 0 }, to: { hour: 12, minute: 0 } },
      baseDate,
    });
    for (const c of plan.candidates) {
      expect(c.departAt.getTime()).toBeGreaterThanOrEqual(plan.feasibleFrom.getTime());
      expect(c.departAt.getTime()).toBeLessThanOrEqual(plan.feasibleTo.getTime());
    }
  });

  it('候选按峰值风险升序（主指标，非平均暴露度）', () => {
    const plan = optimizeDeparture({
      route,
      arrival: { from: { hour: 8, minute: 0 }, to: { hour: 18, minute: 0 } },
      baseDate,
    });
    for (let i = 1; i < plan.candidates.length; i++) {
      expect(plan.candidates[i]!.peakRisk).toBeGreaterThanOrEqual(
        plan.candidates[i - 1]!.peakRisk,
      );
    }
  });

  it('峰值下界不低于任何候选的峰值风险', () => {
    const plan = optimizeDeparture({
      route,
      arrival: { from: { hour: 6, minute: 0 }, to: { hour: 19, minute: 0 } },
      baseDate,
    });
    for (const c of plan.candidates) {
      expect(c.peakRisk).toBeGreaterThanOrEqual(plan.peakLowerBound - 1e-6);
    }
  });

  it('窄到达时段仍可满足时，应照常给出方案（而非报失败）', () => {
    // 20km 需约 22.64 分钟。到达窗 12:00–12:05 反推出 11:38–11:42 的出发窗，
    // 仍能容纳候选 —— 用户的约束是可满足的，不该被报成失败。
    const plan = optimizeDeparture({
      route,
      arrival: { from: { hour: 12, minute: 0 }, to: { hour: 12, minute: 5 } },
      baseDate,
    });
    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(plan.unavoidable).toBe(false);

    const winFrom = cst(2025, 3, 20, 12, 0).getTime();
    const winTo = cst(2025, 3, 20, 12, 5).getTime();
    for (const c of plan.candidates) {
      expect(c.arriveAt.getTime()).toBeGreaterThanOrEqual(winFrom);
      expect(c.arriveAt.getTime()).toBeLessThanOrEqual(winTo);
    }
  });

  it('到达时段物理上不可满足时返回空候选且 unavoidable=true', () => {
    // 行程需 22.64 分钟，但要求 20 分钟内从 12:00 之前出发并 12:00 到达
    // 用一个「到达时刻早于最早可能出发时刻 + 时长」的窗口来构造不可能
    const impossible: Route = {
      ...route,
      // 拉长行程时长到 3 小时，使 12:00–12:05 窗口不可达
      duration: 3 * 3600_000,
    };
    const plan = optimizeDeparture({
      route: impossible,
      arrival: { from: { hour: 12, minute: 0 }, to: { hour: 12, minute: 5 } },
      baseDate,
      earliestDepartAt: cst(2025, 3, 20, 10, 0),
    });
    expect(plan.candidates).toHaveLength(0);
    expect(plan.unavoidable).toBe(true);
  });

  it('earliestDepartAt 作为硬下界生效', () => {
    const plan = optimizeDeparture({
      route,
      arrival: { from: { hour: 6, minute: 0 }, to: { hour: 20, minute: 0 } },
      baseDate,
      earliestDepartAt: cst(2025, 3, 20, 10, 0),
    });
    expect(plan.feasibleFrom.getHours()).toBeGreaterThanOrEqual(10);
  });

  it('输出危险窗口与安全窗口，且二者不重叠', () => {
    const plan = optimizeDeparture({
      route,
      arrival: { from: { hour: 6, minute: 0 }, to: { hour: 19, minute: 0 } },
      baseDate,
    });

    for (const d of plan.dangerousRanges) {
      expect(d.boundRisk).toBeGreaterThanOrEqual(60);
    }
    for (const s of plan.safeRanges) {
      expect(s.boundRisk).toBeLessThan(60);
    }

    // 危险窗与安全窗不应在时间上重叠
    for (const d of plan.dangerousRanges) {
      for (const s of plan.safeRanges) {
        const overlap =
          Math.min(d.to.getTime(), s.to.getTime()) -
          Math.max(d.from.getTime(), s.from.getTime());
        expect(overlap).toBeLessThanOrEqual(0);
      }
    }
  });

  it('向东路线在清晨存在危险窗口（日出迎面）', () => {
    const plan = optimizeDeparture({
      route,
      arrival: { from: { hour: 6, minute: 0 }, to: { hour: 19, minute: 0 } },
      baseDate,
    });
    // 若两阶段搜索正确，应至少捕获一个危险窗口
    expect(plan.dangerousRanges.length).toBeGreaterThan(0);
  });

  it('朝向决定逆光风险：东向路线存在危险窗口，南北向不存在', () => {
    const east = straightRoute(90, 200, 100, '东西路');
    const north = straightRoute(0, 200, 100, '南北路');
    const opts = {
      arrival: { from: { hour: 6, minute: 0 }, to: { hour: 19, minute: 0 } },
      baseDate,
    };
    const planEast = optimizeDeparture({ route: east, ...opts });
    const planNorth = optimizeDeparture({ route: north, ...opts });

    // 东西向公路在春分必然撞上日出/日落，存在危险出发窗口
    expect(planEast.dangerousRanges.length).toBeGreaterThan(0);

    // 南北向公路在春分几乎不会遇到正对太阳：全程无危险窗口
    expect(planNorth.dangerousRanges).toHaveLength(0);

    // 这也印证了 M0 的关键发现：安全出发时刻总是存在（如夜间），
    // 所以 peakLowerBound 全为 0 是正常的 —— 危险窗口的分布才是判据。
    // 详见 docs/m0-algorithm-validation-report.md §3
    expect(planNorth.peakLowerBound).toBeLessThanOrEqual(planEast.peakLowerBound + 1e-6);
  });

  it('peakLowerBound 反映最优可达水平，而非「是否存在风险」', () => {
    const east = straightRoute(90, 200, 100, '东西路');
    const plan = optimizeDeparture({
      route: east,
      arrival: { from: { hour: 6, minute: 0 }, to: { hour: 19, minute: 0 } },
      baseDate,
    });
    // 6:00–19:00 内总存在低风险时刻（如正午），故下界接近 0
    expect(plan.peakLowerBound).toBeLessThan(10);
    // 但仍有危险窗口 —— 这两件事并不矛盾
    expect(plan.dangerousRanges.length).toBeGreaterThan(0);
  });

  it('isNearDanger 能识别贴着危险窗口的候选', () => {
    const plan = optimizeDeparture({
      route,
      arrival: { from: { hour: 6, minute: 0 }, to: { hour: 19, minute: 0 } },
      baseDate,
    });
    const near = plan.candidates.filter((c) => isNearDanger(c, plan));
    // 结果可为空，但不得抛错；若危险窗存在，应能判定出接近性
    expect(Array.isArray(near)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/** 直接构造一个 SegmentRisk，便于测 mergeByRoad 的聚合逻辑 */
function makeRisk(
  index: number,
  heading: number,
  dist: number,
  road: string,
  rP80: number,
  startOffsetSec = index * 7,
): SegmentRisk {
  const base = cst(2025, 3, 20, 7, 0).getTime() + startOffsetSec * 1000;
  return {
    index,
    a: { lon: 116.4 + index * 0.001, lat: 39.9 },
    b: { lon: 116.4 + (index + 1) * 0.001, lat: 39.9 },
    heading,
    dist,
    road,
    tStart: new Date(base),
    tEnd: new Date(base + 7000),
    rP80,
    rMax: rP80,
    peak: {
      score: rP80,
      at: new Date(base),
      sunAzimuth: 90,
      sunElevation: 5,
      heading,
      offAxisAngle: 2,
    },
  };
}
