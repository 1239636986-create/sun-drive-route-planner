/**
 * 几何工具 —— 全部为纯函数，无 IO、无时区依赖
 *
 * 坐标系说明（重要，见 docs/amap-provider-findings.md §4）：
 *   高德返回 GCJ-02 坐标。本文件的 bearing 计算**不需要**做 GCJ-02 → WGS-84 转换，
 *   因为实测偏移量在局部近似为常数，两点求差时被消掉，残余误差仅 0.25°，
 *   远小于本产品 5° 的分级粒度。
 *   但**距离与地图渲染**必须与坐标系一致 —— 距离请直接用 Provider 返回的
 *   route.distance，不要用本文件的 haversine 累加。
 */

import type { LonLat, RouteSegment } from './types.js';

/** 地球平均半径（米），IUGG 推荐值 */
const EARTH_RADIUS_M = 6371008.8;

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** 把角度归一化到 [0, 360) */
export function normalize360(deg: number): number {
  const r = deg % 360;
  return r < 0 ? r + 360 : r;
}

/** 把角度归一化到 (-180, 180]，用于求两个方向的最小夹角 */
export function normalize180(deg: number): number {
  let r = normalize360(deg);
  if (r > 180) r -= 360;
  return r;
}

/**
 * 大圆方位角（initial bearing）。
 * 从 a 点出发沿大圆前往 b 点，起点的前进方向。
 * 正北 0°，顺时针递增。
 *
 * 边界：a 与 b 重合时结果无意义（返回 0），调用方须先过滤退化段。
 */
export function bearingDeg(a: LonLat, b: LonLat): number {
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const dLon = (b.lon - a.lon) * DEG;

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

  return normalize360(Math.atan2(y, x) * RAD);
}

/**
 * 两点间大圆距离（米）。
 *
 * ⚠️ 用途限制：仅用于**同一坐标系内**的相对距离与分段粒度判断。
 * 跨坐标系（GCJ-02 vs WGS-84）时位置本身有约 710m 偏移（实测），
 * 因此路线的**总距离必须用 Provider 返回值**，不要用本函数累加。
 */
export function haversineM(a: LonLat, b: LonLat): number {
  const lat1 = a.lat * DEG;
  const lat2 = b.lat * DEG;
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 在两点间按比例 t ∈ [0,1] 做线性插值 */
export function lerpLonLat(a: LonLat, b: LonLat, t: number): LonLat {
  return {
    lon: a.lon + (b.lon - a.lon) * t,
    lat: a.lat + (b.lat - a.lat) * t,
  };
}

/** 分段中点 —— 用于取该段代表位置计算太阳位置 */
export function midpoint(s: { a: LonLat; b: LonLat }): LonLat {
  return { lon: (s.a.lon + s.b.lon) / 2, lat: (s.a.lat + s.b.lat) / 2 };
}

/**
 * 排序后取分位数（线性插值）。
 * 用于把「一段路上的多个时间采样」聚合成单一风险值。
 *
 * @param values 待聚合的值（会被复制后排序，不修改入参）
 * @param p 分位点，0–1
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((x, y) => x - y);
  if (s.length === 1) return s[0]!;

  const k = (s.length - 1) * p;
  const lo = Math.floor(k);
  const hi = Math.ceil(k);
  const vLo = s[lo]!;
  if (lo === hi) return vLo;

  return vLo + (s[hi]! - vLo) * (k - lo);
}

/**
 * 把 Provider 返回的原始折线切分为统一粒度的分段（PRD F2）。
 *
 * 两个必要的清洗规则，来自真实数据实测（见 amap-provider-findings.md §3.3）：
 *   1. 丢弃间距 < MIN_SEGMENT_M 的退化段 —— 实测存在 0.0m 段，
 *      会让 bearing 计算抖动甚至产生 NaN
 *   2. 对超过 MAX_SEGMENT_M 的长段做插值细分 —— 实测最大间距 1242m，
 *      该段用一个朝向值代表性不足
 *
 * 注：实测高德折线中位间距 96.6m，已接近目标粒度，
 * 因此本函数通常只做轻度调整，不会大面积重采样。
 */
export const MIN_SEGMENT_M = 1.0;
export const MAX_SEGMENT_M = 300.0;
export const DEFAULT_SAMPLE_M = 100.0;

export interface RawPolylinePart {
  points: LonLat[];
  road: string;
}

export function buildSegments(
  parts: readonly RawPolylinePart[],
  sampleM: number = DEFAULT_SAMPLE_M,
): RouteSegment[] {
  const segments: RouteSegment[] = [];
  let index = 0;

  for (const part of parts) {
    for (let i = 0; i < part.points.length - 1; i++) {
      const a = part.points[i]!;
      const b = part.points[i + 1]!;
      const d = haversineM(a, b);

      // 规则 1：丢弃退化段
      if (d < MIN_SEGMENT_M) continue;

      // 规则 2：长段细分，其余保持原样（实测折线粒度已接近目标）
      const n = d > MAX_SEGMENT_M ? Math.max(2, Math.round(d / sampleM)) : 1;

      for (let k = 0; k < n; k++) {
        const pa = lerpLonLat(a, b, k / n);
        const pb = lerpLonLat(a, b, (k + 1) / n);
        segments.push({
          index: index++,
          a: pa,
          b: pb,
          heading: bearingDeg(pa, pb),
          dist: d / n,
          road: part.road,
        });
      }
    }
  }

  return segments;
}
