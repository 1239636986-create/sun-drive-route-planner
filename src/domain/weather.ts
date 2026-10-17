/**
 * 天气叠加（PRD F7）
 *
 * 作用：阴雨天太阳被云层遮挡，逆光风险显著下降。若不处理，用户会在阴天
 * 看到一堆「高风险」报警，产品可信度受损。
 *
 * ── 接口事实（实测）────────────────────────────────────────────────────
 *  - 接口：`GET /v3/weather/weatherInfo?city=<adcode>&extensions=all`
 *  - 天气接口要的是 **adcode**，不是坐标。adcode 来自地理编码/逆地理编码。
 *  - 预报只覆盖 **4 天**（实测返回 4 个 casts）。
 *    所以「未来 7 天」的产品范围里，只有前 4 天能拿到真实天气；
 *    更远的日子必须降级为「未知」，而不是假装有数据。
 *
 * ── 已知简化（必须向用户说明）──────────────────────────────────────────
 *  整条路线只用一个天气因子（取行程中点所在城市的当日预报）。
 *  真实的远程出行会跨越多个气候区，但逐段取天气需要多次请求与配额，
 *  收益远不及成本。UI 上必须标注这是「单一城市的整体估计」。
 */

import type { WeatherFactor } from '@/domain/types.js';

/** 天气接口返回的单个预报日 */
export interface WeatherCast {
  date: string;
  week?: string;
  dayWeather: string;
  nightWeather: string;
  dayTemp: string;
  nightTemp: string;
  dayWind?: string;
  dayPower?: string;
}

export interface WeatherInfo {
  /** adcode 对应的城市/区名 */
  city: string;
  /** 命中的预报日 */
  cast: WeatherCast;
  /** 风险衰减系数 0–1 */
  factor: WeatherFactor;
  /** 人类可读的天气描述，用于 UI */
  description: string;
}

const RAIN_SNOW = ['雨', '雪', '冰雹', '雷'];
const OVERCAST = ['阴'];
const PARTLY = ['多云'];
const MOSTLY_CLEAR = ['晴间多云', '少云'];
const CLEAR = ['晴'];

/**
 * 把高德的天气文案映射为风险系数。
 *
 * 阈值来自 PRD F7 表：
 *   晴 / 云量 <25%  -> 1.0
 *   少云 / 25–50%   -> 0.85
 *   多云 / 50–75%   -> 0.55
 *   阴 / >75%       -> 0.25
 *   雨雪            -> 0.15
 *
 * 高德不直接给云量，只给文案，故按文案归类。
 * 未识别的文案一律**保守取 1.0** —— 宁可多报，不可漏报。
 */
export function weatherFactorFor(weatherText: string): WeatherFactor {
  const t = weatherText.trim();
  if (!t) return 1.0;

  /**
   * 判定顺序至关重要 —— **更具体的关键词必须排在更宽泛的前面**。
   *
   * 踩过的坑：`晴间多云` 同时包含 `晴` 与 `多云` 两个子串。
   * 若先判 `多云`，就会把「晴间多云」（实际接近晴，0.85）
   * 误判成「多云」（0.55），在晴天多报风险。
   * 同理 `阴转多云` 若先判 `多云` 会把阴天（0.25）误判为 0.55。
   *
   * 顺序依据：降水 > 阴 > 晴间多云/少云 > 多云 > 晴。
   * 「阴」排在「多云」前，是因为「阴」字一旦出现，说明云量已极高，
   * 而「多云」只是其中一部分描述。
   */

  // 1. 降水优先级最高：即使文案是「雷阵雨」也应判为降水
  if (RAIN_SNOW.some((k) => t.includes(k))) return 0.15;

  // 2. 霾/雾：太阳辐射被削弱，但不确定程度高。排在云量之前，
  //    因为「霾转多云」这类文案里霾的影响更主导
  if (t.includes('霾') || t.includes('雾')) return 0.5;

  // 3. 阴：云量 > 75%。必须早于「多云」判定
  if (OVERCAST.some((k) => t.includes(k))) return 0.25;

  // 4. 晴间多云 / 少云：云量 25–50%。必须早于「多云」判定，
  //    因为「晴间多云」含「多云」子串
  if (MOSTLY_CLEAR.some((k) => t.includes(k))) return 0.85;

  // 5. 多云：云量 50–75%
  if (PARTLY.some((k) => t.includes(k))) return 0.55;

  // 6. 晴：云量 < 25%
  if (CLEAR.some((k) => t.includes(k))) return 1.0;

  return 1.0;
}

/** 供 UI 展示的系数说明 */
export function weatherFactorLabel(factor: WeatherFactor): string {
  if (factor >= 1.0) return '晴天，无衰减';
  if (factor >= 0.85) return '少云，略有衰减';
  if (factor >= 0.55) return '多云，明显衰减';
  if (factor >= 0.25) return '阴天，大幅衰减';
  if (factor > 0.15) return '霾/雾，辐射削弱';
  return '雨雪，几乎无直射光';
}

/** 从 adcode 与日期挑出对应预报 */
export function pickCast(
  casts: readonly WeatherCast[],
  dateYmd: string,
): WeatherCast | null {
  return casts.find((c) => c.date === dateYmd) ?? null;
}

/** 把 Date 格式化为高德预报的 `YYYY-MM-DD` */
export function toYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface AmapWeatherResponse {
  status?: string;
  info?: string;
  infocode?: string;
  forecasts?: Array<{
    city?: string;
    adcode?: string;
    casts?: Array<{
      date?: string;
      week?: string;
      dayweather?: string;
      nightweather?: string;
      daytemp?: string;
      nighttemp?: string;
      daywind?: string;
      daypower?: string;
    }>;
  }>;
}

/** 解析高德天气响应为我们的 WeatherInfo。纯函数，便于测试 */
export function parseWeatherResponse(
  payload: AmapWeatherResponse,
  dateYmd: string,
  /** 出发小时（0–23）。高德把白天与夜间分开报，按此选择 */
  departHour: number,
): WeatherInfo | null {
  const f = payload.forecasts?.[0];
  if (!f?.casts?.length) return null;

  const raw = pickCast(
    f.casts
      .filter((c) => c.date)
      .map((c) => ({
        date: c.date!,
        week: c.week,
        dayWeather: c.dayweather ?? '',
        nightWeather: c.nightweather ?? '',
        dayTemp: c.daytemp ?? '',
        nightTemp: c.nighttemp ?? '',
        dayWind: c.daywind,
        dayPower: c.daypower,
      })),
    dateYmd,
  );
  if (!raw) return null;

  // 高德只把预报拆为「白天/夜间」，没有逐小时。
  // 6:00–18:00 视为白天，其余取夜间 —— 这是粗糙但可解释的近似。
  const isDay = departHour >= 6 && departHour < 18;
  const text = isDay ? raw.dayWeather : raw.nightWeather;

  return {
    city: f.city ?? '',
    cast: raw,
    factor: weatherFactorFor(text),
    description: text || '未知',
  };
}

/** 从地理编码结果里取 adcode */
export function adcodeFromGeocode(geocodes: unknown): string | null {
  if (!Array.isArray(geocodes) || geocodes.length === 0) return null;
  const first = geocodes[0] as { adcode?: unknown };
  return typeof first?.adcode === 'string' && first.adcode ? first.adcode : null;
}

/** 从逆地理编码结果里取 adcode */
export function adcodeFromRegeo(payload: unknown): string | null {
  const p = payload as { regeocode?: { addressComponent?: { adcode?: unknown } } };
  const a = p?.regeocode?.addressComponent?.adcode;
  return typeof a === 'string' && a ? a : null;
}
