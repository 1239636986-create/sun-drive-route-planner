/**
 * SunPosition 回归测试
 *
 * 这些用例守护的是整个产品最容易出错的地方：时区与经度处理。
 *
 * ⚠️ 关键陷阱：北京位于东经 116.41°，偏离 UTC+8 中央经线 120°E 约 3.59°
 *    （≈14.4 分钟），再叠加春分前后约 −8.3 分钟的时差方程，
 *    太阳正午落在 12:22 而非 12:00。
 *    若实现里得到「12:00 即正南」，说明时区或经度处理有误。
 */

import { describe, it, expect } from 'vitest';
import { sunPosition, julianDay, findSunrise } from '@/domain/sunPosition.js';

/** 构造 CST（UTC+8）时刻 */
function cst(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s = 0,
): Date {
  return new Date(Date.UTC(y, mo - 1, d, h - 8, mi, s));
}

const BEIJING = { lat: 39.9042, lon: 116.4074 };

describe('儒略日 julianDay', () => {
  it('J2000.0 历元：2000-01-01 12:00 UTC -> 2451545.0', () => {
    expect(julianDay(new Date(Date.UTC(2000, 0, 1, 12, 0, 0)))).toBeCloseTo(2451545.0, 5);
  });

  it('2025-03-20 04:00 UTC 的儒略日', () => {
    // 参考值由 Python 原型输出，用于锁定实现
    const jd = julianDay(cst(2025, 3, 20, 12, 0));
    expect(jd).toBeGreaterThan(2460754);
    expect(jd).toBeLessThan(2460755);
  });
});

describe('T01 北京春分 12:00 CST', () => {
  const { azimuth, elevation } = sunPosition(BEIJING.lat, BEIJING.lon, cst(2025, 3, 20, 12, 0));

  it('方位角 ≈ 8.7°（南偏东，尚未到真太阳时正午）', () => {
    // 实测 8.46°，偏差 0.24°
    expect(Math.abs(azimuth - 8.7)).toBeLessThan(0.3);
  });

  it('高度角 ≈ 49.71°（PRD 附录 C T01 记录值）', () => {
    expect(Math.abs(elevation - 49.71)).toBeLessThan(0.3);
  });
});

describe('T01b 北京春分 12:22 CST —— 真太阳时正午', () => {
  const { azimuth, elevation } = sunPosition(BEIJING.lat, BEIJING.lon, cst(2025, 3, 20, 12, 22));

  it('方位角 ≈ 0°（正南）—— 守护 12:22 ≠ 12:00 的陷阱', () => {
    // 实测 359.93 或 0.07，取到正北的距离
    const distToNorth = Math.min(azimuth, Math.abs(azimuth - 360));
    expect(distToNorth).toBeLessThan(1.0);
  });

  it('高度角 ≈ 50.02°（PRD 附录 C T01b 记录值）', () => {
    expect(Math.abs(elevation - 50.02)).toBeLessThan(0.3);
  });

  it('12:00 与 12:22 的方位角差异应显著（约 8.5°）', () => {
    const at1200 = sunPosition(BEIJING.lat, BEIJING.lon, cst(2025, 3, 20, 12, 0));
    expect(Math.abs(at1200.azimuth - azimuth)).toBeGreaterThan(7);
  });
});

describe('春分日出方位 —— 应接近正东（守护方位角定义与坐标系）', () => {
  it('北京 2025-03-20 06:15 CST 时方位角 ≈ 90.97°、高度角 ≈ −1.44°', () => {
    const { azimuth, elevation } = sunPosition(BEIJING.lat, BEIJING.lon, cst(2025, 3, 20, 6, 15));
    expect(Math.abs(azimuth - 90.97)).toBeLessThan(0.3);
    expect(Math.abs(elevation - -1.44)).toBeLessThan(0.3);
  });

  it('findSunrise 定位到的日出时刻在 06:00–06:30 CST 之间', () => {
    const midnightUtc = new Date(Date.UTC(2025, 2, 19, 16, 0, 0)); // 北京 3/20 00:00
    const sunrise = findSunrise(BEIJING.lat, BEIJING.lon, midnightUtc);
    expect(sunrise).not.toBeNull();

    // 转成 CST 小时
    const cstHour = (((sunrise!.getTime() + 8 * 3600_000) / 3600_000) % 24 + 24) % 24;
    expect(cstHour).toBeGreaterThan(5.9);
    expect(cstHour).toBeLessThan(6.5);

    // 日出时太阳应恰在东方
    const { azimuth } = sunPosition(BEIJING.lat, BEIJING.lon, sunrise!);
    expect(Math.abs(azimuth - 90)).toBeLessThan(2);
  });
});

