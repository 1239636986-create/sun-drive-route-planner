/**
 * AmapProvider 测试
 *
 * 用**真实高德响应**做 fixture（tests/fixtures/route_bj_tj.json，天安门→天津站），
 * 不依赖网络与配额。所有断言对应 docs/amap-provider-findings.md 的实测结论。
 *
 * 关键守护点：
 *   1. bearing 来自 polyline，不来自 orientation
 *   2. road 字段可能缺失（只在有名字时存在）—— 必须能兜住
 *   3. 距离/时长用接口返回值，不自行累加
 *   4. 退化段（0m）被丢弃，长段被细分
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  AmapProvider,
  AmapError,
  parsePolyline,
  stepsToPolylineParts,
  routeFromAmapPayload,
  formatLonLat,
} from '@/providers/amapProvider.js';
import { bearingDeg } from '@/domain/geo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/route_bj_tj.json'), 'utf-8'),
) as Record<string, unknown>;

describe('parsePolyline —— 高德折线串解析', () => {
  it('解析 lon,lat;lon,lat 格式', () => {
    const pts = parsePolyline('116.397437,39.90923;116.397383,39.910373');
    expect(pts).toEqual([
      { lon: 116.397437, lat: 39.90923 },
      { lon: 116.397383, lat: 39.910373 },
    ]);
  });

  it('跳过空片段与非法坐标', () => {
    const pts = parsePolyline('116.4,39.9;;abc,def;116.41,39.91;');
    expect(pts).toEqual([
      { lon: 116.4, lat: 39.9 },
      { lon: 116.41, lat: 39.91 },
    ]);
  });

  it('空串返回空数组', () => {
    expect(parsePolyline('')).toEqual([]);
  });

  it('解析真实 fixture 的首个 step 折线', () => {
    const path = (fixture as any).route.paths[0];
    const pts = parsePolyline(path.steps[0].polyline);
    expect(pts.length).toBeGreaterThan(2);
    // 天安门附近
    expect(pts[0].lon).toBeCloseTo(116.3974, 3);
    expect(pts[0].lat).toBeCloseTo(39.9092, 3);
  });
});

describe('formatLonLat —— 高德要求 lon,lat 且 6 位小数', () => {
  it('输出 6 位小数', () => {
    expect(formatLonLat({ lon: 116.397428, lat: 39.90923 })).toBe('116.397428,39.909230');
  });

  it('整数坐标也补齐 6 位', () => {
    expect(formatLonLat({ lon: 116, lat: 39 })).toBe('116.000000,39.000000');
  });
});

describe('stepsToPolylineParts —— road 字段的缺失处理', () => {
  it('road 存在时透传', () => {
    const parts = stepsToPolylineParts([
      { road: '东华门路', polyline: '116.40,39.90;116.401,39.901' },
    ]);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.road).toBe('东华门路');
  });

  it('road 为 undefined / null / 空串时统一成空字符串', () => {
    const pl = '116.40,39.90;116.401,39.901';
    const parts = stepsToPolylineParts([
      { polyline: pl },                    // 键完全缺失（真实数据中就是这样）
      { road: null, polyline: pl },
      { road: '   ', polyline: pl },
    ]);
    expect(parts).toHaveLength(3);
    for (const p of parts) expect(p.road).toBe('');
  });

  it('跳过没有折线或折线不足两点的 step', () => {
    const parts = stepsToPolylineParts([
      { road: 'A' },
      { road: 'B', polyline: '' },
      { road: 'C', polyline: '116.40,39.90' },
      { road: 'D', polyline: '116.40,39.90;116.401,39.901' },
    ]);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.road).toBe('D');
  });

  it('真实 fixture：部分 step 无 road 键，应被兜住而不是抛错', () => {
    const path = (fixture as any).route.paths[0];
    const withoutRoad = path.steps.filter((s: any) => !('road' in s));
    expect(withoutRoad.length).toBeGreaterThan(0); // 确认这个场景真实存在

    const parts = stepsToPolylineParts(path.steps);
    expect(parts.length).toBe(path.steps.length);
    // 无 road 的那些 step 应产出空字符串
    expect(parts.some((p) => p.road === '')).toBe(true);
  });
});

describe('routeFromAmapPayload —— 真实路线解析', () => {
  const route = routeFromAmapPayload(fixture);

  it('距离与时长取自接口返回值', () => {
    const path = (fixture as any).route.paths[0];
    expect(route.distance).toBe(Number.parseFloat(path.distance));
    // duration 接口单位是秒，契约单位是毫秒
    expect(route.duration).toBe(Number.parseFloat(path.duration) * 1000);
  });

  it('分段总长与接口距离一致（误差 < 1%）', () => {
    const total = route.segments.reduce((s, x) => s + x.dist, 0);
    expect(Math.abs(total - route.distance) / route.distance).toBeLessThan(0.01);
  });

  it('分段数量在合理范围（138km / 约100m）', () => {
    expect(route.segments.length).toBeGreaterThan(1000);
    expect(route.segments.length).toBeLessThan(2500);
  });

  it('所有分段都有有效朝向（无 NaN）', () => {
    for (const s of route.segments) {
      expect(Number.isFinite(s.heading)).toBe(true);
      expect(s.heading).toBeGreaterThanOrEqual(0);
      expect(s.heading).toBeLessThan(360);
    }
  });

  it('所有分段长度 >= 1m（退化段已丢弃）', () => {
    for (const s of route.segments) {
      expect(s.dist).toBeGreaterThanOrEqual(1);
    }
  });

  it('道路名透传到分段，且真实高速名可见', () => {
    const roads = new Set(route.segments.map((s) => s.road));
    expect(roads.has('G2京沪高速')).toBe(true);
    const named = route.segments.filter((s) => s.road !== '').length;
    // 绝大多数分段应有道路名（真实数据 17/21 个 step 有名字，覆盖长里程）
    expect(named / route.segments.length).toBeGreaterThan(0.8);
  });

  it('index 从 0 连续递增', () => {
    route.segments.forEach((s, i) => expect(s.index).toBe(i));
  });

  it('标记来源与置信度', () => {
    expect(route.source).toBe('fixture');
    expect(route.confidence).toBe('high');
  });

  it('路线整体朝向为东南（天安门→天津）', () => {
    // 用首尾点算总体方位，应在东南象限
    const first = route.segments[0]!;
    const last = route.segments[route.segments.length - 1]!;
    const overall = bearingDeg(first.a, last.b);
    expect(overall).toBeGreaterThan(90);
    expect(overall).toBeLessThan(180);
  });
});

describe('orientation 不可用于计算 —— 守护 C8', () => {
  it('真实数据中同一 step 覆盖极长里程却只有一个 orientation', () => {
    const path = (fixture as any).route.paths[0];
    // 实测：G2京沪高速 有一段 97,776m 只配一个「东南」
    const longest = path.steps
      .map((s: any) => ({ road: s.road, dist: Number.parseFloat(s.distance), ori: s.orientation }))
      .sort((a: any, b: any) => b.dist - a.dist)[0];

    expect(longest.dist).toBeGreaterThan(50_000); // 超过 50km
    expect(longest.ori).toBeTruthy();             // 却只有一个方位词
    // 8 档方位词的取值集合
    expect(['东', '东北', '东南', '北', '南', '西', '西北', '西南']).toContain(longest.ori);
  });

  it('orientation 的 8 档量化误差（±22.5°）大于模型的判别力', () => {
    // 我们的角度权重在 θ=15° 处已降到 0.5，而 45° 分辨率意味着 ±22.5° 误差
    // 这不是数值巧合，而是 orientation 根本不可用的原因
    const quantizationError = 45 / 2;
    expect(quantizationError).toBe(22.5);
    expect(quantizationError).toBeGreaterThan(15);
  });

  it('从 polyline 自算的 bearing 比 orientation 细粒度得多', () => {
    const path = (fixture as any).route.paths[0];
    const pts = parsePolyline(path.steps[0].polyline);
    const bearings = new Set<number>();
    for (let i = 0; i < pts.length - 1; i++) {
      bearings.add(Math.round(bearingDeg(pts[i]!, pts[i + 1]!) * 10) / 10);
    }
    // 同一个 step 内部应出现多个不同朝向，证明 orientation 的单值描述不足
    expect(bearings.size).toBeGreaterThan(1);
  });
});

describe('AmapProvider —— 错误处理', () => {
  function providerWith(payload: unknown, status = 200): AmapProvider {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    return new AmapProvider({ apiKey: 'test-key', fetchImpl });
  }

  it('代理模式下可以不传 apiKey（Q8 决策：前端不持有密钥）', () => {
    // 见 docs/q8-api-architecture-decision.md
    // 前端经 /amap-api 代理访问，凭据由代理注入。
    expect(() => new AmapProvider({ baseUrl: '/amap-api' })).not.toThrow();
  });

  it('直连模式不传 apiKey 时，请求不带 key 参数（由高德返回 10001）', async () => {
    let captured = '';
    const fetchImpl = (async (input: RequestInfo | URL) => {
      captured = String(input);
      return new Response(JSON.stringify({ status: '0', info: 'INVALID_USER_KEY', infocode: '10001' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const p = new AmapProvider({ fetchImpl });
    await expect(
      p.getRoute({ lon: 116, lat: 39 }, { lon: 117, lat: 39 }),
    ).rejects.toThrow(/Key 不正确/);

    expect(captured).not.toContain('key=');
  });

  it('直连模式传了 apiKey 时会带上 key 参数', async () => {
    let captured = '';
    const fetchImpl = (async (input: RequestInfo | URL) => {
      captured = String(input);
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const p = new AmapProvider({ apiKey: 'k', fetchImpl });
    await p.getRoute({ lon: 116, lat: 39 }, { lon: 117, lat: 39 });
    expect(captured).toContain('key=k');
  });

  it('HTTP 非 200 时抛出 AmapError', async () => {
    const p = providerWith({}, 500);
    await expect(p.getRoute({ lon: 116, lat: 39 }, { lon: 117, lat: 39 })).rejects.toThrow(
      AmapError,
    );
  });

  it('status=0 时抛出，并带上 info/infocode', async () => {
    const p = providerWith({ status: '0', info: 'INVALID_USER_KEY', infocode: '10001' });
    await expect(p.getRoute({ lon: 116, lat: 39 }, { lon: 117, lat: 39 })).rejects.toThrow(
      /Key 不正确或已失效/,
    );
  });

  it('错误码 10009 给出「Key 类型不匹配」的提示', async () => {
    const p = providerWith({ status: '0', info: 'USERKEY_PLAT_NOMATCH', infocode: '10009' });
    await expect(p.getRoute({ lon: 116, lat: 39 }, { lon: 117, lat: 39 })).rejects.toThrow(
      /服务类型不匹配/,
    );
  });

  it('无路径时抛出', async () => {
    const p = providerWith({ status: '1', route: { paths: [] } });
    await expect(p.getRoute({ lon: 116, lat: 39 }, { lon: 117, lat: 39 })).rejects.toThrow(
      /未返回任何路径/,
    );
  });

  it('折线为空时抛出', async () => {
    const p = providerWith({ status: '1', route: { paths: [{ steps: [] }] } });
    await expect(p.getRoute({ lon: 116, lat: 39 }, { lon: 117, lat: 39 })).rejects.toThrow(
      /不含有效折线/,
    );
  });

  it('请求 URL 带齐必要参数（extensions=all 必须存在）', async () => {
    let captured = '';
    const fetchImpl = (async (input: RequestInfo | URL) => {
      captured = String(input);
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const p = new AmapProvider({ apiKey: 'k', fetchImpl });
    await p.getRoute({ lon: 116.397428, lat: 39.90923 }, { lon: 117.201509, lat: 39.085308 });

    expect(captured).toContain('extensions=all');
    expect(captured).toContain('key=k');
    expect(captured).toContain('origin=116.397428%2C39.909230');
    expect(captured).toContain('destination=117.201509%2C39.085308');
    expect(captured).toContain('strategy=0');
    expect(captured).not.toContain('waypoints=');
  });

  it('传入途径点时 URL 携带 waypoints 参数', async () => {
    let captured = '';
    const fetchImpl = (async (input: RequestInfo | URL) => {
      captured = String(input);
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const p = new AmapProvider({ apiKey: 'k', fetchImpl });
    await p.getRoute(
      { lon: 116.397428, lat: 39.90923 },
      { lon: 117.201509, lat: 39.085308 },
      { waypoints: [{ lon: 116.994_195, lat: 39.385_558 }] },
    );

    expect(captured).toContain('waypoints=116.994195%2C39.385558');
  });

  it('成功路径返回可用的 Route', async () => {
    const p = providerWith(fixture);
    const route = await p.getRoute({ lon: 116.397428, lat: 39.90923 }, { lon: 117.201509, lat: 39.085308 });
    expect(route.source).toBe('amap-web');
    expect(route.segments.length).toBeGreaterThan(1000);
    expect(route.distance).toBeGreaterThan(130_000);
  });
});

describe('AmapProvider.geocode', () => {
  it('解析坐标与格式化地址', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          status: '1',
          geocodes: [{ location: '116.397463,39.909187', formatted_address: '北京市东城区天安门' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const p = new AmapProvider({ apiKey: 'k', fetchImpl });
    const r = await p.geocode('北京市天安门');
    expect(r).not.toBeNull();
    expect(r!.location.lon).toBeCloseTo(116.397463, 6);
    expect(r!.location.lat).toBeCloseTo(39.909187, 6);
    expect(r!.formatted).toContain('天安门');
  });

  it('无结果时返回 null 而非抛错', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ status: '1', geocodes: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const p = new AmapProvider({ apiKey: 'k', fetchImpl });
    expect(await p.geocode('不存在的地方')).toBeNull();
  });

  it('坐标格式非法时返回 null', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ status: '1', geocodes: [{ location: 'bad,data' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const p = new AmapProvider({ apiKey: 'k', fetchImpl });
    expect(await p.geocode('x')).toBeNull();
  });
});
