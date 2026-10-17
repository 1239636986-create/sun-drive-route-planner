/**
 * 收藏的常用路线（PRD F9）
 *
 * 只存 localStorage，不做账号体系（Q1 决策）。理由：
 *  - 避免采集用户位置与出行历史
 *  - MVP 无需后端，部署更简单
 *
 * 存储结构带版本号，便于将来迁移而不炸掉老数据。
 */

import { useCallback, useEffect, useState } from 'react';
import type { LonLat } from '@/domain/types.js';

const STORAGE_KEY = 'sunglare.routes.v1';
const MAX_FAVORITES = 20;

export interface FavoriteRoute {
  id: string;
  origin: LonLat & { label: string };
  destination: LonLat & { label: string };
  /** 最近一次使用的时间戳，用于排序 */
  usedAt: number;
}

interface StoredShape {
  version: 1;
  items: FavoriteRoute[];
}

/** 生成稳定 id —— 同一组起终点应视为同一条收藏 */
export function favoriteId(origin: LonLat, destination: LonLat): string {
  const r = (n: number) => n.toFixed(5);
  return `${r(origin.lon)},${r(origin.lat)}->${r(destination.lon)},${r(destination.lat)}`;
}

/**
 * 从任意输入解析出收藏列表。
 * 对损坏数据一律降级为空列表 —— 收藏是锦上添花，绝不能因数据损坏让页面崩溃。
 */
export function parseFavorites(raw: string | null): FavoriteRoute[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as StoredShape).items)
    ) {
      return [];
    }
    return (parsed as StoredShape).items.filter(isValidFavorite).slice(0, MAX_FAVORITES);
  } catch {
    return [];
  }
}

function isValidFavorite(v: unknown): v is FavoriteRoute {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as FavoriteRoute;
  return (
    typeof f.id === 'string' &&
    typeof f.usedAt === 'number' &&
    isLonLatLabel(f.origin) &&
    isLonLatLabel(f.destination)
  );
}

function isLonLatLabel(v: unknown): v is LonLat & { label: string } {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as LonLat & { label: string };
  return (
    Number.isFinite(p.lon) &&
    Number.isFinite(p.lat) &&
    typeof p.label === 'string' &&
    p.label.length > 0
  );
}

/** 往列表里插入或更新一条收藏，返回新列表（纯函数，便于测试） */
export function upsertFavorite(
  list: readonly FavoriteRoute[],
  entry: Omit<FavoriteRoute, 'usedAt'> & { usedAt?: number },
): FavoriteRoute[] {
  const item: FavoriteRoute = { ...entry, usedAt: entry.usedAt ?? Date.now() };
  const rest = list.filter((f) => f.id !== item.id);
  return [item, ...rest]
    .sort((a, b) => b.usedAt - a.usedAt)
    .slice(0, MAX_FAVORITES);
}

export interface UseFavorites {
  favorites: FavoriteRoute[];
  save: (f: Omit<FavoriteRoute, 'id' | 'usedAt'>) => void;
  remove: (id: string) => void;
  clearAll: () => void;
  /** localStorage 不可用（隐私模式等）时为 true */
  unavailable: boolean;
}

export function useFavorites(): UseFavorites {
  const [favorites, setFavorites] = useState<FavoriteRoute[]>([]);
  const [unavailable, setUnavailable] = useState(false);

  // 首次读取
  useEffect(() => {
    try {
      setFavorites(parseFavorites(window.localStorage.getItem(STORAGE_KEY)));
    } catch {
      // Safari 隐私模式下 localStorage 可能直接抛错
      setUnavailable(true);
    }
  }, []);

  const persist = useCallback((next: FavoriteRoute[]) => {
    setFavorites(next);
    try {
      const payload: StoredShape = { version: 1, items: next };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      setUnavailable(true);
    }
  }, []);

  const save = useCallback(
    (f: Omit<FavoriteRoute, 'id' | 'usedAt'>) => {
      setFavorites((prev) => {
        const next = upsertFavorite(prev, {
          id: favoriteId(f.origin, f.destination),
          origin: f.origin,
          destination: f.destination,
        });
        try {
          window.localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ version: 1, items: next } satisfies StoredShape),
          );
        } catch {
          setUnavailable(true);
        }
        return next;
      });
    },
    [],
  );

  const remove = useCallback(
    (id: string) => {
      setFavorites((prev) => {
        const next = prev.filter((f) => f.id !== id);
        try {
          window.localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ version: 1, items: next } satisfies StoredShape),
          );
        } catch {
          setUnavailable(true);
        }
        return next;
      });
    },
    [],
  );

  const clearAll = useCallback(() => {
    persist([]);
  }, [persist]);

  return { favorites, save, remove, clearAll, unavailable };
}
