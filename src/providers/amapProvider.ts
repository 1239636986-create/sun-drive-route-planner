/**
 * 高德 Web 服务 Provider
 *
 * 全部行为依据实测结论（docs/amap-provider-findings.md），关键决策：
 *
 *   ✅ 用 v3 接口，不用 v5
 *      v5 的 step 不带 road 字段，而 road 是生成清单文案的必需品
 *   ✅ bearing 从 polyline 自算（大圆方位角）
 *      orientation 只有 8 档（45° 分辨率），且每 step 仅一个值 ——
 *      实测 G2京沪高速 有一段 97,776m 只配一个「东南」。
 *      用它算离轴角的量化误差 ±22.5°，比信号本身还大。
 *   ❌ 不用 orientation 当校准基准
 *      它是导航播报语义下的「道路走向描述」，与瞬时航向语义不同
 *      （实测两者约 30% 不一致）
 *   ✅ 距离/时长用接口返回的 distance / duration
 *      不自行从坐标累加，避免坐标系引入误差
 *   ✅ 全链路保持 GCJ-02，不做坐标转换
 *      实测 GCJ-02 偏移对 bearing 影响仅 0.25°（求差时常数项被消掉），
 *      而高德底图本身就是 GCJ-02 —— 混用才会飘
 *
 * ⚠️ Key 位置：本 Provider 应运行在**服务端或开发代理**之后。
 *    Web服务 Key 明文放前端等于把配额送人。见 PRD Q8 与 docs/amap-key-application-checklist.md §4
 */

import { buildSegments, type RawPolylinePart } from '../domain/geo.js';
import type {
  GetRouteOptions,
  LonLat,
  Route,
  RouteProvider,
  RouteSegment,
} from '../domain/types.js';

/** 高德驾车途径点上限 */
export const AMAP_MAX_WAYPOINTS = 16;

const BASE_URL = 'https://restapi.amap.com';

/** 高德 v3 驾车路径规划响应的最小结构（只声明我们用到的字段） */
interface AmapStep {
  instruction?: string;
  orientation?: string;
  road?: string | null;
  distance?: string;
  duration?: string;
  polyline?: string;
}

interface AmapPath {
  distance?: string;
  duration?: string;
  steps?: AmapStep[];
}

interface AmapDirectionResponse {
  status?: string;
  info?: string;
  infocode?: string;
  route?: {
    paths?: AmapPath[];
  };
}

interface AmapGeocode {
  location?: string;
  formatted_address?: string;
}

interface AmapGeocodeResponse {
  status?: string;
  info?: string;
  infocode?: string;
  geocodes?: AmapGeocode[];
}

/** 高德错误码的人话解释 —— 便于快速定位是账号问题还是 Key 类型问题 */
const INFOCODE_HINTS: Record<string, string> = {
  '10001': 'Key 不正确或已失效',
  '10003': '日调用量已达上限',
  '10009': 'Key 与服务类型不匹配（极可能用 JS API Key 调了 Web服务接口）',
  '10012': '权限不足或引擎响应超时',
  '10044': '该 Key 配额已用完',
};

export class AmapError extends Error {
  constructor(
    message: string,
    readonly info?: string,
    readonly infocode?: string,
  ) {
    super(message);
    this.name = 'AmapError';
  }
}

export interface AmapProviderOptions {
  /**
   * Web服务 类型的 Key。
   *
   * **在 Q8 选定的代理架构下，前端应当省略此参数** ——
   * 凭据由反向代理注入，客户端不持有任何密钥。
   * 只有服务端直连高德时才需要传。
   */
  apiKey?: string;
  /**
   * 请求基地址。默认直连高德。
   * 若要经开发代理，传 '/amap-api'（见 vite.config.ts）
   */
  baseUrl?: string;
  /** 路线策略，默认 0（速度优先） */
  strategy?: number;
  /** 自定义 fetch，便于测试注入 */
  fetchImpl?: typeof fetch;
}

/**
 * 解析高德 `lon,lat;lon,lat;...` 格式的折线串。
 *
 * 实测格式：分号分隔，每个点 `经度,纬度`，小数点不超过 6 位。
 */
export function parsePolyline(polyline: string): LonLat[] {
  const out: LonLat[] = [];
  for (const pair of polyline.split(';')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const [lonStr, latStr] = trimmed.split(',');
    if (lonStr === undefined || latStr === undefined) continue;
    const lon = Number.parseFloat(lonStr);
    const lat = Number.parseFloat(latStr);
    if (Number.isFinite(lon) && Number.isFinite(lat)) out.push({ lon, lat });
  }
  return out;
}

/**
 * 把高德的 steps 转成 providers 无关的折线分组。
 * 每个 step 的 polyline 与其 road 名绑定 —— 这是清单文案能按路名聚合的前提。
 */
export function stepsToPolylineParts(steps: readonly AmapStep[]): RawPolylinePart[] {
  const parts: RawPolylinePart[] = [];
  for (const step of steps) {
    if (!step.polyline) continue;
    const points = parsePolyline(step.polyline);
    if (points.length < 2) continue;
    parts.push({
      points,
      // road 可能为 null 或空串，统一成空串，由 UI 层做 fallback 文案
      road: (step.road ?? '').trim(),
    });
  }
  return parts;
}

function ensureOk(
  payload: { status?: string; info?: string; infocode?: string },
  what: string,
): void {
  if (payload.status === '1') return;

  const code = payload.infocode ?? '';
  const hint = INFOCODE_HINTS[code] ?? payload.info ?? '未知错误';
  throw new AmapError(
    `高德${what}失败：${hint}（info=${payload.info ?? '?'}, infocode=${code || '?'}）`,
    payload.info,
    code,
  );
}

