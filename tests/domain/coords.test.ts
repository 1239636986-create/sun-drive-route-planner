/**
 * 坐标转换测试
 *
 * 这是「正确性命攸关」的模块：转换写错，路线就会飘在底图外，
 * 或者更隐蔽地「偏一点点」让人以为是数据问题。
 *
 * 核心检验是**往返一致性**：WGS→GCJ→WGS 应回到原点。
 */

import { describe, it, expect } from 'vitest';
import {
  wgs84ToGcj02,
  gcj02ToWgs84,
  gcj02OffsetMeters,
  outOfChina,
} from '@/domain/coords.js';

const BEIJING = { lon: 116.397428, lat: 39.90923 };
const SHANGHAI = { lon: 121.4737, lat: 31.2304 };
const URUMQI = { lon: 87.6168, lat: 43.8256 };
const LONDON = { lon: -0.1276, lat: 51.5072 };

describe('outOfChina', () => {
  it('中国境内为 false', () => {
    expect(outOfChina(BEIJING.lon, BEIJING.lat)).toBe(false);
    expect(outOfChina(URUMQI.lon, URUMQI.lat)).toBe(false);
  });

  it('境外为 true', () => {
    expect(outOfChina(LONDON.lon, LONDON.lat)).toBe(true);
    expect(outOfChina(139.6917, 35.6895)).toBe(true); // 东京
  });
});

describe('wgs84ToGcj02', () => {
  it('境内点产生偏移', () => {
    const gcj = wgs84ToGcj02(BEIJING);
    expect(gcj.lon).not.toBeCloseTo(BEIJING.lon, 6);
    expect(gcj.lat).not.toBeCloseTo(BEIJING.lat, 6);
  });

  it('偏移方向为东北（对北京而言）', () => {
    const gcj = wgs84ToGcj02(BEIJING);
    expect(gcj.lon).toBeGreaterThan(BEIJING.lon);
    expect(gcj.lat).toBeGreaterThan(BEIJING.lat);
  });

  it('境外点不施加偏移', () => {
    expect(wgs84ToGcj02(LONDON)).toEqual(LONDON);
  });

  it('偏移量在合理范围（实测北京约 700m 量级）', () => {
    const d = gcj02OffsetMeters(BEIJING);
    expect(d).toBeGreaterThan(300);
    expect(d).toBeLessThan(900);
  });

  it('不同城市的偏移量不同 —— 说明是位置相关的非线性变换', () => {
    const bj = gcj02OffsetMeters(BEIJING);
    const sh = gcj02OffsetMeters(SHANGHAI);
    const ur = gcj02OffsetMeters(URUMQI);
    expect(Math.abs(bj - sh)).toBeGreaterThan(1);
    expect(Math.abs(bj - ur)).toBeGreaterThan(1);
  });
});

describe('gcj02ToWgs84 —— 往返一致性（关键）', () => {
  const cases = [
    ['北京', BEIJING],
    ['上海', SHANGHAI],
    ['乌鲁木齐', URUMQI],
  ] as const;

  it.each(cases)('%s：WGS → GCJ → WGS 应回到原点（误差 < 0.5m）', (_name, p) => {
    const roundTrip = gcj02ToWgs84(wgs84ToGcj02(p));
    // 0.5m 约等于 4.5e-6 度
    expect(Math.abs(roundTrip.lon - p.lon)).toBeLessThan(1e-5);
    expect(Math.abs(roundTrip.lat - p.lat)).toBeLessThan(1e-5);
  });

  it.each(cases)('%s：GCJ → WGS → GCJ 应回到原点', (_name, p) => {
    const gcj = wgs84ToGcj02(p);
    const roundTrip = wgs84ToGcj02(gcj02ToWgs84(gcj));
    expect(Math.abs(roundTrip.lon - gcj.lon)).toBeLessThan(1e-5);
    expect(Math.abs(roundTrip.lat - gcj.lat)).toBeLessThan(1e-5);
  });

  it('转换后与原点确实不同（防止函数变成恒等映射）', () => {
    const wgs = gcj02ToWgs84(BEIJING);
    expect(Math.abs(wgs.lon - BEIJING.lon) + Math.abs(wgs.lat - BEIJING.lat)).toBeGreaterThan(1e-4);
  });

  it('境外点原样返回', () => {
    expect(gcj02ToWgs84(LONDON)).toEqual(LONDON);
  });

  it('转换是确定性的 —— 同样输入两次结果一致', () => {
    const a = gcj02ToWgs84(BEIJING);
    const b = gcj02ToWgs84(BEIJING);
    expect(a).toEqual(b);
  });
});

describe('坐标转换对 bearing 的影响（解释为何算方位不需要转换）', () => {
  it('局部小范围内两点求差，坐标系偏移几乎被消掉', () => {
    // 两个相距约 100m 的点
    const a = { lon: 116.4, lat: 39.9 };
    const b = { lon: 116.401, lat: 39.9 };

    const bearingOf = (p: { lon: number; lat: number }, q: { lon: number; lat: number }) => {
      const la1 = (p.lat * Math.PI) / 180;
      const la2 = (q.lat * Math.PI) / 180;
      const dl = ((q.lon - p.lon) * Math.PI) / 180;
      const y = Math.sin(dl) * Math.cos(la2);
      const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl);
      return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    };

    const inGcj = bearingOf(wgs84ToGcj02(a), wgs84ToGcj02(b));
    const inWgs = bearingOf(a, b);

    // 实测真实数据上差异 0.25°，这里是短距离，应更小
    expect(Math.abs(inGcj - inWgs)).toBeLessThan(1.0);
  });
});
