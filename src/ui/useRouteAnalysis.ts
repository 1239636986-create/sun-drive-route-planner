/**
 * 路线分析状态钩子
 *
 * 把 M1 验证过的算法层串成一条流水线：
 *   AmapProvider → computeSegmentRisks → mergeByRoad → optimizeDeparture
 *
 * 设计要点：
 *  - 风险计算（拖动时间/换时刻）与路线获取分离：路线只取一次，之后都在本地算
 *  - 所有派生结果用 useMemo，避免重复计算（实测单次仿真约 20ms）
 *  - 错误分类明确：代理未配置 / 网络失败 / 高德业务错误，给出不同引导
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AmapProvider, AmapError } from '@/providers/amapProvider.js';
import { probeProxy } from '@/api/client.js';
import {
  computeSegmentRisks,
  mergeByRoad,
  riskDistribution,
  sortWindows,
} from '@/domain/riskAggregator.js';
import { optimizeDeparture, worstSegment } from '@/domain/departureOptimizer.js';
import type {
  DeparturePlan,
  LonLat,
  RiskLevel,
  Route,
  SegmentRisk,
} from '@/domain/types.js';

/** 代理就绪状态 */
export type ProxyStatus =
  | { state: 'checking' }
  | { state: 'ready' }
  | { state: 'unavailable'; reason: string };

/** 分析阶段 */
export type AnalysisStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface AnalysisError {
  /** 可操作的标题 */
  title: string;
  /** 解释与下一步动作 */
  detail: string;
  /** 原始错误码，便于排查 */
  code?: string;
}

export interface UseRouteAnalysis {
  proxy: ProxyStatus;

  /** 当前分析用的起终点（用于「保存为常用路线」） */
  currentRoute: { origin: LonLat; destination: LonLat } | null;

  status: AnalysisStatus;
  error: AnalysisError | null;

  route: Route | null;

  /** 当前预览时刻（时间滑杆） */
  previewAt: Date;
  setPreviewAt: (d: Date) => void;

  /** 当前时刻下的分段风险 */
  segments: SegmentRisk[];
  /** 按路名聚合的高风险清单（F5），默认含「中」以上 */
  windows: ReturnType<typeof mergeByRoad>;
  /** 各等级里程占比 */
  distribution: Record<RiskLevel, number>;
  /** 最严重的一段 */
  worst: SegmentRisk | null;

  /** 到达时段（F6 的硬约束输入） */
  arrival: { from: string; to: string };
  setArrival: (v: { from: string; to: string }) => void;

  /** 出发优化结果。为 null 表示未计算或约束不满足 */
  plan: DeparturePlan | null;
  planError: string | null;

  /** 触发路线分析 */
  analyze: (origin: LonLat, destination: LonLat) => Promise<void>;

  /** 天气衰减系数。天气未知时恒为 1.0 */
  weatherFactor: number;
  setWeatherFactor: (f: number) => void;
}

/**
 * 从到达时段字符串算出出发计划。纯函数，便于测试。
 *
 * 之前这段逻辑内联在 useCallback 里，无法单测 —— 而正是它藏了一个
 * 「天气变化后不重算」的缺陷。抽出来之后，重算触发条件可以单独验证。
 */
export function computePlan(
  route: Route,
  arrival: { from: string; to: string },
  weatherFactor: number,
  baseDate: Date,
  earliestDepartAt?: Date,
): { plan: DeparturePlan | null; error: string | null } {
  const from = parseHHmm(arrival.from);
  const to = parseHHmm(arrival.to);
  if (!from || !to) {
    return { plan: null, error: '到达时段格式无效，请使用 HH:mm' };
  }

  let result: DeparturePlan;
  try {
    result = optimizeDeparture({
      route,
      arrival: { from, to },
      baseDate,
      weatherFactor,
      ...(earliestDepartAt ? { earliestDepartAt } : {}),
    });
  } catch (err) {
    return { plan: null, error: err instanceof Error ? err.message : '出发优化失败' };
  }

  if (result.candidates.length === 0) {
    return {
      plan: null,
      error:
        `在「${arrival.from} – ${arrival.to}」内无法安排行程：` +
        `这段路需约 ${(route.duration / 60000).toFixed(0)} 分钟，` +
        `而该时段太短或已过去。请放宽到达时段。`,
    };
  }

  return { plan: result, error: null };
}

