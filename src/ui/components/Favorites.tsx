/**
 * 常用路线（PRD F9）
 *
 * 纯本地存储，无账号体系。空状态不占位 —— 没有收藏时整块不渲染，
 * 避免新用户看到一个空列表。
 */

import type { FavoriteRoute } from '@/ui/useFavorites.js';

interface FavoritesProps {
  favorites: readonly FavoriteRoute[];
  onApply: (f: FavoriteRoute) => void;
  onRemove: (id: string) => void;
  unavailable: boolean;
}

export function Favorites({ favorites, onApply, onRemove, unavailable }: FavoritesProps) {
  if (unavailable || favorites.length === 0) return null;

  return (
    <div className="section">
      <h3 className="section__title">
        常用路线
        <span className="section__count">共 {favorites.length} 条</span>
      </h3>

      {favorites.map((f) => (
        <div className="favorite" key={f.id}>
          <button
            type="button"
            className="favorite__apply"
            onClick={() => onApply(f)}
            title="用这条路线重新分析"
          >
            <span className="favorite__line">
              {shorten(f.origin.label)} → {shorten(f.destination.label)}
            </span>
          </button>
          <button
            type="button"
            className="favorite__remove"
            onClick={() => onRemove(f.id)}
            aria-label={`删除收藏 ${f.origin.label} 到 ${f.destination.label}`}
            title="删除"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** 地址太长会撑破侧栏，截断保留头尾信息 */
export function shorten(label: string, max = 14): string {
  if (label.length <= max) return label;
  return `${label.slice(0, max - 1)}…`;
}
