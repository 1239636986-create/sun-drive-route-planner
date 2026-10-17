/**
 * 出发优化的天气一致性回归测试
 *
 * 这里守护的是一个**状态管理缺陷**，不是算法缺陷：
 *
 *   症状：同一屏上，候选方案显示「峰值风险 0」，而危险出发窗口却挂着
 *        「峰值 98」。天气系数是 0.15，不可能出现 98 分 —— 自相矛盾。
 *
 *   根因：`useRouteAnalysis` 里重算出发方案的 effect 依赖数组漏了
 *        weatherFactor。天气是异步到达的（要先逆地理编码取 adcode，
 *        再取天气），于是流程变成：
 *          路线到手 → 用 f=1.0 算计划
 *          天气到达 → 候选/结论用 f=0.15 重算，但计划停留在 f=1.0
 *
 *   教训：一个「计算」依赖多个输入时，触发它的 effect 必须覆盖**全部**输入。
 *        写 `[arrival.from, arrival.to]` 而不用 `runPlan` 本身，就容易漏。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { routeFromAmapPayload } from '@/providers/amapProvider.js';
import { computeSegmentRisks } from '@/domain/riskAggregator.js';
import { computePlan } from '@/ui/useRouteAnalysis.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const route = routeFromAmapPayload(
  JSON.parse(readFileSync(join(__dirname, '../fixtures/route_bj_tj.json'), 'utf-8')),
);

/** 用一个固定日期，避免测试随「今天」漂移导致预报/日出时刻变化 */
const BASE_DATE = new Date(2026, 9, 12, 0, 0, 0);

const ARRIVAL = { from: '17:00', to: '20:00' };

describe('computePlan —— 纯函数抽出后可直接测试', () => {
  it('正常输入产出候选，无错误', () => {
    const { plan, error } = computePlan(route, ARRIVAL, 1.0, BASE_DATE);
    expect(error).toBeNull();
    expect(plan).not.toBeNull();
    expect(plan!.candidates.length).toBeGreaterThan(0);
  });

  it('时段格式非法时给出可操作错误', () => {
    const { plan, error } = computePlan(route, { from: '25:99', to: 'oops' }, 1.0, BASE_DATE);
    expect(plan).toBeNull();
    expect(error).toContain('HH:mm');
  });

  it('时段物理上不可满足时给出含时长的错误', () => {
    /**
     * 构造方式要小心：单纯拉长行程时长并不会让窗口不可满足 ——
     * 到达窗 12:00–12:05 配 3 小时行程，反推出的是 09:00–09:05 的出发窗，
     * 照样可满足（这是早期写错的测试）。
     *
     * 真正不可满足需要**互相矛盾的约束**：最早出发时间晚于最晚可出发时间。
     * 这里用「12:00 到，但 20:00 才能出发」。
     */
    const { plan, error } = computePlan(
      route,
      { from: '12:00', to: '12:05' },
      1.0,
      BASE_DATE,
      new Date(2026, 9, 12, 20, 0, 0),
    );
    expect(plan).toBeNull();
    expect(error).toContain('分钟');
  });
});

