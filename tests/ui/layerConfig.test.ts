/**
 * 地图图层配置测试
 *
 * 这些是纯函数，不依赖 WebGL，因此可以在 Node 里完整验证。
 * 目的是把「地图是否正确配置」与「canvas 能不能光栅化」两件事分开 ——
 * 后者依赖浏览器/GPU，前者是我们能保证的。
 *
 * 用这个文件守护一个实际踩到的坑：
 *   MapLibre 的 raster source 若不显式声明 subdomains，
 *   tiles 里的 {s} 占位符**不会被替换**，请求会打到
 *   `webrd0{s}.is.autonavi.com` 这种不存在的域名上。
 */

import { describe, it, expect } from 'vitest';
import {
  buildMapStyle,
  TILE_SOURCES,
  DEFAULT_TILE_SOURCE,
  TILE_SOURCE_LIST,
  RISK_FILL_COLORS,
  RISK_TEXT_COLORS,
  RISK_LEVEL_LABELS,
  RISK_LEVEL_ORDER_UI,
  DEFAULT_VIEW,
  SAMPLE_ROUTE,
} from '@/ui/layerConfig.js';
import { buildRouteGeoJSON } from '@/ui/MapView.js';
import { riskLevel } from '@/domain/glareEngine.js';
import type { SegmentRisk } from '@/domain/types.js';

function makeSeg(
  index: number,
  score: number,
  aLon: number,
  aLat: number,
  bLon: number,
  bLat: number,
): SegmentRisk {
  const at = new Date(Date.UTC(2025, 2, 20, 7, 0, 0));
  return {
    index,
    a: { lon: aLon, lat: aLat },
    b: { lon: bLon, lat: bLat },
    heading: 90,
    dist: 100,
    road: '测试路',
    tStart: at,
    tEnd: at,
    rP80: score,
    rMax: score,
    peak: {
      score,
      at,
      sunAzimuth: 90,
      sunElevation: 5,
      heading: 90,
      offAxisAngle: 2,
    },
  };
}

describe('buildMapStyle —— 瓦片源配置', () => {
  it('矢量底图样式结构合法', () => {
    const style = buildMapStyle('vector');
    expect(style.version).toBe(8);
    expect(Object.keys(style.sources)).toHaveLength(1);
    expect(style.layers).toHaveLength(1);
    expect(style.layers[0]!.type).toBe('raster');
  });

  it('⚠️ 瓦片 URL 不得含 {s} 占位符 —— MapLibre v5 已移除 subdomains', () => {
    // 实测 maplibre-gl 5.24.0：.d.ts 中完全没有 subdomains 字段。
    // 传了会被静默忽略，{s} 永不展开，请求打到 webrd0{s}.is.autonavi.com
    // 这种不存在的域名，表现为底图全黑 + 大量 AJAXError。
    for (const src of TILE_SOURCE_LIST) {
      const style = buildMapStyle(src.id);
      const styleSrc = Object.values(style.sources)[0] as unknown as {
        tiles: string[];
        subdomains?: unknown;
      };

      for (const t of styleSrc.tiles) {
        expect(t).not.toContain('{s}');
      }
      expect(styleSrc.subdomains).toBeUndefined();
    }
  });

  it('TILE_SOURCES 的每个源都不含 {s}，也不声明 subdomains', () => {
    for (const src of Object.values(TILE_SOURCES)) {
      expect(src.tiles.some((t) => t.includes('{s}'))).toBe(false);
      expect('subdomains' in src).toBe(false);
    }
  });

  it('子域已写死为可用主机名（webrd01 / webst01）', () => {
    expect(TILE_SOURCES['amap-vector']!.tiles[0]).toContain('webrd01.is.autonavi.com');
    expect(TILE_SOURCES['amap-satellite']!.tiles[0]).toContain('webst01.is.autonavi.com');
  });

  it('每个瓦片源都声明了坐标系 —— 决定路线是否需要转换', () => {
    for (const src of Object.values(TILE_SOURCES)) {
      expect(['GCJ-02', 'WGS-84']).toContain(src.crs);
    }
  });

  it('默认瓦片源必须是 GCJ-02（与路线同系，零转换）', () => {
    expect(TILE_SOURCES[DEFAULT_TILE_SOURCE]!.crs).toBe('GCJ-02');
  });

  it('WGS-84 的源都带 caveat 提醒需要坐标转换', () => {
    for (const src of Object.values(TILE_SOURCES)) {
      if (src.crs === 'WGS-84') {
        expect(src.caveat).toBeTruthy();
        expect(src.caveat).toContain('转换');
      }
    }
  });

  it('tiles 模板包含必需的 {x} {y} {z} 占位符', () => {
    for (const src of Object.values(TILE_SOURCES)) {
      for (const t of src.tiles) {
        for (const ph of ['{x}', '{y}', '{z}']) {
          expect(t).toContain(ph);
        }
      }
    }
  });

  it('不请求任何字体 glyphs（我们用 DOM Marker 替代文字标注）', () => {
    const style = buildMapStyle('vector') as Record<string, unknown>;
    expect(style.glyphs).toBeUndefined();
  });

  it('不同瓦片源产生不同的源 id', () => {
    const v = Object.keys(buildMapStyle('amap-vector').sources)[0];
    const s = Object.keys(buildMapStyle('amap-satellite').sources)[0];
    const e = Object.keys(buildMapStyle('esri-street').sources)[0];
    expect(new Set([v, s, e]).size).toBe(3);
  });

  it('未知的源 id 回退到默认源而不是崩溃', () => {
    const style = buildMapStyle('不存在的源');
    expect(Object.keys(style.sources)).toEqual([DEFAULT_TILE_SOURCE]);
  });
});

