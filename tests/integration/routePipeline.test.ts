/**
 * 端到端集成测试 —— 真实路线跑完整链路
 *
 * 用真实高德响应（天安门 → 天津站，138.5km）驱动
 * Provider → 风险计算 → 路名聚合 → 出发优化 的全部环节。
 *
 * 期望值是**实测基线**，来自两端独立实现的交叉验证：
 *   - Python 原型（prototype/validate_algorithm_v2.py）
 *   - TypeScript 实现（本工程）
 * 两者在峰值时刻、太阳方位角、峰值风险上一致到 0.5 分以内。
 *
 * ⚠️ 这些是回归基线，不是绝对真值。若高德路网数据或路况更新，
 *    duration 会变化，进而影响每段的通过时刻与风险分布。
 *    届时需重新采集基线，而不是把测试改到通过。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { routeFromAmapPayload } from '@/providers/amapProvider.js';
import {
  computeSegmentRisks,
  mergeByRoad,
  sortWindows,
  riskDistribution,
} from '@/domain/riskAggregator.js';
import { optimizeDeparture, isNearDanger } from '@/domain/departureOptimizer.js';
import { riskLevel } from '@/domain/glareEngine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/route_bj_tj.json'), 'utf-8'),
);
const route = routeFromAmapPayload(fixture);

const cst = (h: number, mi = 0) =>
  new Date(Date.UTC(2025, 2, 20, h - 8, mi, 0));

describe('端到端 · 路线解析', () => {
  it('138.5km / 1484 段 —— 未做无谓重采样', () => {
    expect(route.distance).toBeGreaterThan(138_000);
    expect(route.distance).toBeLessThan(139_000);

    /**
     * 段数构成（实测核对）：
     *   原始折线段 1338
     *   丢弃退化段(<1m) 1 个
     *   超长段(>300m) 42 个被细分，共 +146 段
     *   合计 1484
     *
     * 注意：Python 原型得到 1814 段，因为它把所有段强制重采样到 100m ——
     * 那会改变原始几何，且把 50m 的段拉长到 100m 引入里程误差。
     * 本实现只清洗退化段、只细分超长段，更忠实于高德返回的路网几何。
     */
    expect(route.segments.length).toBe(1484);
  });

  it('总里程与接口值一致（误差 < 1%）', () => {
    const total = route.segments.reduce((s, x) => s + x.dist, 0);
    expect(Math.abs(total - route.distance) / route.distance).toBeLessThan(0.01);
  });
});