/** 把 "HH:mm" 解析为 {hour, minute} */
export function parseHHmm(v: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** 当天 00:00（本地时区）—— F6 用它解析到达时段的日期 */
export function todayMidnight(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 默认预览时刻：取「今天日出后约 1 小时」，因为那是最典型的危险时段 */
function defaultPreviewTime(): Date {
  const d = new Date();
  d.setHours(7, 0, 0, 0);
  return d;
}

export function useRouteAnalysis(): UseRouteAnalysis {
  const [proxy, setProxy] = useState<ProxyStatus>({ state: 'checking' });
  const [status, setStatus] = useState<AnalysisStatus>('idle');
  const [error, setError] = useState<AnalysisError | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [currentRoute, setCurrentRoute] = useState<{ origin: LonLat; destination: LonLat } | null>(
    null,
  );
  const [weatherFactor, setWeatherFactor] = useState(1);
  /** 防止快速重新规划时旧请求覆盖新请求 */
  const analyzeSeq = useRef(0);

  const [previewAt, setPreviewAt] = useState<Date>(defaultPreviewTime);
  const [arrival, setArrival] = useState({ from: '17:00', to: '20:00' });
  const [plan, setPlan] = useState<DeparturePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);

  // 代理探测：一次即可。比白屏好的错误提示靠它
  useEffect(() => {
    let alive = true;
    probeProxy().then((r) => {
      if (!alive) return;
      setProxy(r.ok ? { state: 'ready' } : { state: 'unavailable', reason: r.reason });
    });
    return () => {
      alive = false;
    };
  }, []);

  const analyze = useCallback(async (origin: LonLat, destination: LonLat) => {
    const seq = ++analyzeSeq.current;
    setStatus('loading');
    setError(null);
    setPlan(null);
    setPlanError(null);

    try {
      // 代理架构下前端不持有密钥 —— 不传 apiKey，凭据由代理注入
      const provider = new AmapProvider({ baseUrl: '/amap-api' });
      const r = await provider.getRoute(origin, destination);
      // 旧请求完成后直接丢弃，不允许覆盖用户最新选择
      if (seq !== analyzeSeq.current) return;

      if (r.segments.length === 0) {
        setRoute(null);
        setStatus('error');
        setError({
          title: '路线不含有效折线',
          detail: '高德返回的路线没有可用于计算的坐标点，请换一组起终点重试。',
        });
        return;
      }

      setRoute(r);
      setCurrentRoute({ origin, destination });
      setStatus('ready');

      // 保留用户当前预览时刻：重新规划路线不应悄悄改掉用户选好的时间。
    } catch (err) {
      if (seq !== analyzeSeq.current) return;
      setRoute(null);
      setCurrentRoute(null);
      setStatus('error');
      setError(toAnalysisError(err));
    }
    // previewAt 刻意不入依赖：它只用于校正日期，不应触发重新取路线
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- 派生结果：当前预览时刻下的风险 ---
  const segments = useMemo<SegmentRisk[]>(
    () =>
      route
        ? computeSegmentRisks(route, { departAt: previewAt, weatherFactor })
        : [],
    [route, previewAt, weatherFactor],
  );

  const windows = useMemo(() => sortWindows(mergeByRoad(segments, '中')), [segments]);
  const distribution = useMemo(() => riskDistribution(segments), [segments]);
  const worst = useMemo(() => worstSegment(segments), [segments]);

  // --- 派生结果：出发优化（F6）---
  // 两阶段搜索约 150 次仿真，不宜每次渲染都跑，故用 effect 显式触发
  const runPlan = useCallback(() => {
    if (!route) return;
    const { plan: p, error: e } = computePlan(route, arrival, weatherFactor, todayMidnight());
    setPlan(p);
    setPlanError(e);
  }, [route, arrival, weatherFactor]);

  /**
   * 到达时段**或天气系数**变化时重算出发方案。
   *
   * ⚠️ 踩过的坑：早期这里写的是 `}, [arrival.from, arrival.to]);` ——
   *    `runPlan` 的依赖里有 weatherFactor，但这个 effect 不看它，
   *    于是一旦天气系数在路线之后才到达（异步天气请求就是这种情况），
   *    出发方案会**永远停留在无天气的结果**上。
   *    症状很隐蔽：候选方案用新系数算出峰值 0，而危险窗口还挂着旧系数下的
   *    峰值 98 —— 同一屏上自相矛盾。
   *
   *    修法：依赖 runPlan 本身（它是 useCallback，已正确包含 weatherFactor）。
   *    这比逐个罗列依赖更不容易漏。
   */
  useEffect(() => {
    if (route) runPlan();
  }, [route, runPlan]);

  return {
    proxy,
    currentRoute,
    status,
    error,
    route,
    previewAt,
    setPreviewAt,
    segments,
    windows,
    distribution,
    worst,
    arrival,
    setArrival,
    plan,
    planError,
    analyze,
    weatherFactor,
    setWeatherFactor,
  };
}

/** 把各类异常翻译成用户能照着做的提示 */
function toAnalysisError(err: unknown): AnalysisError {
  if (err instanceof AmapError) {
    if (err.infocode === '10001') {
      return {
        title: '高德拒绝了这个请求（凭据无效）',
        detail:
          '反向代理似乎没有成功注入凭据。请检查 .env 里的 AMAP_WEB_KEY，' +
          '以及 vite.config.ts 的 /amap-api 代理配置。',
        code: err.infocode,
      };
    }
    if (err.infocode === '10003' || err.infocode === '10044') {
      return {
        title: '高德配额已用尽',
        detail: '今日调用量已达上限，请明天再试，或在控制台提升配额。',
        code: err.infocode,
      };
    }
    return { title: '高德返回错误', detail: err.message, code: err.infocode };
  }

  if (err instanceof TypeError) {
    return {
      title: '无法连接代理',
      detail:
        '请求 /amap-api 失败。若你是用构建产物直接打开的静态文件，' +
        '反向代理不会生效 —— 请用 npm run dev，或部署到配有反向代理的环境。',
    };
  }

  return {
    title: '分析失败',
    detail: err instanceof Error ? err.message : String(err),
  };
}
