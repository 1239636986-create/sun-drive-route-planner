/**
 * GlareEngine 回归测试
 *
 * 全部期望值来自 Python 原型的实测输出（见 docs/m0-algorithm-validation-report.md），
 * 不是从本实现反推的。这是「移植保真」的证明。
 */

import { describe, it, expect } from 'vitest';
import {
  offAxisAngle,
  angleWeight,
  sunFactor,
  riskScore,
  riskLevel,
  HIGH_RISK_THRESHOLD,
} from '@/domain/glareEngine.js';

describe('离轴角 offAxisAngle', () => {
  it('太阳正前方地平线 -> 0°，最危险', () => {
    expect(offAxisAngle(0, 0)).toBeCloseTo(0, 6);
  });

  it('太阳正头顶 -> 90°，不刺眼（遮阳板可挡）', () => {
    expect(offAxisAngle(90, 0)).toBeCloseTo(90, 6);
  });

  it('太阳正后方 -> 180°，无影响', () => {
    expect(offAxisAngle(60, 180)).toBeCloseTo(120, 6);
    expect(offAxisAngle(0, 180)).toBeCloseTo(180, 6);
  });

  it('太阳正侧方地平线 -> 90°', () => {
    expect(offAxisAngle(0.5, 90)).toBeCloseTo(90, 4);
  });

  it('正东行驶 + 太阳方位 90° + 高度 10° -> 离轴角 10°', () => {
    // 车头朝东(90°)，太阳方位也是 90° -> ΔA = 0，此时 θ = h
    expect(offAxisAngle(10, 0)).toBeCloseTo(10, 6);
  });
});

describe('角度权重 angleWeight', () => {
  it('θ=15° 时恰为 0.5 —— 设计锚点', () => {
    expect(angleWeight(15)).toBeCloseTo(0.5, 6);
  });

  it('θ=0 时为 1.0', () => {
    expect(angleWeight(0)).toBeCloseTo(1.0, 6);
  });

  it('权重随 θ 严格单调递减', () => {
    let prev = Number.POSITIVE_INFINITY;
    for (let t = 0; t <= 180; t += 1) {
      const w = angleWeight(t);
      expect(w).toBeLessThan(prev);
      prev = w;
    }
  });

  it('精确值表（Python 原型实测）', () => {
    const table: Array<[number, number]> = [
      [0, 1.0],
      [5, 0.8529],
      [10, 0.6567],
      [15, 0.5],
      [20, 0.3869],
      [30, 0.2481],
      [45, 0.1471],
      [60, 0.0981],
      [90, 0.0538],
    ];
    for (const [theta, expected] of table) {
      expect(angleWeight(theta)).toBeCloseTo(expected, 4);
    }
  });
});

describe('太阳高度角因子 sunFactor', () => {
  it('h <= 0 时归零 —— 保证夜间计算绝对为 0', () => {
    expect(sunFactor(0)).toBe(0);
    expect(sunFactor(-1)).toBe(0);
    expect(sunFactor(-30)).toBe(0);
  });

  it('h = 0.5 时为 1.0（几何日出）', () => {
    expect(sunFactor(0.5)).toBeCloseTo(1.0, 6);
  });

  it('h >= 60 时保底 0.2', () => {
    expect(sunFactor(60)).toBeCloseTo(0.2, 6);
    expect(sunFactor(90)).toBeCloseTo(0.2, 6);
  });

  it('随高度角严格单调递减 —— 守护 v0.1 的非单调缺陷', () => {
    let prev = Number.POSITIVE_INFINITY;
    for (let h = 0.5; h <= 90; h += 0.1) {
      const f = sunFactor(h);
      expect(f).toBeLessThanOrEqual(prev + 1e-12);
      prev = f;
    }
  });
});

describe('风险分数 riskScore —— 校准表逐行复现（T13）', () => {
  /**
   * 正对太阳（ΔA = 0）时 θ = h，故只给高度角即可。
   * 期望值来自 Python 原型实测，非从本实现反推。
   */
  const calibrationTable: Array<[number, number, string]> = [
    [0.5, 99.6, '极高'],
    [1, 98.0, '极高'],
    [2, 94.2, '极高'],
    [3, 89.8, '极高'],
    [5, 80.1, '极高'],
    [7, 70.4, '高'],
    [10, 57.3, '中'],
    [15, 40.3, '中'],
    [20, 28.5, '低'],
    [30, 15.0, '低'],
    [45, 5.9, '低'],
    [60, 2.0, '低'],
    [80, 1.3, '低'],
  ];

  it.each(calibrationTable)(
    'h=%s° -> R≈%s (%s)',
    (h, expected, level) => {
      const r = riskScore({ sunElevation: h, deltaAzimuth: 0 });
      expect(r).toBeCloseTo(expected, 1); // 容差 0.2，用 1 位小数断言
      expect(riskLevel(r)).toBe(level);
    },
  );

  it('最大偏差不超过 0.2 分 —— PRD T13 的容差要求', () => {
    for (const [h, expected] of calibrationTable) {
      const r = riskScore({ sunElevation: h, deltaAzimuth: 0 });
      expect(Math.abs(r - expected)).toBeLessThanOrEqual(0.2);
    }
  });
});

