/**
 * 高风险清单（PRD F5）
 *
 * 组织主键是**道路名**（Q9 决策）—— 实测按 100m 分段聚合会产出
 * 「07:00:26–07:00:32」这种无法阅读的条目（15 条垃圾条目），
 * 按路名聚合后降到 3 条可用条目。见 docs/m0-algorithm-validation-report.md §2。
 *
 * 空状态很重要：全程无风险时必须给出**明确的绿色结论**，
 * 而不是一张全蓝图让用户自己猜。见 PRD F4 验收标准。
 */

import { RISK_TEXT_COLORS, RISK_LEVEL_LABELS } from '@/ui/layerConfig.js';
import { riskAdvice } from '@/domain/glareEngine.js';
import type { RiskWindow, SegmentRisk } from '@/domain/types.js';

interface RiskListProps {
  windows: readonly RiskWindow[];
  selectedRoad: string | null;
  onSelect: (w: RiskWindow | null) => void;
  /** 当前预览时刻，用于「此刻无风险」文案 */
  previewAt: Date;
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 该窗口的峰值分段 —— 用来取离轴角做建议文案 */
function peakSegment(w: RiskWindow): SegmentRisk {
  return w.segments.reduce((a, b) => (b.rP80 > a.rP80 ? b : a), w.segments[0]!);
}

export function RiskList({ windows, selectedRoad, onSelect, previewAt }: RiskListProps) {
  /**
   * 空状态刻意做得**很轻**。
   *
   * 早期的版本在这里又放了一个完整的结论横幅（「07:00 出发，全程无逆光风险」），
   * 结果与 RiskSummary 的横幅文案重复出现在同一屏上 —— 用户会以为看到了两条
   * 不同的结论。结论只应由 RiskSummary 说一次，这里只负责说明「清单为空」。
   */
  if (windows.length === 0) {
    return (
      <div className="section">
        <h3 className="section__title">
          高风险路段
          <span className="section__count">无</span>
        </h3>
        <div className="empty-hint">
          {hhmm(previewAt)} 出发时，没有需要特别留意的路段。
        </div>
      </div>
    );
  }

  return (
    <div className="section">
      <h3 className="section__title">
        高风险路段
        <span className="section__count">共 {windows.length} 段</span>
      </h3>

      {windows.map((w) => {
        const peak = peakSegment(w);
        const selected = selectedRoad === w.road;
        const key = `${w.road}|${w.tStart.getTime()}`;

        return (
          <button
            key={key}
            type="button"
            className={`risk-item risk-item--level-${w.level}${
              selected ? ' risk-item--selected' : ''
            }`}
            onClick={() => onSelect(selected ? null : w)}
            aria-pressed={selected}
          >
            <div className="risk-item__head">
              <span className="risk-item__road">{w.road || '未命名路段'}</span>
              <span
                className="risk-item__badge"
                style={{ background: RISK_TEXT_COLORS[w.level] }}
              >
                {w.level}
              </span>
            </div>

            <div className="risk-item__meta">
              {w.instantaneous ? (
                <span className="risk-item__instant" title="该路段太短，不足 1 分钟">
                  瞬时
                </span>
              ) : (
                <span className="mono">
                  {hhmm(w.tStart)}–{hhmm(w.tEnd)}
                </span>
              )}
              <span className="mono">{(w.distance / 1000).toFixed(1)} km</span>
              <span className="mono">峰值 {w.maxRisk.toFixed(0)} 分</span>
              <span className="mono">离轴角 {peak.peak.offAxisAngle.toFixed(1)}°</span>
            </div>

            <div className="faint" style={{ fontSize: 11.5, marginTop: 5 }}>
              {RISK_LEVEL_LABELS[w.level]} ·{' '}
              {riskAdvice(w.level, w.road, peak.peak.offAxisAngle).split('，').slice(1).join('，')}
            </div>
          </button>
        );
      })}
    </div>
  );
}