describe('天气系数必须贯穿整个出发优化', () => {
  it('不同天气系数产出不同的危险窗口 —— 证明系数真的生效', () => {
    const clear = computePlan(route, ARRIVAL, 1.0, BASE_DATE).plan!;
    const rainy = computePlan(route, ARRIVAL, 0.15, BASE_DATE).plan!;

    expect(clear).not.toBeNull();
    expect(rainy).not.toBeNull();

    // 晴天必然存在危险窗口；小雨（0.15）不应存在
    expect(clear.dangerousRanges.length).toBeGreaterThan(0);
    expect(rainy.dangerousRanges).toHaveLength(0);
  });

  it('所有报告出的风险值都受天气系数约束 —— 漏用系数立刻暴露', () => {
    /**
     * 核心不变量：`R = 100 · w(θ) · f_sun(h) · f_weather · …`，
     * 而 `w(θ) ≤ 1`、`f_sun(h) ≤ 1`，故 **R ≤ 100 · f_weather**。
     *
     * 这是判断「有没有漏用天气系数」最直接的标尺：
     * 若优化器内部用 f=1.0 评估，却在 f=0.25 的界面上展示，
     * 峰值必然突破 25 的上限。
     *
     * （早期版本的断言拿 feasibleFrom/feasibleTo 两个端点的峰值当上限，
     *   但峰值出现在区间中间，端点恰好较低，故上限算低了 —— 断言本身是错的。）
     */
    for (const f of [1.0, 0.5, 0.25, 0.15]) {
      const plan = computePlan(route, ARRIVAL, f, BASE_DATE).plan!;
      const cap = 100 * f + 1e-6;

      for (const r of plan.dangerousRanges) {
        expect(r.boundRisk).toBeLessThanOrEqual(cap);
      }
      for (const r of plan.safeRanges) {
        expect(r.boundRisk).toBeLessThanOrEqual(cap);
      }
      for (const c of plan.candidates) {
        expect(c.peakRisk).toBeLessThanOrEqual(cap);
      }
      expect(plan.peakLowerBound).toBeLessThanOrEqual(cap);
    }
  });

  it('小雨下不可能出现「高」以上风险 —— 0.15 的系数让满分也才 15', () => {
    const plan = computePlan(route, ARRIVAL, 0.15, BASE_DATE).plan!;
    expect(plan.dangerousRanges).toHaveLength(0);
    expect(plan.peakLowerBound).toBeLessThanOrEqual(15.0001);
    for (const c of plan.candidates) {
      expect(c.peakRisk).toBeLessThanOrEqual(15.0001);
    }
  });

  it('候选的峰值风险同样必须与独立重算一致', () => {
    for (const f of [1.0, 0.15]) {
      const plan = computePlan(route, ARRIVAL, f, BASE_DATE).plan!;
      for (const c of plan.candidates) {
        const segs = computeSegmentRisks(route, { departAt: c.departAt, weatherFactor: f });
        const rerun = Math.max(...segs.map((s) => s.rP80));
        expect(Math.abs(rerun - c.peakRisk)).toBeLessThan(1);
      }
    }
  });

  it('计划内部自洽：危险窗口存在时，安全候选的峰值必须低于阈值', () => {
    // 这是「候选 0 分 + 危险窗 98 分」那种自相矛盾的最小可测形式
    for (const f of [1.0, 0.55, 0.25, 0.15]) {
      const plan = computePlan(route, ARRIVAL, f, BASE_DATE).plan!;

      if (plan.dangerousRanges.length > 0) {
        // 有危险窗时，其峰值必然 >= 60，而候选若显示 0 就是不合理的
        const maxDanger = Math.max(...plan.dangerousRanges.map((r) => r.boundRisk));
        const bestCandidate = Math.min(...plan.candidates.map((c) => c.peakRisk));

        // 候选不该显著优于全局峰值下界
        expect(bestCandidate).toBeGreaterThanOrEqual(plan.peakLowerBound - 1e-6);

        // 危险窗峰值应确实达到「高」门槛
        expect(maxDanger).toBeGreaterThanOrEqual(60);
      }
    }
  });

  it('峰值下界随天气减弱而下降', () => {
    const bounds = [1.0, 0.55, 0.25, 0.15].map(
      (f) => computePlan(route, ARRIVAL, f, BASE_DATE).plan!.peakLowerBound,
    );
    for (let i = 1; i < bounds.length; i++) {
      expect(bounds[i]!).toBeLessThanOrEqual(bounds[i - 1]! + 1e-6);
    }
  });

  it('unavoidable 标记与峰值下界一致', () => {
    for (const f of [1.0, 0.55, 0.25, 0.15]) {
      const plan = computePlan(route, ARRIVAL, f, BASE_DATE).plan!;
      expect(plan.unavoidable).toBe(plan.peakLowerBound >= 60);
    }
  });
});
