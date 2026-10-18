/**
 * 核心领域类型定义
 *
 * 命名与单位约定（全项目统一，不得偏离）：
 *   - 所有角度单位为「度」
 *   - 方位角 azimuth / heading 一律「正北为 0°，顺时针递增 0–360°」
 *   - 坐标一律 (lon, lat)，即经度在前
 *   - 距离单位「米」，时间单位「毫秒」（JS Date 语义）
 */

/** 经纬度坐标。经度在前，与高德 API 的 `lon,lat` 字符串一致 */
export interface LonLat {
  lon: number;
  lat: number;
}

/** 路线分段 —— 计算与展示的最小单元 */
export interface RouteSegment {
  /** 段序号，从 0 开始 */
  index: number;
  /** 段起点 */
  a: LonLat;
  /** 段终点 */
  b: LonLat;
  /** 行驶朝向，正北 0°，顺时针 */
  heading: number;
  /** 段长度（米） */
  dist: number;
  /** 道路名。高德部分 step 的 road 为空字符串 */
  road: string;
}

/** 分段上的风险计算结果 */
export interface SegmentRisk extends RouteSegment {
  /** 该段通过时间窗起点 */
  tStart: Date;
  /** 该段通过时间窗终点 */
  tEnd: Date;
  /** 对时间采样取 P80 分位，作为该段的「典型最差」风险 */
  rP80: number;
  /** 时间采样中的最大值，代表「最坏瞬间」 */
  rMax: number;
  /** 峰值对应的时空详情，便于「计算依据展示」（F8） */
  peak: RiskPeak;
}

/** 峰值时刻的完整可解释信息 */
export interface RiskPeak {
  /** 该时刻的风险分数 */
  score: number;
  /** 时刻 */
  at: Date;
  /** 太阳方位角 */
  sunAzimuth: number;
  /** 太阳高度角 */
  sunElevation: number;
  /** 该段朝向 */
  heading: number;
  /** 离轴角（太阳方向与车头方向的夹角）—— 本产品的核心量 */
  offAxisAngle: number;
}

/** 风险等级 */
export type RiskLevel = '低' | '中' | '高' | '极高';

/** 太阳位置计算结果 */
export interface SunPosition {
  /** 方位角，正北 0°，顺时针 0–360 */
  azimuth: number;
  /** 高度角，地平线以上为正 */
  elevation: number;
}

/** 天气对风险的衰减系数（F7） */
export type WeatherFactor = number;

/** 按道路名聚合后的高风险窗口（F5 的产出形态，Q9 决策：以路名为组织主键） */
export interface RiskWindow {
  /** 道路名。空字符串代表未命名路段 */
  road: string;
  /** 窗口开始时刻 */
  tStart: Date;
  /** 窗口结束时刻 */
  tEnd: Date;
  /** 组成该窗口的分段 */
  segments: SegmentRisk[];
  /** 窗口内峰值风险 */
  maxRisk: number;
  /** 窗口内累计里程（米） */
  distance: number;
  /** 该窗口的风险等级 */
  level: RiskLevel;
  /**
   * 是否为「瞬时」窗口 —— 行程时长不足 1 分钟，无法给出有意义的时间区间。
   * 400m 路段 @ 53km/h 仅 27 秒。见 PRD F5。
   */
  instantaneous: boolean;
}

/** 出发时间优化（F6）的单个候选方案 */
export interface DepartureCandidate {
  /** 出发时刻 */
  departAt: Date;
  /** 到达时刻 */
  arriveAt: Date;
  /** 峰值风险 —— F6 的主排序键 */
  peakRisk: number;
  /** 「高」以上等级的里程占比 0–1，反映风险的空间广度 */
  highRiskRatio: number;
  /** 峰值所在的道路名 */
  peakRoad: string;
}

/** 一段连续的出发时间区间，及该区间内的风险量级 */
export interface DepartureRange {
  /** 区间起点（含） */
  from: Date;
  /** 区间终点（含） */
  to: Date;
  /** 区间内的最小风险（用于「安全区间」）或最大风险（用于「危险区间」） */
  boundRisk: number;
}

/** F6 的完整优化结果 */
export interface DeparturePlan {
  /** Top 3 推荐出发时刻，按峰值风险升序 */
  candidates: DepartureCandidate[];
  /**
   * 峰值 ≥ 60 的出发时间区间（危险窗）。
   * 用户理解的是「有一条线不能越」，这比「一个魔法时刻」更可执行。
   */
  dangerousRanges: DepartureRange[];
  /** 峰值 < 60 的出发时间区间（安全窗） */
  safeRanges: DepartureRange[];
  /**
   * 峰值下界 —— 在可行出发区间内，无论怎么选都躲不掉的最坏峰值。
   * 由路线几何决定，与出发时间无关。
   */
  peakLowerBound: number;
  /**
   * 是否无法完全避开逆光。
   * 当 peakLowerBound >= 60 时为 true，此时必须给出「反建议」而非硬推一个时间。
   */
  unavoidable: boolean;
  /** 可行出发区间（由用户选定的到达时段反推得到） */
  feasibleFrom: Date;
  /** 可行出发区间终点 */
  feasibleTo: Date;
}

/** 路线（Provider 的统一输出契约） */
export interface Route {
  segments: RouteSegment[];
  /** 总长度（米）。来自 Provider，不自行从坐标计算，避免坐标系引入误差 */
  distance: number;
  /** 预计总时长（毫秒）。来自 Provider，含路况估计 */
  duration: number;
  /** 数据来源标识，透出到 UI 以避免「悄悄算错」 */
  source: RouteSource;
  /** 数据置信度。国内 OSM 数据不可靠时需要让用户知情 */
  confidence: 'high' | 'medium' | 'low';
}

export type RouteSource = 'amap-web' | 'amap-js' | 'osrm' | 'valhalla' | 'fixture';

/** 路线获取可选参数 */
export interface GetRouteOptions {
  /** 途径点（按顺序经过）。高德最多 16 个 */
  waypoints?: readonly LonLat[];
}

/** 路线获取的统一接口 —— 算法层完全不知道数据来自哪（PRD 7.2） */
export interface RouteProvider {
  readonly name: RouteSource;
  getRoute(
    origin: LonLat,
    destination: LonLat,
    options?: GetRouteOptions,
  ): Promise<Route>;
}