describe('端到端 · 清晨 07:00 出发（春分，日出后约 45 分钟）', () => {
  const segs = computeSegmentRisks(route, { departAt: cst(7) });

  it('风险分布：绝大多数低风险，少量高风险（局部聚集）', () => {
    const d = riskDistribution(segs);
    expect(d['低']).toBeGreaterThan(0.9);
    expect(d['高'] + d['极高']).toBeGreaterThan(0.01);
    expect(d['高'] + d['极高']).toBeLessThan(0.06);
  });

  it('最严重路段是东长安街，朝向约 84°，峰值约 68 分', () => {
    const worst = segs.reduce((a, b) => (b.rP80 > a.rP80 ? b : a));
    expect(worst.road).toBe('东长安街');
    expect(Math.abs(worst.heading - 83.7)).toBeLessThan(1);
    expect(worst.rP80).toBeGreaterThan(65);
    expect(worst.rP80).toBeLessThan(71);
    expect(riskLevel(worst.rP80)).toBe('高');
  });

  it('该路段正对太阳：离轴角小于 8°，太阳方位约 83°', () => {
    const worst = segs.reduce((a, b) => (b.rP80 > a.rP80 ? b : a));
    expect(worst.peak.offAxisAngle).toBeLessThan(8);
    expect(Math.abs(worst.peak.sunAzimuth - 83.4)).toBeLessThan(1);
    // 低太阳：高度角 7–8°
    expect(worst.peak.sunElevation).toBeGreaterThan(6);
    expect(worst.peak.sunElevation).toBeLessThan(9);
  });

  it('峰值出现在出发后 2 分钟左右（CST 07:02）', () => {
    const worst = segs.reduce((a, b) => (b.rP80 > a.rP80 ? b : a));
    const offsetMin = (worst.peak.at.getTime() - cst(7).getTime()) / 60_000;
    expect(offsetMin).toBeGreaterThan(1);
    expect(offsetMin).toBeLessThan(4);
  });

  it('高风险清单按路名聚合，条目数远小于分段数（守护缺陷 1）', () => {
    const windows = sortWindows(mergeByRoad(segs, '高'));
    expect(windows.length).toBeGreaterThan(0);
    // 关键：清单不应碎成一堆 100m 条目
    expect(windows.length).toBeLessThan(10);

    const top = windows[0]!;
    expect(top.road).toBe('东长安街');
    expect(top.level).toBe('高');
    expect(top.distance).toBeGreaterThan(1000);
  });

  it('清单时间窗宽度合理，且过短路段标记为瞬时', () => {
    const windows = mergeByRoad(segs, '高');
    for (const w of windows) {
      const widthMs = w.tEnd.getTime() - w.tStart.getTime();
      if (w.instantaneous) {
        expect(widthMs).toBeLessThan(60_000);
      }
    }
    // 主窗口（东长安街 2.2km）不应是瞬时的
    const main = windows.find((w) => w.road === '东长安街');
    expect(main).toBeDefined();
    expect(main!.instantaneous).toBe(false);
  });

  it('无极高风险（春分清晨太阳高度角还不够低）', () => {
    expect(segs.every((s) => riskLevel(s.rP80) !== '极高')).toBe(true);
  });
});

describe('端到端 · 下午 16:00 出发（向西撞落日）', () => {
  const segs = computeSegmentRisks(route, { departAt: cst(16) });

  it('峰值为极高风险，且出现在向西路段', () => {
    const worst = segs.reduce((a, b) => (b.rP80 > a.rP80 ? b : a));
    expect(riskLevel(worst.rP80)).toBe('极高');
    // 朝西：265°–280°
    expect(worst.heading).toBeGreaterThan(265);
    expect(worst.heading).toBeLessThan(281);
  });

  it('太阳方位同样朝西且高度角很低（贴地平线）', () => {
    const worst = segs.reduce((a, b) => (b.rP80 > a.rP80 ? b : a));
    expect(worst.peak.sunAzimuth).toBeGreaterThan(265);
    expect(worst.peak.sunAzimuth).toBeLessThan(285);
    expect(worst.peak.sunElevation).toBeLessThan(10);
  });

  it('该场景比清晨更危险（太阳更低 + 正对）', () => {
    const morning = computeSegmentRisks(route, { departAt: cst(7) });
    const mWorst = morning.reduce((a, b) => (b.rP80 > a.rP80 ? b : a));
    const eWorst = segs.reduce((a, b) => (b.rP80 > a.rP80 ? b : a));
    expect(eWorst.rP80).toBeGreaterThan(mWorst.rP80);
  });
});

describe('端到端 · 正午 12:00 出发（太阳高挂）', () => {
  it('全程低风险 —— 遮阳板可挡，不误报', () => {
    const segs = computeSegmentRisks(route, { departAt: cst(12) });
    const max = Math.max(...segs.map((s) => s.rP80));
    expect(max).toBeLessThan(30);
    expect(mergeByRoad(segs, '中')).toHaveLength(0);
  });
});

describe('端到端 · 夜间出发', () => {
  it('全程零风险', () => {
    const segs = computeSegmentRisks(route, { departAt: cst(2) });
    expect(segs.every((s) => s.rP80 === 0 && s.rMax === 0)).toBe(true);
    expect(mergeByRoad(segs, '中')).toHaveLength(0);
  });
});

