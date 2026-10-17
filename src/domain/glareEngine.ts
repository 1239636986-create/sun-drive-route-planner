/**
 * 逆光风险模型
 *
 * 产品的心脏。所有阈值都是**待校准参数**（PRD Q6），
 * 首版取经验值，M2 后用真实驾驶反馈调整。
 *
 * 设计原则（血的教训，见 docs/m0-algorithm-validation-report.md）：
 *   各因子的职责必须严格分离，同一个物理量不得进入两个因子。
 *   wAngle 管几何方向，fSun 管大气衰减，fWeather 管云层遮蔽，
 *   fShade 管地物遮挡，fTerrain 管坡度。
 *
 *   v0.1 曾让太阳高度角同时进入离轴角 θ 和 fSun，造成量纲重复惩罚：
 *     ① 正对太阳时分数随高度角非单调
 *     ② 上限被压到 80 分以下，「极高」等级永不触发
 *   现 fSun 只承担残余的大气散射修正，且严格单调。
 */

import type { RiskLevel } from './types.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** wAngle 的参考角：θ = 15° 时权重恰为 0.5 */
export const GLARE_THETA0 = 15.0;
/** wAngle 的衰减指数。1.6 表示比 Holladay 的 1/θ² 稍缓和（关心主观不适而非纯光学） */
export const GLARE_P = 1.6;

/** 风险分级阈值。约定为左闭右开，极高为闭区间上界 */
export const RISK_THRESHOLDS = {
  medium: 30,
  high: 60,
  extreme: 80,
} as const;

/** 「高」及以上等级的阈值 —— F6 的危险窗口判定、F5 的清单筛选都用它 */
export const HIGH_RISK_THRESHOLD = RISK_THRESHOLDS.high;

/**
 * 离轴角 θ —— 太阳方向与车辆前进方向的夹角。
 *
 *   θ = 0°   : 太阳正对车头，最刺眼
 *   θ = 90°  : 太阳在正侧方，基本不影响
 *   θ = 180° : 太阳在正后方，完全无影响
 *
 * 关键区分：产品关心的**不是**「太阳方位角与道路方位角的差」ΔA，
 * 而是三维空间中太阳方向与车头方向的实际夹角。
 * 因为太阳高挂时，即使方位对齐，光也是从上方来的，有遮阳板可用。
 *
 * 公式：cos θ = cos(h) · cos(ΔA)
 *
 * 边界校验（必须通过，见测试）：
 *   ΔA=0,   h=0   -> θ=0    （最危险）
 *   h=90          -> θ=90   （不刺眼）
 *   ΔA=180        -> θ=180  （无影响）
 *   ΔA=90,  h=0   -> θ=90
 *
 * @param sunElevation 太阳高度角（度）
 * @param deltaAzimuth 太阳方位角与车头朝向的夹角（度），应为 [0,180]
 */
export function offAxisAngle(sunElevation: number, deltaAzimuth: number): number {
  const c = Math.cos(sunElevation * DEG) * Math.cos(deltaAzimuth * DEG);
  return Math.acos(Math.max(-1, Math.min(1, c))) * RAD;
}

/**
 * 角度权重 —— 偏离视线轴越远，眩光衰减越快。
 * 采用类 Holladay 的衰减形式，衰减指数 1.6。
 *
 * 关键锚点：θ = 15° 时权重恰为 0.5，即「偏离 15° 时刺眼程度减半」。
 */
export function angleWeight(theta: number): number {
  return 1 / (1 + (theta / GLARE_THETA0) ** GLARE_P);
}

/**
 * 太阳高度角因子 —— **只承担残余的大气散射修正**。
 *
 * ⚠️ 不要把几何影响放进来：太阳高度角对眩光的几何影响**已经完整包含在
 *    离轴角 θ 中**（θ 由 h 与 ΔA 共同决定）。重复施加会导致非单调与死档。
 *
 * 采用线性衰减，保证严格单调递减：
 *   h <= 0    -> 0      （地平线下，无直射光）
 *   h = 0.5   -> 1.0    （刚出地平线，大气路径最长，散射与红移最强）
 *   h = 60    -> 0.2    （保底值，天顶散射光）
 */
export function sunFactor(sunElevation: number): number {
  if (sunElevation <= 0) return 0;
  if (sunElevation >= 60) return 0.2;
  const v = 1 - (0.8 * (sunElevation - 0.5)) / 59.5;
  return Math.max(0.2, Math.min(1, v));
}