export class AmapProvider implements RouteProvider {
  readonly name = 'amap-web' as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly strategy: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AmapProviderOptions) {
    this.apiKey = options.apiKey ?? '';
    this.baseUrl = options.baseUrl ?? BASE_URL;
    this.strategy = options.strategy ?? 0;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * 解析请求 URL。
   *
   * baseUrl 可能是相对路径（如 '/amap-api'，代理模式）或绝对地址
   * （如 'https://restapi.amap.com'，服务端直连）。
   * `new URL(path, relativeBase)` 会抛 Invalid URL，故需要一个 origin 兜底。
   */
  private resolveUrl(path: string): URL {
    const isAbsolute = /^https?:\/\//i.test(this.baseUrl);
    const origin =
      globalThis.location?.origin ??
      (isAbsolute ? undefined : 'http://localhost');
    return new URL(
      `${this.baseUrl.replace(/\/$/, '')}${path}`,
      origin,
    );
  }

  /** 是否需要在请求里附带 key —— 代理模式不需要（由代理注入） */
  private needsOwnKey(): boolean {
    return this.apiKey !== '' && /^https?:\/\//i.test(this.baseUrl);
  }

  /**
   * 获取驾车路线。
   *
   * 必须带 extensions=all，否则拿不到完整的 steps 与 tmcs。
   * 途径点经 `waypoints` 传入（`lon,lat;lon,lat`），最多 16 个。
   */
  async getRoute(
    origin: LonLat,
    destination: LonLat,
    options?: GetRouteOptions,
  ): Promise<Route> {
    const url = this.resolveUrl('/v3/direction/driving');
    if (this.needsOwnKey()) url.searchParams.set('key', this.apiKey);
    // 高德要求 `lon,lat` 顺序，且小数点不超过 6 位
    url.searchParams.set('origin', formatLonLat(origin));
    url.searchParams.set('destination', formatLonLat(destination));
    const waypoints = (options?.waypoints ?? []).slice(0, AMAP_MAX_WAYPOINTS);
    if (waypoints.length > 0) {
      url.searchParams.set('waypoints', waypoints.map(formatLonLat).join(';'));
    }
    url.searchParams.set('extensions', 'all');
    url.searchParams.set('strategy', String(this.strategy));
    url.searchParams.set('output', 'JSON');

    const res = await this.fetchImpl(url.toString());
    if (!res.ok) {
      throw new AmapError(`高德驾车路径规划 HTTP ${res.status}`);
    }

    const payload = (await res.json()) as AmapDirectionResponse;
    ensureOk(payload, '驾车路径规划');

    const path = payload.route?.paths?.[0];
    if (!path) {
      throw new AmapError('高德未返回任何路径');
    }

    const steps = path.steps ?? [];
    const parts = stepsToPolylineParts(steps);
    if (parts.length === 0) {
      throw new AmapError('高德返回的路径不含有效折线');
    }

    const segments: RouteSegment[] = buildSegments(parts);

    // 距离与时长用返回值，不自行累加（避免 GCJ-02 引入的误差）
    const distance = Number.parseFloat(path.distance ?? '0');
    const durationSec = Number.parseFloat(path.duration ?? '0');

    return {
      segments,
      distance: Number.isFinite(distance) ? distance : 0,
      duration: Number.isFinite(durationSec) ? durationSec * 1000 : 0,
      source: 'amap-web',
      // 高德国内路网数据质量高；保留字段以便将来接入 OSM 时降级
      confidence: 'high',
    };
  }

  /** 地理编码：地址文本 -> 坐标。返回 GCJ-02 坐标 */
  async geocode(address: string): Promise<{ location: LonLat; formatted: string } | null> {
    const url = this.resolveUrl('/v3/geocode/geo');
    if (this.needsOwnKey()) url.searchParams.set('key', this.apiKey);
    url.searchParams.set('address', address);
    url.searchParams.set('output', 'JSON');

    const res = await this.fetchImpl(url.toString());
    if (!res.ok) throw new AmapError(`高德地理编码 HTTP ${res.status}`);

    const payload = (await res.json()) as AmapGeocodeResponse;
    ensureOk(payload, '地理编码');

    const first = payload.geocodes?.[0];
    if (!first?.location) return null;

    const [lonStr, latStr] = first.location.split(',');
    const lon = Number.parseFloat(lonStr ?? '');
    const lat = Number.parseFloat(latStr ?? '');
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

    return {
      location: { lon, lat },
      formatted: first.formatted_address ?? address,
    };
  }
}

/** 高德要求 `lon,lat`，且经纬度小数点不超过 6 位 */
export function formatLonLat(p: LonLat): string {
  return `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`;
}

/**
 * 从一份已保存的高德响应构造 Route —— 用于测试与离线开发，
 * 避免单测依赖网络与配额。
 */
export function routeFromAmapPayload(payload: unknown): Route {
  const typed = payload as AmapDirectionResponse;
  ensureOk(typed, '驾车路径规划（离线载荷）');

  const path = typed.route?.paths?.[0];
  if (!path) throw new AmapError('载荷不含任何路径');

  const parts = stepsToPolylineParts(path.steps ?? []);
  if (parts.length === 0) throw new AmapError('载荷不含有效折线');

  const distance = Number.parseFloat(path.distance ?? '0');
  const durationSec = Number.parseFloat(path.duration ?? '0');

  return {
    segments: buildSegments(parts),
    distance: Number.isFinite(distance) ? distance : 0,
    duration: Number.isFinite(durationSec) ? durationSec * 1000 : 0,
    source: 'fixture',
    confidence: 'high',
  };
}