describe('buildRouteGeoJSON —— 分段着色数据', () => {
  const segments: SegmentRisk[] = [
    makeSeg(0, 10, 116.4, 39.9, 116.401, 39.9),
    makeSeg(1, 45, 116.401, 39.9, 116.402, 39.9),
    makeSeg(2, 70, 116.402, 39.9, 116.403, 39.9),
    makeSeg(3, 85, 116.403, 39.9, 116.404, 39.9),
  ];

  it('每个分段生成一个 LineString feature', () => {
    const gj = buildRouteGeoJSON(segments);
    expect(gj.type).toBe('FeatureCollection');
    expect(gj.features).toHaveLength(4);
    for (const f of gj.features) {
      expect(f.geometry.type).toBe('LineString');
      expect(f.geometry.coordinates).toHaveLength(2);
    }
  });

  it('颜色按风险等级正确映射', () => {
    const gj = buildRouteGeoJSON(segments);
    const expected = [10, 45, 70, 85].map((s) => RISK_FILL_COLORS[riskLevel(s)]);
    expect(gj.features.map((f) => f.properties.color)).toEqual(expected);
  });

  it('等级标注与颜色一致', () => {
    const gj = buildRouteGeoJSON(segments);
    expect(gj.features.map((f) => f.properties.level)).toEqual(['低', '中', '高', '极高']);
  });

  it('index 可用于点击回查', () => {
    const gj = buildRouteGeoJSON(segments);
    expect(gj.features.map((f) => f.properties.index)).toEqual([0, 1, 2, 3]);
  });

  it('坐标顺序为 [lon, lat]（GeoJSON 规范）', () => {
    const gj = buildRouteGeoJSON([makeSeg(0, 10, 116.4, 39.9, 116.401, 39.91)]);
    const coords = gj.features[0]!.geometry.coordinates;
    expect(coords[0]).toEqual([116.4, 39.9]);
    expect(coords[1]).toEqual([116.401, 39.91]);
  });

  it('空输入返回空 FeatureCollection 而不是崩溃', () => {
    const gj = buildRouteGeoJSON([]);
    expect(gj.features).toEqual([]);
  });

  it('大量分段（模拟真实 1484 段）不产生重复 index', () => {
    const many: SegmentRisk[] = [];
    for (let i = 0; i < 1484; i++) {
      many.push(makeSeg(i, i % 100, 116 + i * 0.0001, 39.9, 116 + (i + 1) * 0.0001, 39.9));
    }
    const gj = buildRouteGeoJSON(many);
    expect(gj.features).toHaveLength(1484);
    const indices = new Set(gj.features.map((f) => f.properties.index));
    expect(indices.size).toBe(1484);
  });
});

describe('配色与文案 —— 无障碍要求', () => {
  it('四个等级都有面积色、文本色、说明文案', () => {
    for (const lv of RISK_LEVEL_ORDER_UI) {
      expect(RISK_FILL_COLORS[lv]).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(RISK_TEXT_COLORS[lv]).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(RISK_LEVEL_LABELS[lv].length).toBeGreaterThan(0);
    }
  });

  it('面积色与文本色不同 —— 深色底上「极高」的深红当文字看不清', () => {
    for (const lv of RISK_LEVEL_ORDER_UI) {
      expect(RISK_FILL_COLORS[lv]).not.toBe(RISK_TEXT_COLORS[lv]);
    }
  });

  it('色相沿风险递增从绿到红 —— 符合通用直觉', () => {
    const hue = (hex: string) => {
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max === min) return 0;
      const d = max - min;
      let h: number;
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      return ((h * 60) % 360 + 360) % 360;
    };

    // 低=绿(约120°–150°)，中=黄(约40°–60°)，高/极高=红(约0°–30°)
    expect(hue(RISK_FILL_COLORS['低'])).toBeGreaterThan(100);
    expect(hue(RISK_FILL_COLORS['低'])).toBeLessThan(160);
    expect(hue(RISK_FILL_COLORS['中'])).toBeGreaterThan(35);
    expect(hue(RISK_FILL_COLORS['中'])).toBeLessThan(70);
    expect(hue(RISK_FILL_COLORS['高'])).toBeLessThan(30);
    expect(hue(RISK_FILL_COLORS['极高'])).toBeLessThan(20);
  });

  it('四个等级颜色互不相同', () => {
    const colors = RISK_LEVEL_ORDER_UI.map((lv) => RISK_FILL_COLORS[lv]);
    expect(new Set(colors).size).toBe(4);
  });
});

describe('地图默认值', () => {
  it('默认视野落在中国境内', () => {
    const [lon, lat] = DEFAULT_VIEW.center;
    expect(lon).toBeGreaterThan(73);
    expect(lon).toBeLessThan(136);
    expect(lat).toBeGreaterThan(18);
    expect(lat).toBeLessThan(54);
  });

  it('示例路线与测试 fixture 一致（天安门 → 天津站）', () => {
    expect(SAMPLE_ROUTE.origin.lon).toBeCloseTo(116.397428, 6);
    expect(SAMPLE_ROUTE.origin.lat).toBeCloseTo(39.90923, 6);
    expect(SAMPLE_ROUTE.destination.lon).toBeCloseTo(117.201509, 6);
    expect(SAMPLE_ROUTE.destination.lat).toBeCloseTo(39.085308, 6);
  });
});
