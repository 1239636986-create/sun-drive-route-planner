/**
 * 地点搜索框 —— 接高德地理编码
 *
 * 为什么不用高德的「输入提示（autocomplete）」接口：
 *   那需要额外的 POI 搜索权限与配额，而 MVP 只需要「把用户输入变成坐标」。
 *   地理编码已经够用，且我们的 Key 已开通。
 *   实测：输入「北京市天安门」→ 返回「北京市东城区天安门」+ GCJ-02 坐标。
 *
 * 交互设计：不做实时联想（会放大配额消耗且引入防抖复杂度），
 * 改为「输入 + 回车/按钮 → 显示候选列表 → 点选」。
 */

import { useCallback, useRef, useState } from 'react';
import type { LonLat } from '@/domain/types.js';

export interface PlaceResult {
  lon: number;
  lat: number;
  /** 高德返回的格式化地址，如「北京市东城区天安门」 */
  formatted: string;
}

interface PlaceSearchProps {
  id: string;
  label: string;
  /** 当前已选地点，null 表示未选 */
  value: PlaceResult | null;
  onSelect: (place: PlaceResult) => void;
  /** 清除已选地点。显式回调，避免用「传回空 formatted」这种隐式约定 */
  onClear: () => void;
  disabled?: boolean;
}

/** 解析高德 geocode 响应的 location 字段（"lon,lat"） */
export function parseLocation(location: string | undefined): LonLat | null {
  if (!location) return null;
  const [lonStr, latStr] = location.split(',');
  const lon = Number.parseFloat(lonStr ?? '');
  const lat = Number.parseFloat(latStr ?? '');
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { lon, lat };
}

export function PlaceSearch({ id, label, value, onSelect, onClear, disabled }: PlaceSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 防止旧请求的结果覆盖新请求 */
  const seqRef = useRef(0);

  const search = useCallback(async () => {
    const q = query.trim();
    if (!q) return;

    const seq = ++seqRef.current;
    setBusy(true);
    setError(null);

    try {
      const url = new URL('/amap-api/v3/geocode/geo', window.location.origin);
      url.searchParams.set('address', q);
      url.searchParams.set('output', 'JSON');

      const res = await fetch(url.pathname + url.search);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const payload = (await res.json()) as {
        status?: string;
        info?: string;
        infocode?: string;
        geocodes?: Array<{ location?: string; formatted_address?: string }>;
      };

      // 竞态保护：期间又发起了新搜索则丢弃本次结果
      if (seq !== seqRef.current) return;

      if (payload.status !== '1') {
        setError(
          payload.infocode === '10001'
            ? '代理未注入凭据，请检查 .env 中的 AMAP_WEB_KEY'
            : `搜索失败：${payload.info ?? '未知错误'}`,
        );
        setResults([]);
        return;
      }

      const parsed: PlaceResult[] = [];
      for (const g of payload.geocodes ?? []) {
        const loc = parseLocation(g.location);
        if (loc) {
          parsed.push({ ...loc, formatted: g.formatted_address ?? q });
        }
      }

      setResults(parsed);
      if (parsed.length === 0) setError('没有找到匹配的地点，试试加上市名或区名');
      // 只有一个结果时直接选中，省一次点击
      if (parsed.length === 1) {
        onSelect(parsed[0]!);
        setResults([]);
        setQuery('');
      }
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(err instanceof Error ? `无法连接代理：${err.message}` : '搜索失败');
      setResults([]);
    } finally {
      if (seq === seqRef.current) setBusy(false);
    }
  }, [query, onSelect]);

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>

      {value ? (
        <div className="place-selected">
          <span className="place-selected__text" title={value.formatted}>
            {value.formatted}
          </span>
          <button
            type="button"
            className="place-selected__clear"
            onClick={() => {
              setQuery('');
              setResults([]);
              setError(null);
              onClear();
            }}
            aria-label="清除"
          >
            ×
          </button>
        </div>
      ) : (
        <>
          <div className="search-row">
            <input
              id={id}
              type="text"
              value={query}
              placeholder="输入地点，如 北京市天安门"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void search();
                }
              }}
              disabled={disabled || busy}
              autoComplete="off"
            />
            <button
              type="button"
              className="btn"
              style={{ width: 'auto', flexShrink: 0, padding: '7px 14px' }}
              onClick={() => void search()}
              disabled={disabled || busy || query.trim() === ''}
            >
              {busy ? '…' : '搜索'}
            </button>
          </div>

          {error && (
            <div className="field__hint" style={{ color: 'var(--risk-mid-text)' }}>
              {error}
            </div>
          )}

          {results.length > 0 && (
            <div className="search-results" role="listbox">
              {results.map((r, i) => (
                <button
                  key={`${r.lon},${r.lat},${i}`}
                  type="button"
                  className="search-result"
                  role="option"
                  aria-selected={false}
                  onClick={() => {
                    onSelect(r);
                    setResults([]);
                    setQuery('');
                  }}
                >
                  {r.formatted}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
