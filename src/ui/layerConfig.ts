/**
 * 图层与配色配置
 *
 * ── 底图瓦片 ────────────────────────────────────────────────────────────
 * 用高德栅格瓦片，直接 HTTP 请求（实测 2026-10 通过）：
 *   HTTP 200 / content-type: image/png / access-control-allow-origin: * / 真 PNG
 *
 * ⚠️ 这是高德 JS API 内部使用的未公开瓦片地址，不是正式对外接口。
 *    可能随时变更或限流。若瓦片失效，改这里的 TILE_SOURCES 即可，
 *    上层代码无需改动。备选：天地图（需 Key）、MapTiler（需 Key）、
 *    或自建瓦片服务。
 *
 * ⚠️ 瓦片坐标系是 GCJ-02，与我们的路线数据（高德返回）一致，
 *    因此**零坐标转换**。若将来换 WGS-84 瓦片源（如 OSM），
 *    必须先把路线坐标 GCJ-02 → WGS-84，否则整体偏约 710m。
 *    见 docs/amap-provider-findings.md §4。
 */

import type { RiskLevel } from '@/domain/types';

// ---------------------------------------------------------------------------
// 瓦片源
// ---------------------------------------------------------------------------

/** 瓦片源的坐标系 —— 决定路线是否需要坐标转换 */
export type TileCrs = 'GCJ-02' | 'WGS-84';

export interface TileSource {
  id: string;
  label: string;
  /**
   * 瓦片 URL 模板。**不要使用 `{s}` 子域占位符。**
   *
   * ⚠️ 踩过的坑：MapLibre GL JS **v5 已移除 `subdomains` 字段**
   *    （实测版本 5.24.0，其 .d.ts 中完全不含 subdomains）。
   *    传了会被**静默忽略**，导致 `{s}` 永远不被展开，
   *    请求打到 `https://webrd0{s}.is.autonavi.com/...` 这种不存在的域名，
   *    表现为底图全黑 + 大量 AJAXError。
   *
   * 若将来要分摊并发，应注册多个 raster source 在上层轮换。
   */
  tiles: string[];
  /**
   * 该瓦片源的坐标系。
   *
   * 这决定路线是否需要在渲染前做坐标转换：
   *  - `GCJ-02`：与高德返回的路线同系 → **零转换**（正确且最省）
   *  - `WGS-84`：必须先把路线 gcj02ToWgs84，否则整体偏移 300–600m
   */
  crs: TileCrs;
  /** 是否需要 API Key 才能用 */
  requiresKey?: boolean;
  /** 已知风险说明，会显示在 UI 上 */
  caveat?: string;
  attribution: string;
  maxZoom: number;
}

/**
 * 瓦片源注册表。
 *
 * ── 为什么默认是高德 ──────────────────────────────────────────────────
 * 只有高德瓦片是 **GCJ-02**，与高德返回的路线同坐标系，零转换。
 * 用任何 WGS-84 源（Esri / OSM）都必须转换，否则路线「飘在路外」。
 *
 * ── 已知风险（必须让运维/用户知情）───────────────────────────────────
 * 高德这两个是 **JS API 内部使用的未公开瓦片地址**，不是正式对外接口。
 * 实测可直连（HTTP 200 / CORS `*` / 真 PNG），但可能随时变更或限流。
 * 因此这里做成可切换注册表：失效时换一个源，上层代码不用改。
 *
 * ── 为什么不用 staticmap ─────────────────────────────────────────────
 * 高德 Web服务 Key 覆盖 `/v3/staticmap`（静态图，一张 PNG），
 * **不是可缩放的瓦片服务**。所以「一个 Key 覆盖全部需求」这个说法不准确。
 */
