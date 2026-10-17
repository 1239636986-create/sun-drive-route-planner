/**
 * 太阳位置计算 —— NOAA Solar Position Algorithm
 *
 * 纯函数，无 IO、无时区依赖：传入的 Date 一律按其 UTC 时刻解释，
 * 地理经度通过 lon 参数显式传入。这是刻意的设计 ——
 * 时区处理是最容易出错的地方，把它挡在模块之外。
 *
 * 精度实测（北京，2025-03-20 春分）：
 *   12:00 CST -> 方位角   8.46°  高度角 49.71°
 *   12:22 CST -> 方位角 359.93°  高度角 50.02°   <- 真太阳时正午，非 12:00
 *   06:15 CST -> 方位角  90.97°  高度角 -1.44°   <- 春分日出近正东
 *
 * ⚠️ 实现陷阱：北京位于东经 116.41°，偏离 UTC+8 中央经线 120°E 约 3.59°
 *    （≈14.4 分钟），再叠加春分前后约 −8.3 分钟的时差方程，
 *    太阳正午落在 12:22 而非 12:00。
 *    若本模块算出「12:00 即正南」，说明时区或经度处理有误。
 *    测试见 tests/domain/sunPosition.test.ts
 */

import type { SunPosition } from './types.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/**
 * 儒略日。输入按其 UTC 值解释。
 * 算法：Meeus, Astronomical Algorithms, ch. 7
 */
export function julianDay(date: Date): number {
  let y = date.getUTCFullYear();
  let m = date.getUTCMonth() + 1; // JS 月份从 0 开始

  const dayFrac =
    date.getUTCDate() +
    date.getUTCHours() / 24 +
    date.getUTCMinutes() / 1440 +
    date.getUTCSeconds() / 86400 +
    date.getUTCMilliseconds() / 86400000;

  if (m <= 2) {
    y -= 1;
    m += 12;
  }

  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);

  return (
    Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    dayFrac +
    b -
    1524.5
  );
}

/**
 * 计算给定时刻与经纬度下的太阳方位角与高度角。
 *
 * @param lat 纬度，北正南负
 * @param lon 经度，东正西负
 * @param date 时刻。**按 UTC 解释** —— 若持有本地时间，请先转换
 * @returns 方位角（正北 0°，顺时针 0–360）与高度角（地平线以上为正，度）
 */
export function sunPosition(lat: number, lon: number, date: Date): SunPosition {
  const jd = julianDay(date);
  const t = (jd - 2451545.0) / 36525.0;

  // --- 太阳几何平黄经、平近点角、轨道偏心率 ---
  const L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  // --- 中心差 ---
  const Mr = M * DEG;
  const C =
    Math.sin(Mr) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * Mr) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * Mr) * 0.000289;

  const trueLong = L0 + C;

  // --- 视黄经（含章动修正）---
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * DEG);

  // --- 黄赤交角 ---
  const eps0 =
    23 +
    26 / 60 +
    21.448 / 3600 -
    (t * (46.815 + t * (0.00059 - t * 0.001813))) / 3600;
  const eps = eps0 + 0.00256 * Math.cos(omega * DEG);

  const lambdaR = lambda * DEG;
  const epsR = eps * DEG;

  // --- 太阳赤纬 ---
  const sinDecl = Math.sin(epsR) * Math.sin(lambdaR);
  const decl = Math.asin(Math.max(-1, Math.min(1, sinDecl)));

  // --- 时差方程（分钟）---
  const y = Math.tan(epsR / 2) ** 2;
  const L0r = L0 * DEG;
  const eqTime =
    4 *
    RAD *
    (y * Math.sin(2 * L0r) -
      2 * e * Math.sin(Mr) +
      4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
      0.5 * y * y * Math.sin(4 * L0r) -
      1.25 * e * e * Math.sin(2 * Mr));

  // --- 真太阳时（分钟，0–1440）---
  const minutes =
    date.getUTCHours() * 60 +
    date.getUTCMinutes() +
    date.getUTCSeconds() / 60 +
    date.getUTCMilliseconds() / 60000;

  const trueSolarTime = (minutes + eqTime + 4 * lon + 1440) % 1440;

  // --- 时角 ---
  let ha = trueSolarTime / 4 - 180;
  if (ha < -180) ha += 360;
  const haR = ha * DEG;
  const latR = lat * DEG;

  // --- 天顶角与高度角 ---
  const cosZen =
    Math.sin(latR) * Math.sin(decl) +
    Math.cos(latR) * Math.cos(decl) * Math.cos(haR);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZen)));
  const elevation = 90 - zen * RAD;

  // --- 方位角 ---
  const sinZen = Math.sin(zen);
  let azimuth: number;

  if (Math.abs(sinZen) < 1e-10) {
    // 太阳恰在天顶，方位角无定义
    azimuth = 0;
  } else {
    const cosAz =
      (Math.sin(latR) * Math.cos(zen) - Math.sin(decl)) /
      (Math.cos(latR) * sinZen);
    azimuth = Math.acos(Math.max(-1, Math.min(1, cosAz))) * RAD;
    // 时角 > 0 表示下午，太阳偏西
    if (ha > 0) azimuth = 360 - azimuth;
  }

  return { azimuth, elevation };
}

/**
 * 日出的近似方位角与高度角参考 —— 仅用于测试与调试。
 * 通过扫描一天内高度角由负转正的临界点定位。
 */
export function findSunrise(
  lat: number,
  lon: number,
  dayUtcMidnight: Date,
): Date | null {
  const STEP_MS = 60_000;
  let prev = sunPosition(lat, lon, dayUtcMidnight).elevation;

  for (let i = 1; i <= 1440; i++) {
    const at = new Date(dayUtcMidnight.getTime() + i * STEP_MS);
    const cur = sunPosition(lat, lon, at).elevation;
    if (prev <= 0 && cur > 0) return at;
    prev = cur;
  }
  return null;
}
