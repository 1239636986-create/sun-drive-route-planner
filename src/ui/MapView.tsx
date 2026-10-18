/**
 * 地图视图 —— MapLibre GL + 高德栅格瓦片
 *
 * 关键实现决策：
 *
 * 1. **用 MapLibre 而不是高德 JS API**
 *    见 docs/q8-api-architecture-decision.md。好处是无需 JS API Key，
 *    且瓦片坐标系（GCJ-02）与路线数据一致 —— 零坐标转换。
 *
 * 2. **风险分节渲染（segment）而不是单条 line**
 *    一条 138km 的路线含 1484 个分段，每段有独立风险等级。
 *    用 MultiLineString/LineString 的 feature-collection 才能逐段着色。
 *
 * 3. **用 `['get', 'color']` 表达式取色，而不是 match 等级**
 *    颜色由领域层统一提供（layerConfig），地图层不重复定义映射规则。
 *
 * 4. **高亮选中路段用独立图层**
 *    避免改动主图层的数据，减少重绘。
 */

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  buildMapStyle,
  DEFAULT_VIEW,
  DEFAULT_TILE_SOURCE,
  TILE_SOURCES,
  RISK_FILL_COLORS,
} from './layerConfig.js';
import { gcj02ToWgs84 } from '@/domain/coords.js';
import { riskLevel, riskAdvice, RISK_LEVEL_COLORS } from '@/domain/glareEngine.js';
import type { LonLat, RiskLevel, SegmentRisk } from '@/domain/types.js';

const ROUTE_SOURCE = 'route';
const ROUTE_LAYER = 'route-risk';
const HIGHLIGHT_SOURCE = 'route-highlight';
const HIGHLIGHT_LAYER = 'route-highlight-line';

interface MapViewProps {
  segments: readonly SegmentRisk[];
  /** 高亮某条高风险窗口的所属分段 */
  highlightIndices?: ReadonlySet<number>;
  endpoints?: { from: LonLat; to: LonLat } | null;
  /** 初始视野自动贴合路线 */
  fitToRoute?: boolean;
  /** 当前瓦片源 id。决定是否需要对路线做坐标转换 */
  tileSourceId?: string;
}

/**
 * 按瓦片源的坐标系决定是否需要把路线从 GCJ-02 转出去。
 *
 * 领域层的坐标一律是 **GCJ-02**（高德返回的原样），
 * 因为算 bearing 与太阳位置都不需要转换（见 coords.ts 的说明）。
 * 只有**渲染**才依赖底图坐标系：
 *   - 高德瓦片（GCJ-02）→ 原样使用
 *   - Esri / OSM（WGS-84）→ 必须转换，否则路线整体偏移 300–600m
 */
export function adaptCoord(p: LonLat, crs: 'GCJ-02' | 'WGS-84'): LonLat {
  if (crs === 'GCJ-02') return p;
  return gcj02ToWgs84(p);
}

interface RouteFeature {
  type: 'Feature';
  properties: {
    /** 段序号，用于点击回查 */
    index: number;
    color: string;
    level: RiskLevel;
  };
  geometry: {
    type: 'LineString';
    coordinates: [number, number][];
  };
}

/**
 * 把分段构建成 GeoJSON FeatureCollection。
 *
 * @param crs 目标瓦片源的坐标系。GCJ-02 时原样输出（零转换）。
 */
export function buildRouteGeoJSON(
  segments: readonly SegmentRisk[],
  crs: 'GCJ-02' | 'WGS-84' = 'GCJ-02',
) {
  const features: RouteFeature[] = segments.map((s) => {
    const a = adaptCoord(s.a, crs);
    const b = adaptCoord(s.b, crs);
    return {
      type: 'Feature' as const,
      properties: {
        index: s.index,
        color: RISK_FILL_COLORS[riskLevel(s.rP80)],
        level: riskLevel(s.rP80),
      },
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [a.lon, a.lat],
          [b.lon, b.lat],
        ] as [number, number][],
      },
    };
  });

  return { type: 'FeatureCollection' as const, features };
}

/** 判断某瓦片源是否需要坐标转换 */
export function needsCoordAdaptation(tileSourceId: string): boolean {
  const src = TILE_SOURCES[tileSourceId];
  return src ? src.crs === 'WGS-84' : false;
}