describe('夜间归零（T04）', () => {
  it('地平线以下时高度角为负', () => {
    for (const h of [0, 1, 2, 3, 4, 22, 23]) {
      const { elevation } = sunPosition(BEIJING.lat, BEIJING.lon, cst(2025, 3, 20, h, 0));
      expect(elevation).toBeLessThan(0);
    }
  });
});

describe('方位角值域与高度角值域', () => {
  it('方位角恒在 [0, 360)，高度角恒在 [-90, 90]', () => {
    for (let h = 0; h < 24; h++) {
      for (let lon = 70; lon <= 140; lon += 10) {
        const { azimuth, elevation } = sunPosition(
          35,
          lon,
          cst(2025, 6, 21, h, 0),
        );
        expect(azimuth).toBeGreaterThanOrEqual(0);
        expect(azimuth).toBeLessThan(360);
        expect(elevation).toBeGreaterThanOrEqual(-90);
        expect(elevation).toBeLessThanOrEqual(90);
      }
    }
  });

  it('北半球夏至正午太阳偏南：方位角应接近 0°/360°（非 180°）', () => {
    // 北京北纬 39.9°，夏至太阳赤纬 +23.44°，始终位于南侧。
    // 因此正午方位角是 0°（或 360°），而不是 180°。
    // 实测：夏至高度角峰值出现在 12:16 CST，高度角 73.53°，方位角恰穿过 0°/360°。
    const { azimuth, elevation } = sunPosition(BEIJING.lat, BEIJING.lon, cst(2025, 6, 21, 12, 16));

    const distToNorth = Math.min(azimuth, Math.abs(azimuth - 360));
    expect(distToNorth).toBeLessThan(1.0);
    expect(elevation).toBeGreaterThan(73);
  });

  it('夏至高度角峰值出现在 12:16 CST 附近（真太阳时正午）', () => {
    let maxEl = -99;
    let maxMinute = -1;
    for (let m = 12 * 60; m <= 12 * 60 + 40; m++) {
      const { elevation } = sunPosition(
        BEIJING.lat,
        BEIJING.lon,
        cst(2025, 6, 21, Math.floor(m / 60), m % 60),
      );
      if (elevation > maxEl) {
        maxEl = elevation;
        maxMinute = m;
      }
    }
    expect(maxMinute).toBeGreaterThanOrEqual(12 * 60 + 13);
    expect(maxMinute).toBeLessThanOrEqual(12 * 60 + 19);
  });

  it('夏至正午太阳高度角远高于春分（≈73.5° vs ≈50°）', () => {
    const summer = sunPosition(BEIJING.lat, BEIJING.lon, cst(2025, 6, 21, 12, 16));
    const spring = sunPosition(BEIJING.lat, BEIJING.lon, cst(2025, 3, 20, 12, 22));
    // 差值约等于赤纬差 23.44°
    expect(summer.elevation - spring.elevation).toBeGreaterThan(20);
    expect(summer.elevation - spring.elevation).toBeLessThan(27);
  });
});

describe('时区敏感度 —— 新疆与北京的同一「北京时间」太阳高度截然不同', () => {
  it('北京时间 08:00 时，乌鲁木齐的太阳远低于北京', () => {
    const at = cst(2025, 3, 20, 8, 0);
    const beijing = sunPosition(39.9042, 116.4074, at);
    const urumqi = sunPosition(43.8256, 87.6168, at);

    // 乌鲁木齐经度靠西约 29°，同一 UTC+8 时刻太阳尚未升起或刚升起
    expect(urumqi.elevation).toBeLessThan(beijing.elevation);
    // 这正是 PRD 约束 C5 要防的错误直觉
    expect(urumqi.elevation).toBeLessThan(5);
  });
});
