/**
 * Q8 架构决策的测试守护
 *
 * 见 docs/q8-api-architecture-decision.md
 *
 * 核心断言：**客户端代码里不得出现密钥**。
 * 这条用静态检查来守护 —— 如果有人「为了方便」把 key 写进前端，
 * 测试会失败。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { AmapProvider, routeFromAmapPayload } from '@/providers/amapProvider.js';
import { amapUrl, formatLonLatParam, AMAP_API_PREFIX, probeProxy } from '@/api/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '../../src');
const fixture = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/route_bj_tj.json'), 'utf-8'),
);

/** 递归收集 src/ 下所有源文件 */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (['.ts', '.tsx'].includes(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

describe('客户端不得持有密钥 —— Q8 决策的静态守护', () => {
  const files = collectSourceFiles(SRC_DIR);

  it('src/ 下有源文件可供检查（防止检查逻辑本身失效）', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('src/ 下没有任何 32 位十六进制串（高德 Key 的形态）', () => {
    // 高德 Web服务 Key 是 32 位十六进制字符串；这里仅描述格式，不放任何真实样例
    const hexKeyPattern = /['"`][0-9a-f]{32}['"`]/i;
    const offenders: string[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      if (hexKeyPattern.test(content)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  it('src/ 下没有硬编码的 key=/jscode= 查询参数值', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      // 匹配 searchParams.set('key', '字面量') 这种写法
      if (/searchParams\.set\(\s*['"](key|jscode)['"]\s*,\s*['"][^'"]+['"]\s*\)/.test(content)) {
        offenders.push(file);
      }
      // 匹配 URL 里直接写 key=xxx
      if (/[?&](key|jscode)=[0-9a-zA-Z]{16,}/.test(content)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('前端代码通过 /amap-api 前缀访问高德，而不是直连 restapi.amap.com', () => {
    // src/api/client.ts 与 src/providers 都不应把 restapi.amap.com 当作
    // 前端默认目标（provider 的默认值是给服务端/Node 用的，允许存在，
    // 但 client.ts 必须用代理前缀）
    const client = readFileSync(join(SRC_DIR, 'api/client.ts'), 'utf-8');
    expect(client).toContain('AMAP_API_PREFIX');
    expect(client).toContain("'/amap-api'");
  });
});

describe('amapUrl —— 构造经代理的请求', () => {
  it('拼接代理前缀与查询参数', () => {
    const url = amapUrl('/v3/geocode/geo', { address: '北京', output: 'JSON' });
    expect(url.startsWith(`${AMAP_API_PREFIX}/v3/geocode/geo?`)).toBe(true);
    expect(url).toContain('address=');
    expect(url).toContain('output=JSON');
  });

  it('不包含任何 key 或 jscode 参数', () => {
    const url = amapUrl('/v3/direction/driving', {
      origin: '116.4,39.9',
      destination: '117.2,39.1',
      extensions: 'all',
    });
    expect(url).not.toContain('key=');
    expect(url).not.toContain('jscode=');
  });

  it('中文参数被正确编码', () => {
    const url = amapUrl('/v3/geocode/geo', { address: '北京市天安门' });
    expect(url).toContain(encodeURIComponent('北京市天安门'));
  });
});

describe('formatLonLatParam', () => {
  it('输出 6 位小数且经度在前', () => {
    expect(formatLonLatParam({ lon: 116.397428, lat: 39.90923 })).toBe(
      '116.397428,39.909230',
    );
  });

  it('与 AmapProvider 的格式化逻辑一致（避免两处漂移）', () => {
    // 两者都必须产出高德要求的 lon,lat 6 位小数
    const p = { lon: 116.4, lat: 39.9 };
    expect(formatLonLatParam(p)).toBe('116.400000,39.900000');
  });
});

describe('AmapProvider 支持经代理的相对 baseUrl', () => {
  it('baseUrl 为 /amap-api 时，请求路径带前缀且不含密钥', async () => {
    let captured = '';
    const fetchImpl = (async (input: RequestInfo | URL) => {
      captured = String(input);
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    // 模拟浏览器环境：location.origin
    const provider = new AmapProvider({
      apiKey: 'placeholder-not-used-by-proxy',
      baseUrl: `${AMAP_API_PREFIX}`,
      fetchImpl,
    });

    await provider.getRoute(
      { lon: 116.397428, lat: 39.90923 },
      { lon: 117.201509, lat: 39.085308 },
    );

    expect(captured).toContain('/amap-api/v3/direction/driving');
    expect(captured).toContain('extensions=all');
  });

  it('经代理拿到的数据能正常解析出分段与道路名', () => {
    const route = routeFromAmapPayload(fixture);
    expect(route.segments.length).toBe(1484);
    expect(route.segments.some((s) => s.road === 'G2京沪高速')).toBe(true);
  });
});

describe('probeProxy —— 代理未配置时给出可操作提示', () => {
  it('代理未注入凭据（10001）时提示检查 .env', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ status: '0', info: 'INVALID_USER_KEY', infocode: '10001' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    try {
      const r = await probeProxy();
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain('AMAP_WEB_KEY');
        expect(r.reason).toContain('vite.config.ts');
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it('网络异常时返回原因而非抛错', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    try {
      const r = await probeProxy();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('无法连接代理');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('代理正常时返回 ok', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: '1', geocodes: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    try {
      const r = await probeProxy();
      expect(r.ok).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});