describe('风险分数的边界性质 —— 守护 v0.1 的两个缺陷', () => {
  it('正对太阳时 R 随 h 严格单调递减（T12）', () => {
    let prev = Number.POSITIVE_INFINITY;
    for (let h = 0.5; h <= 90; h += 0.1) {
      const r = riskScore({ sunElevation: h, deltaAzimuth: 0 });
      expect(r).toBeLessThanOrEqual(prev + 1e-9);
      prev = r;
    }
  });

  it('「极高」等级可达 —— v0.1 曾是死档，上限仅约 71.6', () => {
    // 日出直射是最危险的场景，必须能触发极高
    const r = riskScore({ sunElevation: 3, deltaAzimuth: 0 });
    expect(r).toBeGreaterThanOrEqual(80);
    expect(riskLevel(r)).toBe('极高');
  });

  it('h >= 20° 时即使正对太阳也不超过「中」', () => {
    for (let h = 20; h <= 90; h += 5) {
      const r = riskScore({ sunElevation: h, deltaAzimuth: 0 });
      expect(riskLevel(r)).not.toBe('高');
      expect(riskLevel(r)).not.toBe('极高');
    }
  });

  it('太阳在地平线下时 R 恒为 0，不论方向', () => {
    for (const h of [0, -1, -5, -20]) {
      for (const dA of [0, 30, 90, 180]) {
        expect(riskScore({ sunElevation: h, deltaAzimuth: dA })).toBe(0);
      }
    }
  });

  it('风险分数恒在 [0, 100] 内', () => {
    for (let h = -10; h <= 90; h += 2.5) {
      for (let dA = 0; dA <= 180; dA += 15) {
        const r = riskScore({ sunElevation: h, deltaAzimuth: dA });
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('真实场景推演表（PRD 6.4.7）', () => {
  const scenarios: Array<[string, number, number, number, string]> = [
    // [名称, 高度角, ΔA, 期望分数, 期望等级]
    ['清晨向东，太阳正前偏 2°', 3, 2, 87.7, '极高'],
    ['清晨向东，太阳正前偏 2°', 10, 2, 56.7, '中'],
    ['清晨向东，太阳正前偏 5°', 5, 5, 72.3, '高'],
    ['傍晚向西，太阳正前偏 3°', 2, 3, 88.9, '极高'],
    ['上午东南向，偏离 20°', 15, 20, 24.9, '低'],
    ['太阳高挂偏前 10°', 45, 10, 5.8, '低'],
    ['正午头顶', 80, 0, 1.3, '低'],
    ['向北开，太阳在东南', 20, 135, 2.2, '低'],
    ['太阳在正后方', 10, 180, 1.8, '低'],
  ];

  it.each(scenarios)('%s (h=%s°, ΔA=%s°) -> R≈%s %s', (_name, h, dA, expected, level) => {
    const r = riskScore({ sunElevation: h, deltaAzimuth: dA });
    expect(r).toBeCloseTo(expected, 1);
    expect(riskLevel(r)).toBe(level);
  });
});

describe('天气因子（F7）', () => {
  it('阴天时即使正对太阳也只有低风险', () => {
    // 云量 > 75% -> 系数 0.25
    const r = riskScore({ sunElevation: 3, deltaAzimuth: 0, weatherFactor: 0.25 });
    expect(r).toBeLessThan(HIGH_RISK_THRESHOLD);
    expect(riskLevel(r)).toBe('低');
  });

  it('天气系数线性作用于结果', () => {
    const base = riskScore({ sunElevation: 10, deltaAzimuth: 0 });
    const half = riskScore({ sunElevation: 10, deltaAzimuth: 0, weatherFactor: 0.5 });
    expect(half).toBeCloseTo(base * 0.5, 6);
  });
});

describe('风险分级阈值（PRD 6.6）', () => {
  it.each([
    [0, '低'],
    [29.9, '低'],
    [30, '中'],
    [59.9, '中'],
    [60, '高'],
    [79.9, '高'],
    [80, '极高'],
    [100, '极高'],
  ] as Array<[number, string]>)('%s -> %s', (score, level) => {
    expect(riskLevel(score)).toBe(level);
  });
});
