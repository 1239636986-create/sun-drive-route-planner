import { useCallback, useEffect, useMemo, useState } from 'react';
import { MapView } from './MapView.js';
import { RiskSummary } from './components/RiskSummary.js';
import { RiskList } from './components/RiskList.js';
import { DeparturePlanner } from './components/DeparturePlanner.js';
import { Disclaimer } from './components/Disclaimer.js';
import { PlaceSearch, type PlaceResult } from './components/PlaceSearch.js';
import { Favorites } from './components/Favorites.js';
import { useRouteAnalysis } from './useRouteAnalysis.js';
import { useFavorites, favoriteId } from './useFavorites.js';
import {
  useWeatherForRoute,
  weatherSummary,
  factorOf,
  isWeatherActive,
} from './useWeather.js';
import { weatherFactorLabel } from '@/domain/weather.js';
import { DEFAULT_TILE_SOURCE, TILE_SOURCE_LIST, SAMPLE_ROUTE } from './layerConfig.js';
import type { LonLat, RiskWindow } from '@/domain/types.js';

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 行程中点 —— 用于取天气 */
function midOf(a: LonLat, b: LonLat): LonLat {
  return { lon: (a.lon + b.lon) / 2, lat: (a.lat + b.lat) / 2 };
}

const SAMPLE_ORIGIN: PlaceResult = {
  ...SAMPLE_ROUTE.origin,
  formatted: SAMPLE_ROUTE.originLabel,
};
const SAMPLE_DEST: PlaceResult = {
  ...SAMPLE_ROUTE.destination,
  formatted: SAMPLE_ROUTE.destinationLabel,
};