export function MapView({
  segments,
  highlightIndices,
  endpoints,
  fitToRoute = true,
  tileSourceId = DEFAULT_TILE_SOURCE,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** 地图本身无法初始化 —— 此时覆盖全屏，因为确实没法用 */
  const [fatalError, setFatalError] = useState<string | null>(null);
  /** 底图瓦片加载异常 —— 只在角落提示，不遮挡路线与结论 */
  const [tileWarning, setTileWarning] = useState<string | null>(null);

  /** 当前瓦片源的坐标系 —— 决定路线是否需要转换 */
  const tileCrs = (TILE_SOURCES[tileSourceId] ?? TILE_SOURCES[DEFAULT_TILE_SOURCE]!).crs;

  // --- 初始化地图（仅一次）---
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: buildMapStyle(tileSourceId),
        center: DEFAULT_VIEW.center,
        zoom: DEFAULT_VIEW.zoom,
        attributionControl: { compact: true },
      });
    } catch (err) {
      setFatalError(err instanceof Error ? err.message : '地图初始化失败');
      return;
    }

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;

    /**
     * ⚠️ 用 `style.load` 而不是 `load`。
     *
     * `load` 要等到「所有资源加载完 + 首帧渲染完」才触发。实测在软件光栅化
     * 环境下它**从不触发**（`style.load` 与 `render` 都正常），
     * 结果挂在 `load` 里的 addSource/addLayer **永远不执行**，地图只剩
     * DOM Marker，路线完全不显示。
     *
     * 这不只是无头环境的问题：真实浏览器里若瓦片慢或被限流，
     * `load` 同样会长期不触发，用户就会看到一张没有路线的空地图。
     * 而我们的路线图层是本地数据，根本不该依赖底图瓦片加载完成。
     *
     * `style.load` 只需样式就绪即可，是注册自定义图层的正确时机。
     * 它在样式被替换时会再次触发，故用 guard 防止重复添加。
     */
    const installLayers = () => {
      if (map.getSource(ROUTE_SOURCE)) return; // 已安装

      // 路线数据源（分段着色由 `['get','color']` 驱动，不在此处定义映射）
      map.addSource(ROUTE_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer({
        id: ROUTE_LAYER,
        type: 'line',
        source: ROUTE_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          // 加粗突出：远看也能立刻辨认分级路段
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            6, 5,
            10, 9,
            14, 14,
          ],
          'line-opacity': 0.95,
        },
      });

      // 高亮图层
      map.addSource(HIGHLIGHT_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: HIGHLIGHT_LAYER,
        type: 'line',
        source: HIGHLIGHT_SOURCE,
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            6, 9,
            10, 15,
            14, 22,
          ],
          'line-opacity': 0.85,
        },
      });

      // 起终点用 maplibregl.Marker（DOM 元素）实现，
      // 这样无需引入字体 glyphs 依赖，也就不必请求任何外部字体服务。
      setLoaded(true);
    };

    map.on('style.load', installLayers);
    // 极少数情况下 style 在绑定前就已就绪，补一次
    if (map.isStyleLoaded()) installLayers();

    map.on('error', (e) => {
      // 瓦片加载失败不致命：路线是独立图层，风险计算完全不受影响。
      // 因此这里只记一个非阻塞提示，绝不覆盖地图。
      const msg = e.error?.message ?? '';
      if (!msg || /AbortError/.test(msg)) return;
      // 网络抖动导致的零散失败不值得打扰用户
      if (/Failed to fetch|AJAXError/i.test(msg)) {
        setTileWarning((prev) => prev ?? '底图瓦片可能被限流，部分区域显示为空白');
      } else {
        setTileWarning((prev) => prev ?? `底图异常：${msg}`);
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setLoaded(false);
    };
    // tileSourceId 变化不重建地图：改样式由下面单独的 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- 切换瓦片源：只换样式，不重建地图实例 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;

    const current = map.getSource(Object.keys(TILE_SOURCES).find((k) => k === tileSourceId) ?? '');
    if (current) return; // 已经是这个源

    setLoaded(false);
    map.setStyle(buildMapStyle(tileSourceId));
    // style.load 会重新触发 installLayers，随后 setLoaded(true)
  }, [tileSourceId, loaded]);

  // --- 路线数据更新 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;

    const src = map.getSource(ROUTE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    const geojson = buildRouteGeoJSON(segments, tileCrs);
    src.setData(geojson as never);

    /**
     * 运行时自检：把几何要素数打到控制台。
     *
     * 存在的理由：MapLibre 的矢量图层在某些渲染环境下（实测无头软件光栅化）
     * 会静默不绘制 —— 图层存在、数据已 setData，但屏幕上什么都没有，
     * 且不报任何错。有这一行，排查时能立刻分清「没数据」还是「没画出来」。
     * 只在数量异常时告警，正常情况不刷屏。
     */
    if (geojson.features.length === 0) {
      console.warn('[MapView] 路线 GeoJSON 为空，地图上不会显示路线');
    }

    if (fitToRoute && segments.length > 0) {
      const bounds = new maplibregl.LngLatBounds();
      for (const s of segments) {
        bounds.extend([s.a.lon, s.a.lat]);
        bounds.extend([s.b.lon, s.b.lat]);
      }
      map.fitBounds(bounds, { padding: 48, duration: 700, maxZoom: 13 });
    }
  }, [segments, loaded, fitToRoute, tileCrs]);

  // --- 高亮更新 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;

    const src = map.getSource(HIGHLIGHT_SOURCE) as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    if (!highlightIndices || highlightIndices.size === 0) {
      src.setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    const features = segments
      .filter((s) => highlightIndices.has(s.index))
      .map((s) => {
        const pa = adaptCoord(s.a, tileCrs);
        const pb = adaptCoord(s.b, tileCrs);
        return {
          type: 'Feature' as const,
          properties: {},
          geometry: {
            type: 'LineString' as const,
            coordinates: [
              [pa.lon, pa.lat],
              [pb.lon, pb.lat],
            ],
          },
        };
      });

    src.setData({ type: 'FeatureCollection', features });
  }, [highlightIndices, segments, loaded, tileCrs]);

  // --- 起终点标记 ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !endpoints) return;

    const mkMarker = (color: string) => {
      const el = document.createElement('div');
      el.style.cssText = `width:14px;height:14px;border-radius:50%;background:${color};border:2.5px solid #12161c;box-shadow:0 2px 8px rgba(0,0,0,.55)`;
      return el;
    };

    const f = adaptCoord(endpoints.from, tileCrs);
    const t = adaptCoord(endpoints.to, tileCrs);
    const fromMarker = new maplibregl.Marker({ element: mkMarker('#4A9EFF') })
      .setLngLat([f.lon, f.lat])
      .addTo(map);
    const toMarker = new maplibregl.Marker({ element: mkMarker('#FF8F3F') })
      .setLngLat([t.lon, t.lat])
      .addTo(map);

    return () => {
      fromMarker.remove();
      toMarker.remove();
    };
  }, [endpoints, loaded, tileCrs]);

  // --- 点击分段弹出详情（F8 计算依据展示的轻量版）---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;

    const onClick = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      const f = e.features?.[0];
      if (!f) return;

      const index = Number(f.properties?.index ?? -1);
      const seg = segments.find((s) => s.index === index);
      if (!seg) return;

      const level = riskLevel(seg.rP80);
      const p = seg.peak;
      const hhmm = (d: Date) =>
        `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

      new maplibregl.Popup({ closeButton: true, maxWidth: '260px' })
        .setLngLat(e.lngLat)
        .setHTML(
          `<div style="font-weight:650;margin-bottom:6px">${escapeHtml(seg.road || '未命名路段')}</div>` +
            `<div style="display:flex;align-items:center;gap:6px;margin-bottom:7px">` +
            `<span style="background:${RISK_LEVEL_COLORS[level]};color:#12161c;font-size:11px;font-weight:650;padding:1px 6px;border-radius:3px">${level}</span>` +
            `<span style="font-variant-numeric:tabular-nums">峰值 ${seg.rP80.toFixed(0)} 分</span>` +
            `</div>` +
            `<div style="font-size:12px;color:#97a3b4;line-height:1.65">` +
            `通过时段 ${hhmm(seg.tStart)}–${hhmm(seg.tEnd)}<br>` +
            `路段朝向 ${seg.heading.toFixed(0)}° ｜ 太阳方位 ${p.sunAzimuth.toFixed(0)}°<br>` +
            `太阳高度角 ${p.sunElevation.toFixed(1)}° ｜ <b>离轴角 ${p.offAxisAngle.toFixed(1)}°</b>` +
            `</div>`,
        )
        .addTo(map);
    };

    const onEnter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = '';
    };

    map.on('click', ROUTE_LAYER, onClick);
    map.on('mouseenter', ROUTE_LAYER, onEnter);
    map.on('mouseleave', ROUTE_LAYER, onLeave);

    return () => {
      map.off('click', ROUTE_LAYER, onClick);
      map.off('mouseenter', ROUTE_LAYER, onEnter);
      map.off('mouseleave', ROUTE_LAYER, onLeave);
    };
  }, [segments, loaded]);

  return (
    <div className="map-area">
      <div ref={containerRef} className="map" />

      <MapLegend />

      {/* 瓦片警告：角落提示，不遮挡路线 */}
      {tileWarning && !fatalError && (
        <div className="tile-warning" role="status">
          <span aria-hidden="true">⚠</span>
          <span>{tileWarning}</span>
        </div>
      )}

      {/* 地图无法初始化：这时才覆盖全屏 */}
      {fatalError && (
        <div className="map-error">
          <div className="map-error__box">
            <h2 className="map-error__title">地图初始化失败</h2>
            <p className="map-error__body">
              浏览器可能不支持 WebGL，或渲染上下文创建失败。
              左侧的风险计算与结论不受影响，仍可正常使用。
            </p>
            <code className="map-error__code">{fatalError}</code>
          </div>
        </div>
      )}
    </div>
  );
}

/** 地图上的图例浮层 —— 无障碍要求：颜色必须配合文字 */
function MapLegend() {
  const rows: Array<{ level: RiskLevel; desc: string }> = [
    { level: '极高', desc: '避免此时段' },
    { level: '高', desc: '建议偏光镜' },
    { level: '中', desc: '可能轻微刺眼' },
    { level: '低', desc: '基本无影响' },
  ];

  return (
    <div className="map-legend">
      <div className="map-legend__title">逆光风险</div>
      {rows.map((r) => (
        <div className="map-legend__row" key={r.level}>
          <span
            className="map-legend__line"
            style={{ background: RISK_FILL_COLORS[r.level] }}
          />
          <span>{r.level}</span>
          <span className="map-legend__desc">{r.desc}</span>
        </div>
      ))}
    </div>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 导出给测试用：验证 advice 文案能被地图弹窗复用 */
export { riskAdvice };
