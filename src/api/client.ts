/**
 * 前端 API 客户端 —— 通过反向代理访问高德 REST 接口
 *
 * Q8 决策的落地：**客户端不持有任何密钥。**
 *
 *   ┌──────────┐   /amap-api/v3/direction/driving?origin=...
 *   │  浏览器   │ ─────────────────────────────────────────┐
 *   └──────────┘   无 key，无 jscode                        │
 *                                                            ▼
 *                                          ┌──────────────────────────────┐
 *                                          │ 反向代理（开发: Vite /       │
 *                                          │　生产: nginx / serverless）   │
 *                                          │ 注入 &key=AMAP_WEB_KEY        │
 *                                          └──────────────┬───────────────┘
 *                                                         ▼
 *                                              https://restapi.amap.com
 *
 * 实测（docs/q8-api-architecture-decision.md）：
 *   经此路径返回的数据与直连**完全一致**
 *   （distance=138536, steps=21, 17 个有 road, G2京沪高速 97776m）
 *   而浏览器侧零密钥。
 *
 * ⚠️ 不要在前端代码里写 key。若有人「为了方便」把 key 塞进这里，
 *    整个决策的意义就没了 —— 那等于把配额公开。
 */

import type { LonLat } from '@/domain/types.js';

/** 前端访问高德接口的统一前缀。由代理拦截并注入凭据 */
export const AMAP_API_PREFIX = '/amap-api';

/** 构造经代理的高德接口 URL */
export function amapUrl(path: string, params: Record<string, string>): string {
  const url = new URL(`${AMAP_API_PREFIX}${path}`, globalThis.location?.origin ?? 'http://localhost');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.pathname + url.search;
}

/**
 * 高德要求 `lon,lat` 顺序，经纬度小数点不超过 6 位。
 * 与 src/providers/amapProvider.ts 的 formatLonLat 保持一致。
 */
export function formatLonLatParam(p: LonLat): string {
  return `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`;
}

/** 探测代理是否就绪 —— UI 可在启动时调用，给出比白屏更好的错误提示 */
export async function probeProxy(): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  try {
    const res = await fetch(
      amapUrl('/v3/geocode/geo', { address: '北京', output: 'JSON' }),
    );
    if (!res.ok) return { ok: false, reason: `代理返回 HTTP ${res.status}` };

    const payload = (await res.json()) as {
      status?: string;
      info?: string;
      infocode?: string;
    };

    if (payload.status === '1') return { ok: true };

    if (payload.infocode === '10001') {
      return {
        ok: false,
        reason:
          '代理未注入有效凭据。请检查 .env 中的 AMAP_WEB_KEY，' +
          '以及 vite.config.ts 的 /amap-api 代理配置。',
      };
    }
    return {
      ok: false,
      reason: `高德返回错误：${payload.info ?? '?'}（infocode=${payload.infocode ?? '?'}）`,
    };
  } catch (err) {
    return {
      ok: false,
      reason: `无法连接代理：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