/** 天气因子 —— 见 PRD F7。云量越高，风险越低 */
export const WEATHER_FACTORS = {
  clear: 1.0,
  mostlyClear: 0.85,
  partlyCloudy: 0.55,
  overcast: 0.25,
  precipitation: 0.15,
} as const;

export interface RiskScoreInput {
  /** 太阳高度角（度） */
  sunElevation: number;
  /** 太阳方位角与车头朝向的夹角（度） */
  deltaAzimuth: number;
  /** 天气衰减系数，默认 1.0（晴） */
  weatherFactor?: number;
  /** 地物遮挡系数，MVP 恒为 1（不做遮挡建模，见 PRD 约束 C3） */
  shadeFactor?: number;
  /** 坡度修正系数，MVP 恒为 1（无高程数据，见 PRD 约束 C2） */
  terrainFactor?: number;
}

/**
 * 风险分数 0–100。
 *
 *   R = 100 · wAngle(θ) · fSun(h) · fWeather · fShade · fTerrain
 *
 * 校准表（正对太阳 ΔA=0，即 θ=h）—— 实现后必须逐行复现（容差 ±0.2）：
 *   h= 0.5° ->  99.6 极高      h=10°  ->  57.3 中
 *   h= 1°   ->  98.0 极高      h=15°  ->  40.3 中
 *   h= 2°   ->  94.2 极高      h=20°  ->  28.5 低
 *   h= 3°   ->  89.8 极高      h=30°  ->  15.0 低
 *   h= 5°   ->  80.1 极高      h=45°  ->   5.9 低
 *   h= 7°   ->  70.4 高        h=60°  ->   2.0 低
 *   h=80°   ->   1.3 低
 *
 * 必须由单测守护的性质：
 *   - 正对太阳时 R 随 h 严格单调递减
 *   - 「极高」可达（h <= 5° 且方向正对）
 *   - h >= 20° 时即使正对也不超过「中」
 *   - h <= 0 时 R 恒为 0
 */
export function riskScore(input: RiskScoreInput): number {
  const {
    sunElevation,
    deltaAzimuth,
    weatherFactor = 1,
    shadeFactor = 1,
    terrainFactor = 1,
  } = input;

  // 地平线下：无直射光。硬性归零，保证夜间计算绝对为 0
  if (sunElevation <= 0) return 0;
  if (weatherFactor <= 0 || shadeFactor <= 0 || terrainFactor <= 0) return 0;

  const theta = offAxisAngle(sunElevation, deltaAzimuth);
  const r =
    100 * angleWeight(theta) * sunFactor(sunElevation) *
    weatherFactor * shadeFactor * terrainFactor;

  return Math.max(0, Math.min(100, r));
}

/** 把风险分数映射为等级（PRD 6.6） */
export function riskLevel(score: number): RiskLevel {
  if (score >= RISK_THRESHOLDS.extreme) return '极高';
  if (score >= RISK_THRESHOLDS.high) return '高';
  if (score >= RISK_THRESHOLDS.medium) return '中';
  return '低';
}

/** 等级排序值，便于比较与排序 */
export const RISK_LEVEL_ORDER: Record<RiskLevel, number> = {
  低: 0,
  中: 1,
  高: 2,
  极高: 3,
};

/** 等级配色（PRD F4）。深红/红/橙/蓝，且配合图例文字，不单靠颜色传达 */
export const RISK_LEVEL_COLORS: Record<RiskLevel, string> = {
  低: '#4A90D9',
  中: '#F5A623',
  高: '#E02020',
  极高: '#8B0000',
};

/**
 * 用户可读的一句话建议（PRD F5 的清单文案）
 */
export function riskAdvice(level: RiskLevel, road: string, offAxis: number): string {
  const where = road || '未命名路段';
  const axis = offAxis <= 5 ? '几乎正对太阳' : offAxis <= 20 ? '太阳偏在前方' : '太阳在前侧方';
  switch (level) {
    case '极高':
      return `${where} ${axis}（离轴角 ${offAxis.toFixed(1)}°），严重致盲风险，建议避开该时段`;
    case '高':
      return `${where} ${axis}（离轴角 ${offAxis.toFixed(1)}°），建议佩戴偏光墨镜`;
    case '中':
      return `${where} ${axis}，可能感到轻微刺眼`;
    default:
      return `${where} 基本无影响`;
  }
}
