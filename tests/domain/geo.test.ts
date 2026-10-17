/**
 * 几何工具测试
 *
 * 期望值由独立的 Python 实现算出（见构建过程的推导），
 * 不是从本实现反推的。东北向 37.468° 可独立验证：
 *   atan(1 / cos(39.90°)) = atan(1.3024) = 37.47°  ✓
 */

import { describe, it, expect } from 'vitest';
import {
  bearingDeg,
  haversineM,
  percentile,
  lerpLonLat,
  midpoint,
  normalize180,
  normalize360,
  buildSegments,
  MIN_SEGMENT_M,
  MAX_SEGMENT_M,
} from '@/domain/geo.js';
import type { LonLat } from '@/domain/types.js';

const P = (lon: number, lat: number): LonLat => ({ lon, lat });

describe('bearingDeg —— 大圆初始方位角', () => {
  it.each([
    ['正北', P(116.4, 39.9), P(116.4, 39.95), 0],
    ['正东', P(116.4, 39.9), P(116.45, 39.9), 89.984],
    ['正南', P(116.4, 39.95), P(116.4, 39.9), 180],
    ['正西', P(116.45, 39.9), P(116.4, 39.9), 270.016],
    ['东北', P(116.4, 39.9), P(116.45, 39.95), 37.468],
    ['西南', P(116.45, 39.95), P(116.4, 39.9), 217.5],
  ])('%s 方向', (_name, a, b, expected) => {
    expect(bearingDeg(a as LonLat, b as LonLat)).toBeCloseTo(expected as number, 2);
  });

  it('东北向：大圆初始方位角 37.468° 与平面近似 37.494° 相差 0.026°', () => {
    /**
     * 两个不同的量：
     *   ① 大圆**初始**方位角（bearingDeg） = 37.468°  <- 起点切线方向
     *   ② 平面弦近似 atan(cos(39.9°))      = 37.494°  <- 终点相对起点的方向
     *
     * 差 0.026° 来自大圆路径曲率，属正确行为。
     * ① 与独立 Python 实现的大圆结果一致（37.468°），确认移植保真。
     */
    const chordApprox = (Math.atan(Math.cos((39.9 * Math.PI) / 180)) * 180) / Math.PI;
    const greatCircle = bearingDeg(P(116.4, 39.9), P(116.45, 39.95));

    expect(chordApprox).toBeCloseTo(37.494, 3);
    expect(greatCircle).toBeCloseTo(37.468, 3);
    expect(chordApprox - greatCircle).toBeGreaterThan(0.02);
    expect(chordApprox - greatCircle).toBeLessThan(0.03);
  });

  it('精确构造 45° 东北向路径，方位角应为 45°', () => {
    // 要让方位角恰为 45°，需 Δlat = Δlon · cos(lat)
    const dLon = 0.05;
    const dLat = dLon * Math.cos((39.9 * Math.PI) / 180);
    expect(bearingDeg(P(116.4, 39.9), P(116.4 + dLon, 39.9 + dLat))).toBeCloseTo(45, 1);
  });

  it('结果恒在 [0, 360)', () => {
    for (let dLat = -5; dLat <= 5; dLat += 1) {
      for (let dLon = -5; dLon <= 5; dLon += 1) {
        if (dLat === 0 && dLon === 0) continue;
        const b = bearingDeg(P(116.4, 39.9), P(116.4 + dLon * 0.01, 39.9 + dLat * 0.01));
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThan(360);
      }
    }
  });

  it('反向路径的方位角与正向相差约 180°', () => {
    const a = P(116.4, 39.9);
    const b = P(117.2, 39.1);
    const forward = bearingDeg(a, b);
    const backward = bearingDeg(b, a);
    const diff = Math.abs(normalize180(backward - forward));
    // 大圆方位角不是严格互反，留 1° 容差
    expect(Math.abs(diff - 180)).toBeLessThan(1);
  });

  it('高纬度仍正确（经线收敛不影响初始方位定义）', () => {
    expect(bearingDeg(P(10, 60), P(10.1, 60))).toBeCloseTo(89.957, 2);
  });
});

describe('haversineM', () => {
  it('正北 0.05° 纬度差 ≈ 5559.75m', () => {
    expect(haversineM(P(116.4, 39.9), P(116.4, 39.95))).toBeCloseTo(5559.75, 0);
  });

  it('同一点距离为 0', () => {
    expect(haversineM(P(116.4, 39.9), P(116.4, 39.9))).toBe(0);
  });

  it('对称性', () => {
    const a = P(116.4, 39.9);
    const b = P(117.2, 39.1);
    expect(haversineM(a, b)).toBeCloseTo(haversineM(b, a), 6);
  });

  it('北京到天津约 110–120km 量级', () => {
    const d = haversineM(P(116.397428, 39.90923), P(117.201509, 39.085308));
    expect(d).toBeGreaterThan(100_000);
    expect(d).toBeLessThan(130_000);
  });
});

describe('percentile', () => {
  it('空数组返回 0', () => {
    expect(percentile([], 0.8)).toBe(0);
  });

  it('单元素返回该元素', () => {
    expect(percentile([42], 0.8)).toBe(42);
  });

  it('P80 在已知序列上的值', () => {
    // [1..10] 的 P80 = 1 + (10-1)*0.8 = 8.2
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.8)).toBeCloseTo(8.2, 6);
  });

  it('P0 与 P100 分别为最小与最大值', () => {
    const v = [5, 1, 9, 3, 7];
    expect(percentile(v, 0)).toBe(1);
    expect(percentile(v, 1)).toBe(9);
  });

  it('不修改入参数组', () => {
    const v = [3, 1, 2];
    percentile(v, 0.5);
    expect(v).toEqual([3, 1, 2]);
  });

  it('P80 <= max，且 >= 中位数（对右偏分布）', () => {
    const v = [0, 0, 0, 0, 0, 0, 0, 0, 90, 100];
    const p80 = percentile(v, 0.8);
    expect(p80).toBeLessThanOrEqual(Math.max(...v));
    expect(p80).toBeGreaterThanOrEqual(percentile(v, 0.5));
  });
});