describe('端到端 · F6 出发优化（到达 17:00–20:00）', () => {
  const plan = optimizeDeparture({
    route,
    arrival: { from: { hour: 17, minute: 0 }, to: { hour: 20, minute: 0 } },
    baseDate: cst(0),
  });

  it('候选的到达时刻全部落在用户选定的时段内', () => {
    expect(plan.candidates.length).toBeGreaterThan(0);
    const from = cst(17).getTime();
    const to = cst(20).getTime();
    for (const c of plan.candidates) {
      expect(c.arriveAt.getTime()).toBeGreaterThanOrEqual(from);
      expect(c.arriveAt.getTime()).toBeLessThanOrEqual(to);
    }
  });

  it('推荐的是 16:37 出发（避开 15:37–16:37 的落日危险窗）', () => {
    const best = plan.candidates[0]!;
    expect(best.departAt.getHours()).toBe(16);
    expect(best.departAt.getMinutes()).toBe(37);
    expect(best.peakRisk).toBeLessThan(35);
  });

  it('识别出危险出发窗口，且其峰值风险达到「高」', () => {
    expect(plan.dangerousRanges.length).toBeGreaterThan(0);
    for (const r of plan.dangerousRanges) {
      expect(r.boundRisk).toBeGreaterThanOrEqual(60);
    }
  });

  it('首个危险窗覆盖 15:37–16:37 —— 与推荐时刻恰好相邻', () => {
    const first = plan.dangerousRanges[0]!;
    expect(first.from.getHours()).toBe(15);
    expect(first.from.getMinutes()).toBe(37);
    expect(first.boundRisk).toBeGreaterThan(90);
  });

  it('最优候选贴着危险窗口，isNearDanger 必须能识别（否则会漏掉警告）', () => {
    const best = plan.candidates[0]!;
    // 16:37 出发正好在危险窗上界 —— 这种「差一点就中招」必须警告
    expect(isNearDanger(best, plan)).toBe(true);
  });

  it('可行区间内的峰值下界约为 30（存在可用方案，故 unavoidable=false）', () => {
    expect(plan.peakLowerBound).toBeGreaterThan(25);
    expect(plan.peakLowerBound).toBeLessThan(35);
    expect(plan.unavoidable).toBe(false);
  });

  it('所有候选都优于盲目按最早时刻出发', () => {
    // 对照：若用户直接选最早可行时刻出发，峰值应更高
    const earliest = computeSegmentRisks(route, { departAt: plan.feasibleFrom });
    const earliestPeak = Math.max(...earliest.map((s) => s.rP80));
    expect(plan.candidates[0]!.peakRisk).toBeLessThan(earliestPeak);
  });
});

describe('端到端 · 不可回避的峰值（PRD 验收 T07 的实例）', () => {
  it('早出与晚出各有一个高峰，说明东西向路线无法同时避开日出与日落', () => {
    const morning = computeSegmentRisks(route, { departAt: cst(6, 30) });
    const evening = computeSegmentRisks(route, { departAt: cst(15, 45) });

    const mPeak = Math.max(...morning.map((s) => s.rP80));
    const ePeak = Math.max(...evening.map((s) => s.rP80));

    // 清晨向东撞朝阳，傍晚向西撞落日 —— 两者都很高
    expect(mPeak).toBeGreaterThan(60);
    expect(ePeak).toBeGreaterThan(60);

    // 这正是 PRD F6「反建议」要覆盖的情形：不存在一个时段能同时避开
    // （若要完全避开，只能选正午或夜间出发）
  });

  it('全天扫描确实存在低风险时段，因此不应判为 unavoidable', () => {
    // 反向校验：如果模型无脑报警，这条会失败
    const noon = computeSegmentRisks(route, { departAt: cst(12) });
    expect(Math.max(...noon.map((s) => s.rP80))).toBeLessThan(30);
  });
});
