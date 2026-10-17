/**
 * 出发方案（PRD F6，v0.3 设计）
 *
 * 三件事必须做对，全部来自 M0 实测教训：
 *
 * ① 到达时段是**硬约束**输入
 *    没有它，优化器必然退化成「夜间出发」最优（实测：北京→天津 138km，
 *    用平均暴露度扫描全天，最优解是 19:00）。
 *
 * ② 输出**危险出发窗口**，而不只是「最优时刻」
 *    实测：15:45 出发峰值 100.0，16:05 出发峰值 23.2 —— 跳变 76 分。
 *    用户需要知道的是「有一条线不能越」，而不是「一个魔法时刻」。
 *
 * ③ 最优解贴着危险窗口时**必须警告**
 *    实测推荐 16:37 出发，而危险窗是 15:37–16:37 —— 正好相邻。
 *    只报一个漂亮的分数而不提示，是不负责任的。
 */

import { RISK_TEXT_COLORS } from '@/ui/layerConfig.js';
import { isNearDanger, describeRange } from '@/domain/departureOptimizer.js';
import { riskLevel } from '@/domain/glareEngine.js';
import type { DeparturePlan } from '@/domain/types.js';

interface DeparturePlannerProps {
  arrival: { from: string; to: string };
  onArrivalChange: (v: { from: string; to: string }) => void;
  plan: DeparturePlan | null;
  planError: string | null;
  /** 点击某个候选时，把预览时刻切到它的出发时间 */
  onPreview: (departAt: Date) => void;
  routeDurationMs: number;
  disabled?: boolean;
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 候选的峰值风险是否全部相同（四舍五入后）。
 * 用于判断「推荐」标签此刻是否还有区分意义。
 */
export function allTied(candidates: readonly { peakRisk: number }[]): boolean {
  if (candidates.length < 2) return false;
  const first = Math.round(candidates[0]!.peakRisk);
  return candidates.every((c) => Math.round(c.peakRisk) === first);
}

/** 常见到达时段预设，减少输入成本 */
const PRESETS: Array<{ label: string; from: string; to: string }> = [
  { label: '上午到', from: '09:00', to: '12:00' },
  { label: '中午到', from: '12:00', to: '14:00' },
  { label: '下午到', from: '14:00', to: '17:00' },
  { label: '傍晚到', from: '17:00', to: '20:00' },
  { label: '夜里到', from: '20:00', to: '23:00' },
];

export function DeparturePlanner({
  arrival,
  onArrivalChange,
  plan,
  planError,
  onPreview,
  routeDurationMs,
  disabled = false,
}: DeparturePlannerProps) {
  // 优化器已保证 candidates 不超过 3 条
  const candidates = plan?.candidates ?? [];

  return (
    <div className="section">
      <h3 className="section__title">什么时候出发</h3>

      {/* 到达时段：F6 的硬约束 */}
      <div className="field">
        <label className="field__label" htmlFor="arrive-from">
          期望到达时段
        </label>
        <div className="time-range">
          <input
            id="arrive-from"
            type="time"
            value={arrival.from}
            onChange={(e) => onArrivalChange({ ...arrival, from: e.target.value })}
            disabled={disabled}
          />
          <span className="time-range__sep">–</span>
          <input
            type="time"
            value={arrival.to}
            onChange={(e) => onArrivalChange({ ...arrival, to: e.target.value })}
            disabled={disabled}
          />
        </div>
        <div className="field__hint">
          行程约需 {(routeDurationMs / 60000).toFixed(0)} 分钟。
          系统据此反推可行出发时间，再挑逆光最少的方案。
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
        {PRESETS.map((p) => {
          const active = p.from === arrival.from && p.to === arrival.to;
          return (
            <button
              key={p.label}
              type="button"
              className="btn btn--ghost"
              style={{ width: 'auto', padding: '5px 10px', fontSize: 12 }}
              onClick={() => onArrivalChange({ from: p.from, to: p.to })}
              disabled={disabled}
              aria-pressed={active}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* 约束不可满足 */}
      {planError && (
        <div className="verdict verdict--info">
          <span className="verdict__icon" aria-hidden="true">
            !
          </span>
          <div className="verdict__text">
            <div className="verdict__headline">无法给出方案</div>
            <div className="verdict__detail">{planError}</div>
          </div>
        </div>
      )}

      {/* 反建议：峰值下界 ≥ 60，无论怎么选都躲不掉 */}
      {plan && plan.unavoidable && (
        <div className="verdict verdict--warn">
          <span className="verdict__icon" aria-hidden="true">
            ⚠
          </span>
          <div className="verdict__text">
            <div className="verdict__headline">这个时段内无法完全避开逆光</div>
            <div className="verdict__detail">
              该路线的走向与太阳方位冲突，无论几点出发都有一段会正对太阳
              （最低峰值仍在 {plan.peakLowerBound.toFixed(0)} 分以上）。
              建议放宽到达时段，或备好偏光墨镜并在该路段减速。
            </div>
          </div>
        </div>
      )}

      {/* 候选方案 */}
      {plan && !plan.unavoidable && candidates.length > 0 && (
        <>
          {candidates.map((c, i) => {
            const level = riskLevel(c.peakRisk);
            const near = isNearDanger(c, plan);
            return (
              <button
                key={c.departAt.getTime()}
                type="button"
                className={`candidate${i === 0 ? ' candidate--best' : ''}`}
                onClick={() => onPreview(c.departAt)}
              >
                <div className="candidate__times">
                  <span className="candidate__depart">{hhmm(c.departAt)}</span>
                  <span className="candidate__arrow">出发 →</span>
                  <span className="candidate__arrive">{hhmm(c.arriveAt)} 到达</span>
                  {i === 0 && <span className="candidate__tag">推荐</span>}
                </div>

                <div className="candidate__stats">
                  <span>
                    峰值风险{' '}
                    <b style={{ color: RISK_TEXT_COLORS[level] }}>
                      {c.peakRisk.toFixed(0)}
                    </b>{' '}
                    <span className="faint">({level})</span>
                  </span>
                  <span>
                    高风险里程 <b>{(c.highRiskRatio * 100).toFixed(1)}%</b>
                  </span>
                  {c.peakRoad && (
                    <span className="faint">
                      最严重段：{c.peakRoad}
                    </span>
                  )}
                </div>

                {near && (
                  <div className="candidate__warn">
                    ⚠ 这个时刻紧邻危险出发窗口，仅相差几分钟就会撞上正对太阳的路段
                  </div>
                )}
              </button>
            );
          })}
        </>
      )}

      {/* 危险出发窗口 —— 比「最优时刻」更可执行 */}
      {plan && plan.dangerousRanges.length > 0 && (
        <div className="danger-strip">
          <div className="danger-strip__title">
            危险出发窗口（这些时段出发会撞上正对太阳的路段）
          </div>
          <div className="danger-strip__list">
            {plan.dangerousRanges.map((r) => (
              <span className="danger-strip__item" key={r.from.getTime()}>
                {describeRange(r)}
                <span className="faint"> · 峰值 {r.boundRisk.toFixed(0)}</span>
              </span>
            ))}
          </div>
          <div className="field__hint" style={{ marginTop: 7 }}>
            避开这些区间即可显著降低逆光暴露。注意危险窗口边界上的变化可能很陡
            —— 实测同一路线 15:45 出发峰值 100 分，16:05 出发降到 23 分。
          </div>
        </div>
      )}

      {/* 峰值下界：路线几何决定的不可回避水平 */}
      {plan && plan.peakLowerBound < Number.POSITIVE_INFINITY && (
        <div className="field__hint" style={{ marginTop: 12 }}>
          可行区间内的<b>峰值下界</b>为 {plan.peakLowerBound.toFixed(0)} 分
          —— 这是无论怎么选出发时间都躲不掉的最坏水平，由路线几何决定。
        </div>
      )}

      {/*
        全部并列时的说明。
        真实局限：当天气系数很低（如小雨 0.15）把所有风险压到同一档时，
        各候选的峰值会相同，排序退化为按出发时间先后 —— 此时「推荐」
        标签只表示「最早可选」，不代表风险更优。必须说清楚，避免误导。
      */}
      {plan && candidates.length > 1 && allTied(candidates) && (
        <div className="field__hint" style={{ marginTop: 10 }}>
          这些方案的峰值风险相同 —— 当前条件下（如天气大幅削弱阳光）
          不同出发时间的差别不明显，列出的顺序按出发时间先后。
        </div>
      )}
    </div>
  );
}