export default function App() {
  const a = useRouteAnalysis();
  const fav = useFavorites();
  const [selectedWindow, setSelectedWindow] = useState<RiskWindow | null>(null);
  const [tileSource, setTileSource] = useState(DEFAULT_TILE_SOURCE);
  const [weatherEnabled, setWeatherEnabled] = useState(true);

  // 起终点：默认用示例路线，让用户一进来就能看到结论
  const [origin, setOrigin] = useState<PlaceResult | null>(SAMPLE_ORIGIN);
  const [destination, setDestination] = useState<PlaceResult | null>(SAMPLE_DEST);
  /** 途径点槽位（按途经顺序；null 表示已添加但未选地点）。UI 上限 8 */
  const [waypoints, setWaypoints] = useState<Array<PlaceResult | null>>([]);
  const [showForm, setShowForm] = useState(false);

  const MAX_WAYPOINTS = 8;
  const filledWaypoints = useMemo(
    () => waypoints.filter((w): w is PlaceResult => w !== null),
    [waypoints],
  );

  // 天气：按行程中点 + 出发日期取
  const weatherMid = useMemo(
    () => (origin && destination ? midOf(origin, destination) : null),
    [origin, destination],
  );
  const weather = useWeatherForRoute(weatherMid, a.previewAt);

  // 把天气系数推给风险计算。关掉开关即恢复 1.0
  useEffect(() => {
    a.setWeatherFactor(weatherEnabled && isWeatherActive(weather) ? factorOf(weather) : 1);
    // a.setWeatherFactor 是稳定引用；不把整个 a 放进依赖以免抖动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weatherEnabled, weather.status, weather.info?.factor]);

  // 进入页面跑一次示例路线
  useEffect(() => {
    void a.analyze(SAMPLE_ROUTE.origin, SAMPLE_ROUTE.destination);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const highlightIndices = useMemo(() => {
    if (!selectedWindow) return undefined;
    return new Set(selectedWindow.segments.map((s) => s.index));
  }, [selectedWindow]);

  useEffect(() => {
    setSelectedWindow(null);
  }, [a.previewAt]);

  /** 起终点都选好后就分析（未选地点的途径点槽位会跳过） */
  const runAnalysis = useCallback(
    (o: PlaceResult | null, d: PlaceResult | null, vias: Array<PlaceResult | null> = []) => {
      if (!o || !d) return;
      const filled = vias.filter((w): w is PlaceResult => w !== null);
      void a.analyze(o, d, filled);
    },
    [a],
  );

  const applyFavorite = useCallback(
    (f: { origin: LonLat & { label: string }; destination: LonLat & { label: string } }) => {
      const o: PlaceResult = { lon: f.origin.lon, lat: f.origin.lat, formatted: f.origin.label };
      const d: PlaceResult = {
        lon: f.destination.lon,
        lat: f.destination.lat,
        formatted: f.destination.label,
      };
      setOrigin(o);
      setDestination(d);
      setWaypoints([]);
      setShowForm(false);
      runAnalysis(o, d, []);
    },
    [runAnalysis],
  );

  const saveCurrent = useCallback(() => {
    if (!origin || !destination) return;
    fav.save({
      origin: { lon: origin.lon, lat: origin.lat, label: origin.formatted },
      destination: { lon: destination.lon, lat: destination.lat, label: destination.formatted },
    });
  }, [fav, origin, destination]);

  const addWaypointSlot = useCallback(() => {
    setShowForm(true);
    setWaypoints((prev) => (prev.length >= MAX_WAYPOINTS ? prev : [...prev, null]));
  }, []);

  const canAnalyze = origin !== null && destination !== null;
  const loading = a.status === 'loading';
  const activeTile = TILE_SOURCE_LIST.find((t) => t.id === tileSource);

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar__header">
          <h1 className="sidebar__title">阳光驾驶路线</h1>
          <p className="sidebar__subtitle">出发前看清逆光路段、危险时刻和建议出发时间</p>
          <p className="sidebar__build" aria-label="当前版本标记">
            版本标记：粗线绿黄红 · 途径点 · 端口 5299
          </p>
        </header>

        <div className="sidebar__body">
          {a.proxy.state === 'unavailable' && (
            <div className="verdict verdict--warn">
              <span className="verdict__icon" aria-hidden="true">⚠</span>
              <div className="verdict__text">
                <div className="verdict__headline">API 代理不可用</div>
                <div className="verdict__detail">{a.proxy.reason}</div>
              </div>
            </div>
          )}

          {/* ---- 路线 ---- */}
          <div className="route-summary">
            <div className="route-summary__points">
              <div className="route-summary__point">
                <span className="route-summary__dot route-summary__dot--from" />
                {origin?.formatted ?? '未设置起点'}
              </div>
              {filledWaypoints.map((wp, i) => (
                <div key={`via-sum-${i}`}>
                  <div className="route-summary__arrow">↓</div>
                  <div className="route-summary__point">
                    <span className="route-summary__dot route-summary__dot--via" />
                    <span className="route-summary__via-label">途{i + 1}</span>
                    {wp.formatted}
                  </div>
                </div>
              ))}
              <div className="route-summary__arrow">↓</div>
              <div className="route-summary__point">
                <span className="route-summary__dot route-summary__dot--to" />
                {destination?.formatted ?? '未设置终点'}
              </div>
            </div>
            <div className="route-summary__stats">
              {a.route ? (
                <>
                  <div className="route-summary__distance mono">
                    {(a.route.distance / 1000).toFixed(1)} km
                  </div>
                  <div className="route-summary__duration mono">
                    约 {(a.route.duration / 60000).toFixed(0)} 分钟
                  </div>
                </>
              ) : (
                <div className="route-summary__duration">—</div>
              )}
            </div>
          </div>

          <div className="btn-row">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                if (!origin || !destination) return;
                const nextOrigin = destination;
                const nextDestination = origin;
                const nextVias = [...waypoints].reverse();
                setOrigin(nextOrigin);
                setDestination(nextDestination);
                setWaypoints(nextVias);
                runAnalysis(nextOrigin, nextDestination, nextVias);
              }}
              disabled={!canAnalyze || loading}
              title="交换起点和终点，规划返程（途径点顺序同步反转）"
            >
              ⇄ 返程
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setShowForm((v) => !v)}
              aria-expanded={showForm}
            >
              {showForm ? '收起' : '修改路线'}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={addWaypointSlot}
              disabled={waypoints.length >= MAX_WAYPOINTS || loading}
              title={
                waypoints.length >= MAX_WAYPOINTS
                  ? `最多 ${MAX_WAYPOINTS} 个途径点`
                  : '在起终点之间增加途径点'
              }
            >
              ＋ 途径点
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={saveCurrent}
              disabled={!canAnalyze || fav.unavailable}
              title={fav.unavailable ? '当前浏览器不支持本地存储' : '收藏这条路线'}
            >
              ☆ 收藏
            </button>
          </div>

          {showForm && (
            <div className="card" style={{ marginBottom: 16 }}>
              <PlaceSearch
                id="origin"
                label="起点"
                value={origin}
                onSelect={(p) => setOrigin(p)}
                onClear={() => setOrigin(null)}
              />
              {waypoints.map((wp, i) => (
                <div key={`via-edit-${i}`} className="waypoint-row">
                  <PlaceSearch
                    id={`waypoint-${i}`}
                    label={`途径点 ${i + 1}`}
                    value={wp}
                    onSelect={(p) =>
                      setWaypoints((prev) => prev.map((x, j) => (j === i ? p : x)))
                    }
                    onClear={() =>
                      setWaypoints((prev) => prev.map((x, j) => (j === i ? null : x)))
                    }
                  />
                  <button
                    type="button"
                    className="btn btn--ghost waypoint-row__remove"
                    onClick={() => setWaypoints((prev) => prev.filter((_, j) => j !== i))}
                    aria-label={`删除途径点 ${i + 1}`}
                  >
                    删除
                  </button>
                </div>
              ))}
              {waypoints.length < MAX_WAYPOINTS && (
                <button
                  type="button"
                  className="btn btn--ghost"
                  style={{ width: 'auto', marginBottom: 12 }}
                  onClick={addWaypointSlot}
                >
                  ＋ 添加途径点
                </button>
              )}
              <PlaceSearch
                id="destination"
                label="终点"
                value={destination}
                onSelect={(p) => setDestination(p)}
                onClear={() => setDestination(null)}
              />
              <button
                type="button"
                className="btn"
                onClick={() => {
                  runAnalysis(origin, destination, waypoints);
                  setShowForm(false);
                }}
                disabled={!canAnalyze || loading}
              >
                {loading ? '计算中…' : '开始分析'}
              </button>
            </div>
          )}

          <Favorites
            favorites={fav.favorites}
            onApply={applyFavorite}
            onRemove={fav.remove}
            unavailable={fav.unavailable}
          />

          {loading && (
            <div className="loading">
              <span className="spinner" />
              正在获取路线并计算逆光风险…
            </div>
          )}

          {a.status === 'error' && a.error && (
            <div className="verdict verdict--warn">
              <span className="verdict__icon" aria-hidden="true">✕</span>
              <div className="verdict__text">
                <div className="verdict__headline">{a.error.title}</div>
                <div className="verdict__detail">{a.error.detail}</div>
                {a.error.code && <code className="map-error__code">错误码 {a.error.code}</code>}
              </div>
            </div>
          )}

          {a.status === 'ready' && a.route && (
            <>
              {/* ---- 预览时刻 ---- */}
              <div className="field">
                <label className="field__label" htmlFor="preview-time">
                  预览出发时刻
                </label>
                <div className="time-range">
                  <input
                    id="preview-time"
                    type="time"
                    value={hhmm(a.previewAt)}
                    onChange={(e) => {
                      const [h, m] = e.target.value.split(':').map(Number);
                      if (h === undefined || m === undefined) return;
                      const d = new Date(a.previewAt);
                      d.setHours(h, m, 0, 0);
                      a.setPreviewAt(d);
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn--ghost"
                    style={{ width: 'auto', flexShrink: 0 }}
                    onClick={() => {
                      const d = new Date(a.previewAt);
                      d.setHours(d.getHours() + 1);
                      a.setPreviewAt(d);
                    }}
                  >
                    +1h
                  </button>
                </div>

                {/* 拖一下就能看出风险随时刻怎么变 */}
                <input
                  className="slider"
                  type="range"
                  min={0}
                  max={95}
                  step={5}
                  value={a.previewAt.getHours() * 4 + Math.floor(a.previewAt.getMinutes() / 15)}
                  onChange={(e) => {
                    const q = Number(e.target.value);
                    const d = new Date(a.previewAt);
                    d.setHours(Math.floor(q / 4), (q % 4) * 15, 0, 0);
                    a.setPreviewAt(d);
                  }}
                  aria-label="按 15 分钟步长预览出发时刻"
                />
                <div className="slider-scale faint">
                  <span>00:00</span>
                  <span>12:00</span>
                  <span>23:45</span>
                </div>
              </div>

              {/* ---- 天气 ---- */}
              <div className="weather-bar">
                <label className="weather-bar__toggle">
                  <input
                    type="checkbox"
                    checked={weatherEnabled}
                    onChange={(e) => setWeatherEnabled(e.target.checked)}
                  />
                  <span>纳入天气</span>
                </label>
                <div className="weather-bar__text">
                  {weatherEnabled ? weatherSummary(weather) : '已关闭，按晴天计算'}
                </div>
              </div>
              {weatherEnabled && weather.scopeNote && (
                <div className="field__hint" style={{ marginTop: -6, marginBottom: 12 }}>
                  {weather.scopeNote}
                </div>
              )}

              <RiskSummary
                distribution={a.distribution}
                worst={a.worst}
                windowCount={a.windows.length}
                totalSegments={a.segments.length}
                previewAt={a.previewAt}
                weatherNote={
                  weatherEnabled && isWeatherActive(weather) && weather.info
                    ? `${weather.info.description}，${weatherFactorLabel(weather.info.factor)}`
                    : null
                }
              />

              <RiskList
                windows={a.windows}
                selectedRoad={selectedWindow?.road ?? null}
                onSelect={setSelectedWindow}
                previewAt={a.previewAt}
              />

              <DeparturePlanner
                arrival={a.arrival}
                onArrivalChange={a.setArrival}
                plan={a.plan}
                planError={a.planError}
                onPreview={a.setPreviewAt}
                routeDurationMs={a.route.duration}
              />

              <Disclaimer />
            </>
          )}

          {/* ---- 底图切换（放在最后，不干扰主流程）---- */}
          <div className="section" style={{ marginTop: 20 }}>
            <h3 className="section__title">底图</h3>
            <select
              value={tileSource}
              onChange={(e) => setTileSource(e.target.value)}
              aria-label="选择底图瓦片源"
            >
              {TILE_SOURCE_LIST.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                  {t.crs === 'WGS-84' ? '（需坐标转换）' : ''}
                </option>
              ))}
            </select>
            {activeTile?.caveat && (
              <div className="field__hint">{activeTile.caveat}</div>
            )}
          </div>
        </div>
      </aside>

      <MapView
        segments={a.segments}
        highlightIndices={highlightIndices}
        endpoints={
          origin && destination
            ? { from: origin, to: destination, waypoints: filledWaypoints }
            : null
        }
        tileSourceId={tileSource}
      />
    </div>
  );
}

/** 供测试引用，确认收藏 id 生成规则稳定 */
export { favoriteId };