describe('normalize360 / normalize180', () => {
  it('normalize360 把任意角归到 [0,360)', () => {
    expect(normalize360(0)).toBe(0);
    expect(normalize360(360)).toBe(0);
    expect(normalize360(-90)).toBe(270);
    expect(normalize360(450)).toBe(90);
  });

  it('normalize180 把任意角归到 (-180,180]', () => {
    expect(normalize180(0)).toBe(0);
    expect(normalize180(180)).toBe(180);
    expect(normalize180(190)).toBe(-170);
    expect(normalize180(-190)).toBe(170);
    expect(normalize180(350)).toBe(-10);
  });

  it('方位差计算：太阳方位与车头朝向的最小夹角', () => {
    // 车头 350°，太阳 10° -> 夹角应为 20° 而非 340°
    const diff = Math.abs(normalize180(10 - 350));
    expect(diff).toBeCloseTo(20, 6);
  });
});

describe('lerpLonLat / midpoint', () => {
  it('t=0 与 t=1 返回端点', () => {
    const a = P(116, 39);
    const b = P(117, 40);
    expect(lerpLonLat(a, b, 0)).toEqual(a);
    expect(lerpLonLat(a, b, 1)).toEqual(b);
  });

  it('t=0.5 为中点', () => {
    expect(lerpLonLat(P(116, 39), P(117, 40), 0.5)).toEqual(P(116.5, 39.5));
  });

  it('midpoint 等于 t=0.5 的插值', () => {
    const a = P(116, 39);
    const b = P(117, 40);
    expect(midpoint({ a, b })).toEqual(lerpLonLat(a, b, 0.5));
  });
});

describe('buildSegments —— 真实数据清洗规则', () => {
  it('丢弃退化段（间距 < 1m）', () => {
    const parts = [
      {
        road: '测试路',
        points: [P(116.4, 39.9), P(116.4, 39.9), P(116.41, 39.9)],
      },
    ];
    const segs = buildSegments(parts);
    // 第一个 0m 段应被丢弃
    expect(segs.length).toBeGreaterThan(0);
    for (const s of segs) {
      expect(s.dist).toBeGreaterThanOrEqual(MIN_SEGMENT_M);
    }
  });

  it('长段被细分（间距 > 300m）', () => {
    // 0.05° 经度 @39.9°N ≈ 4.27km，远超 MAX_SEGMENT_M
    const parts = [{ road: '长路段', points: [P(116.4, 39.9), P(116.45, 39.9)] }];
    const segs = buildSegments(parts, 100);
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) {
      expect(s.dist).toBeLessThanOrEqual(MAX_SEGMENT_M);
    }
  });

  it('短段保持原样（实测高德折线中位间距 96.6m，应不被改动）', () => {
    const parts = [{ road: '短路', points: [P(116.4, 39.9), P(116.401, 39.9)] }];
    const segs = buildSegments(parts);
    expect(segs).toHaveLength(1);
  });

  it('道路名透传到每个分段', () => {
    const parts = [
      { road: 'G2京沪高速', points: [P(116.4, 39.9), P(116.401, 39.9)] },
      { road: '', points: [P(116.401, 39.9), P(116.402, 39.9)] },
    ];
    const segs = buildSegments(parts);
    expect(segs[0]!.road).toBe('G2京沪高速');
    expect(segs[segs.length - 1]!.road).toBe('');
  });

  it('index 连续递增', () => {
    const parts = [{ road: 'r', points: [P(116.4, 39.9), P(116.401, 39.9), P(116.402, 39.9)] }];
    const segs = buildSegments(parts);
    segs.forEach((s, i) => expect(s.index).toBe(i));
  });

  it('每个分段都算出有效朝向（无 NaN）', () => {
    const parts = [{ road: 'r', points: [P(116.4, 39.9), P(116.41, 39.91), P(116.42, 39.9)] }];
    const segs = buildSegments(parts);
    for (const s of segs) {
      expect(Number.isFinite(s.heading)).toBe(true);
      expect(s.heading).toBeGreaterThanOrEqual(0);
      expect(s.heading).toBeLessThan(360);
    }
  });

  it('环形路线（起终点相同）不产生 NaN 或崩溃', () => {
    const parts = [
      {
        road: '环线',
        points: [P(116.4, 39.9), P(116.41, 39.91), P(116.42, 39.9), P(116.4, 39.9)],
      },
    ];
    const segs = buildSegments(parts);
    expect(segs.length).toBeGreaterThan(0);
    for (const s of segs) {
      expect(Number.isFinite(s.heading)).toBe(true);
      expect(Number.isFinite(s.dist)).toBe(true);
    }
  });

  it('总长度与原始折线一致（细分不改变里程）', () => {
    const parts = [{ road: 'r', points: [P(116.4, 39.9), P(116.45, 39.9)] }];
    const raw = haversineM(P(116.4, 39.9), P(116.45, 39.9));
    const segs = buildSegments(parts, 100);
    const total = segs.reduce((s, x) => s + x.dist, 0);
    expect(total).toBeCloseTo(raw, 3);
  });
});
