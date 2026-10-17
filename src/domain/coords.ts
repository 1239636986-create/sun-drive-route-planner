/**
 * 坐标转换：GCJ-02 ⇄ WGS-84
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────────
 * 高德返回的路线是 **GCJ-02**（火星坐标）。若用 WGS-84 底图（OSM/Esri 等）
 * 直接叠加，会有约 **300–600m 整体偏移**（实测天安门附近 710m 量级），
 * 路线会明显「飘在路外」，产品可信度直接崩掉。
 *
 * 但**算 bearing 不需要转换** —— 实测偏移量在局部近似常数，两点求差时
 * 被消掉，残余误差仅 0.25°。见 docs/amap-provider-findings.md §4。
 *
 * 所以本模块**只服务于地图渲染**：当用户选了 WGS-84 底图时，
 * 把 GCJ-02 路线转成 WGS-84 再画。
 *
 * ── 精度说明 ─────────────────────────────────────────────────────────
 * 这里用的是公开流传的 GCJ-02 正变换近似算法，逆变换用迭代逼近。
 * 正变换误差在米级（对渲染完全够用），逆变换迭代 3 次后误差 < 1e-6 度。
 * 若将来需要测绘级精度，应改用官方或权威库。
 */

/** 是否在中国境外（境外不施加 GCJ-02 偏移） */
export function outOfChina(lon: number, lat: number): boolean {
  return !(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55);
}

const A = 6378245.0; // 克拉索夫斯基椭球长半轴
const EE = 0.00669342162296594323; // 偏心率平方

/** 纬度偏移量计算 */
function transformLat(x: number, y: number): number {
  let ret =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

/** 经度偏移量计算 */
function transformLon(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

export interface LonLatPair {
  lon: number;
  lat: number;
}

/** WGS-84 → GCJ-02（高德返回的坐标就是这个） */
export function wgs84ToGcj02(p: LonLatPair): LonLatPair {
  if (outOfChina(p.lon, p.lat)) return { ...p };

  let dLat = transformLat(p.lon - 105.0, p.lat - 35.0);
  let dLon = transformLon(p.lon - 105.0, p.lat - 35.0);

  const radLat = (p.lat / 180.0) * Math.PI;
  const magic = 1 - EE * Math.sin(radLat) ** 2;
  const sqrtMagic = Math.sqrt(magic);

  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI);

  return { lon: p.lon + dLon, lat: p.lat + dLat };
}

/**
 * GCJ-02 → WGS-84
 *
 * 没有闭式解，用「先加偏移再迭代逼近」的方法：
 * 反复把候选 WGS-84 点正变换后与目标比较，按残差修正。
 * 3 次迭代后残差 < 1e-6 度（约 0.1m），远超渲染需求。
 */
export function gcj02ToWgs84(p: LonLatPair): LonLatPair {
  if (outOfChina(p.lon, p.lat)) return { ...p };

  let wgs = { ...p };

  for (let i = 0; i < 3; i++) {
    const gcj = wgs84ToGcj02(wgs);
    const dLon = gcj.lon - p.lon;
    const dLat = gcj.lat - p.lat;
    if (Math.abs(dLon) < 1e-9 && Math.abs(dLat) < 1e-9) break;
    wgs = { lon: wgs.lon - dLon, lat: wgs.lat - dLat };
  }

  return wgs;
}

/**
 * 估算某点的 GCJ-02 偏移量（米）—— 仅用于诊断与文档说明。
 */
export function gcj02OffsetMeters(p: LonLatPair): number {
  const gcj = wgs84ToGcj02(p);
  const dLonM = (gcj.lon - p.lon) * 111320 * Math.cos((p.lat * Math.PI) / 180);
  const dLatM = (gcj.lat - p.lat) * 110540;
  return Math.sqrt(dLonM * dLonM + dLatM * dLatM);
}