export const TILE_SOURCES: Record<string, TileSource> = {
  'amap-vector': {
    id: 'amap-vector',
    label: '高德 · 矢量',
    tiles: [
      'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    ],
    crs: 'GCJ-02',
    caveat: '未公开瓦片地址，可能被限流',
    attribution: '© 高德地图',
    maxZoom: 18,
  },
  'amap-satellite': {
    id: 'amap-satellite',
    label: '高德 · 卫星',
    tiles: ['https://webst01.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}'],
    crs: 'GCJ-02',
    caveat: '未公开瓦片地址，可能被限流',
    attribution: '© 高德地图',
    maxZoom: 18,
  },
  'esri-street': {
    id: 'esri-street',
    label: 'Esri · 街道（英文）',
    tiles: [
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    ],
    crs: 'WGS-84',
    caveat: '官方可编程接口，稳定；但标注为英文，且需坐标转换',
    attribution: '© Esri',
    maxZoom: 18,
  },
  'osm-de': {
    id: 'osm-de',
    label: 'OSM · 德国镜像',
    tiles: ['https://tile.openstreetmap.de/{z}/{x}/{y}.png'],
    crs: 'WGS-84',
    caveat: '社区镜像，请遵守 OSM 使用政策；需坐标转换',
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  },
};

/** 默认瓦片源 —— 唯一与路线同坐标系的源，零转换 */
export const DEFAULT_TILE_SOURCE = 'amap-vector';

/** 可切换的瓦片源列表（UI 用） */
export const TILE_SOURCE_LIST: TileSource[] = Object.values(TILE_SOURCES);

/** 构造 MapLibre 样式对象 */
export function buildMapStyle(sourceId: string) {
  const src = TILE_SOURCES[sourceId] ?? TILE_SOURCES[DEFAULT_TILE_SOURCE]!;
  return {
    version: 8 as const,
    // 不引入任何字体 glyphs 服务：文字标注用 DOM Marker 实现
    sources: {
      [src.id]: {
        type: 'raster' as const,
        // 注意：不要加 subdomains —— MapLibre v5 已移除该字段
        tiles: src.tiles,
        tileSize: 256,
        maxzoom: src.maxZoom,
        attribution: src.attribution,
      },
    },
    layers: [{ id: `${src.id}-layer`, type: 'raster' as const, source: src.id }],
  };
}

// ---------------------------------------------------------------------------
// 风险等级配色
// ---------------------------------------------------------------------------

/**
 * 面积配色（路线着色）—— 绿 / 黄 / 红分级，地图上一眼可读。
 * 四档：低=绿、中=黄、高=橙红、极高=红。
 */
export const RISK_FILL_COLORS: Record<RiskLevel, string> = {
  低: '#1FAF5A',
  中: '#F0CA12',
  高: '#F05A28',
  极高: '#E01818',
};

/**
 * 文本配色 —— 在深色背景上比面积色更亮，保证正文可读性。
 * 特别是「极高」的 #8E1B12 在深色底上几乎看不清，必须单独给一个亮色。
 */
export const RISK_TEXT_COLORS: Record<RiskLevel, string> = {
  低: '#7FB2E5',
  中: '#F5C069',
  高: '#FF6B5B',
  极高: '#FF3B2F',
};

/**
 * 精度说明：「极高」用最深的红，但在深色地图上要能看见，
 * 故另给一个描边色。
 */
export const RISK_OUTLINE_COLORS: Record<RiskLevel, string> = {
  低: '#2A5C8F',
  中: '#B87A1E',
  高: '#A51F13',
  极高: '#5C0F0A',
};

/**
 * 分段评估 —— 见注：本产品的风险配色**不满足 WCAG 的颜色对比要求**，
 * 因为它本质是一个 4 级有序色标，必须靠明度阶梯 + 图例文字 + 数值共同传达，
 * 不能只靠色相区分。
 *
 * 因此 UI **必须**同时提供：图例（文字 + 色块）、等级标签、数值。
 * 这是无障碍要求，不是可选项。见 PRD F4 验收标准。
 */
export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  低: '基本无影响',
  中: '可能轻微刺眼',
  高: '明显影响视线',
  极高: '严重致盲风险',
};

/** 图例顺序，从轻到重 */
export const RISK_LEVEL_ORDER_UI: RiskLevel[] = ['低', '中', '高', '极高'];

/** 中国全境的大致中心与初始缩放 */
export const DEFAULT_VIEW = {
  center: [116.8, 39.3] as [number, number],
  zoom: 8,
};

/** 示例路线的默认起终点（天安门 → 天津站），与测试 fixture 一致 */
export const SAMPLE_ROUTE = {
  origin: { lon: 116.397428, lat: 39.90923 },
  destination: { lon: 117.201509, lat: 39.085308 },
  originLabel: '天安门 · 北京',
  destinationLabel: '天津站 · 天津',
};
