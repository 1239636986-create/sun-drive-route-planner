/**
 * 天气状态钩子 —— 把坐标变成风险衰减系数
 *
 * 链路：坐标 → 逆地理编码取 adcode → 天气接口 → 解析 → 系数
 *
 * 失败一律降级为「天气未知」（系数 1.0），**绝不让天气问题阻塞主流程**。
 * 逆光计算本身不依赖天气，天气只是修正项。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  adcodeFromRegeo,
  parseWeatherResponse,
  toYmd,
  weatherFactorLabel,
  type WeatherInfo,
} from '@/domain/weather.js';
import type { LonLat } from '@/domain/types.js';

export interface WeatherState {
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  info: WeatherInfo | null;
  /** 面向用户的原因说明，unavailable 时给出 */
  reason: string | null;
  /** 说明这是「单一城市估计」，UI 必须展示 */
  scopeNote: string;
}

const INITIAL: WeatherState = {
  status: 'idle',
  info: null,
  reason: null,
  scopeNote: '',
};

async function fetchJson(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.pathname + url.search);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useWeather() {
  const [state, setState] = useState<WeatherState>(INITIAL);

  /** 取路线中点所在城市的 adcode */
  const adcodeFor = useCallback(async (mid: LonLat): Promise<string | null> => {
    const payload = await fetchJson('/amap-api/v3/geocode/regeo', {
      location: `${mid.lon.toFixed(6)},${mid.lat.toFixed(6)}`,
      output: 'JSON',
    });
    return adcodeFromRegeo(payload);
  }, []);

  /**
   * 取指定地点在指定时刻的天气。
   *
   * `at` 既决定用哪一天的预报，也决定取「白天」还是「夜间」文案。
   * 因此它是一个**真实依赖**，不能被省略 —— 见下方 useWeatherForRoute 的说明。
   */
  const load = useCallback(
    async (mid: LonLat, at: Date) => {
      setState({ ...INITIAL, status: 'loading' });
      try {
        const adcode = await adcodeFor(mid);
        if (!adcode) {
          setState({
            ...INITIAL,
            status: 'unavailable',
            reason: '无法确定路线途经城市，天气未纳入计算',
          });
          return;
        }

        const payload = (await fetchJson('/amap-api/v3/weather/weatherInfo', {
          city: adcode,
          extensions: 'all',
          output: 'JSON',
        })) as { status?: string; info?: string; forecasts?: unknown[] };

        if (payload.status !== '1') {
          setState({
            ...INITIAL,
            status: 'unavailable',
            reason: `天气接口返回错误（${payload.info ?? '未知'}），未纳入计算`,
          });
          return;
        }

        const info = parseWeatherResponse(
          payload as never,
          toYmd(at),
          at.getHours(),
        );

        if (!info) {
          // 最常见原因：出发日期超出 4 天预报窗口
          setState({
            ...INITIAL,
            status: 'unavailable',
            reason: '该日期超出天气预报范围（高德仅提供 4 天），未纳入计算',
          });
          return;
        }

        setState({
          status: 'ready',
          info,
          reason: null,
          scopeNote: `按${info.city || '途经城市'}的当日预报估算，未逐段取天气`,
        });
      } catch (err) {
        setState({
          ...INITIAL,
          status: 'unavailable',
          reason: err instanceof Error ? `天气获取失败：${err.message}` : '天气获取失败',
        });
      }
    },
    [adcodeFor],
  );

  return { ...state, load, label: state.info ? weatherFactorLabel(state.info.factor) : null };
}

/** 只要系数，供风险计算使用。天气未知时返回 1.0（不衰减） */
export function factorOf(state: WeatherState): number {
  return state.info?.factor ?? 1.0;
}

/** 是否应该把天气纳入计算 */
export function isWeatherActive(state: WeatherState): boolean {
  return state.status === 'ready' && state.info !== null;
}

/** 供 UI 展示的一行摘要 */
export function weatherSummary(state: WeatherState): string {
  if (state.status === 'loading') return '正在获取天气…';
  if (state.status === 'ready' && state.info) {
    return `${state.info.description} · ${weatherFactorLabel(state.info.factor)}`;
  }
  if (state.status === 'unavailable') return state.reason ?? '天气不可用';
  return '天气未启用';
}

/**
 * 组合钩子：给一段路线与出发时刻，自动取天气。
 *
 * ── 重取时机（这里踩过坑）────────────────────────────────────────────
 * 依赖是「坐标 + 日期 + 昼夜」三者：
 *
 *   ① 日期变化 → 要换一份预报，**必须重取**
 *   ② 昼夜变化（当天 08:00 → 20:00）→ 高德把白天/夜间分开报，
 *      文案会不同（实测：北京当天白天「多云」、夜间「阴」），**必须重取**
 *   ③ 同一昼夜内的时刻微调（08:00 → 09:00）→ 预报粒度是天，**无意义，不重取**
 *
 * 早期版本只依赖日期，导致 ② 漏掉：用户把时刻拖到夜里，天气条仍显示白天文案。
 *
 * ⚠️ `at` 必须进依赖数组。它虽在闭包里，但 useEffect 只在依赖变化时
 *    重跑闭包 —— 依赖里没有 `at`，闭包捕获的就是**过期的那一次** `at`。
 *    这是典型的 stale closure，且当天内看不出来，跨天就错。
 */
export function useWeatherForRoute(mid: LonLat | null, at: Date) {
  const w = useWeather();
  const ymd = toYmd(at);
  const lon = mid?.lon;
  const lat = mid?.lat;
  // 6:00–18:00 视为白天，与 parseWeatherResponse 的判定保持一致
  const isDay = at.getHours() >= 6 && at.getHours() < 18;

  const load = w.load;
  useEffect(() => {
    if (lon === undefined || lat === undefined) return;
    void load({ lon, lat }, at);
  }, [lon, lat, ymd, isDay, load]); // at 是派生量，用 ymd + isDay 表达其变化

  return w;
}
