/**
 * 风险概览：结论横幅 + 分级分布条 + 图例
 *
 * 无障碍关键点：风险信息一律「颜色 + 文字 + 数值」三重表达。
 * 因为四级色标的明度不是单调的（「中」比「低」亮），
 * 仅靠颜色无法可靠区分等级。见 src/ui/layerConfig.ts 的说明。
 */

import { RISK_FILL_COLORS, RISK_TEXT_COLORS, RISK_LEVEL_ORDER_UI } from '@/ui/layerConfig.js';
import { riskLevel } from '@/domain/glareEngine.js';
import type { RiskLevel, SegmentRisk } from '@/domain/types.js';

interface RiskSummaryProps {
  distribution: Record<RiskLevel, number>;
  worst: SegmentRisk | null;
  windowCount: number;
  totalSegments: number;
  previewAt: Date;
  /**
   * 天气抑制说明。若非空，表示「无风险」的结论部分是天气造成的，
   * 必须显式告知 —— 否则用户会把「小雨天无逆光」误读成「好天气、放心开」。
   */
  weatherNote?: string | null;
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function RiskSummary({
  distribution,
  worst,
  windowCount,
  totalSegments,
  previewAt,
  weatherNote,
}: RiskSummaryProps) {
  const level = worst ? riskLevel(worst.rP80) : '低';
  const hasRisk = windowCount > 0;

  // 结论横幅的形态随风险等级变化
  const verdictClass = !hasRisk ? 'verdict--clear' : level === '极高' ? 'verdict--warn' : 'verdict--info';
  const icon = !hasRisk ? '✓' : level === '极高' ? '⚠' : '!';

  const headline = !hasRisk
    ? `${hhmm(previewAt)} 出发，全程无逆光风险`
    : level === '极高'
      ? `${hhmm(previewAt)} 出发，存在严重致盲风险`
      : `${hhmm(previewAt)} 出发，有 ${windowCount} 段需要留意`;

  const detail = !hasRisk
    ? weatherNote
      ? `整条路线上没有会正对太阳的路段。但请注意：这一结论部分来自当前天气 —— ${weatherNote}`
      : '整条路线上没有会正对太阳的路段。'
    : worst
      ? `${worst.road || '未命名路段'} 最严重：峰值 ${worst.rP80.toFixed(0)} 分，` +
        `太阳方位 ${worst.peak.sunAzimuth.toFixed(0)}°、` +
        `车道朝向 ${worst.heading.toFixed(0)}°，` +
        `离轴角 ${worst.peak.offAxisAngle.toFixed(1)}°（越小越正对）。`
      : '';

  return (
    <>
      <div className={`verdict ${verdictClass}`}>
        <span className="verdict__icon" aria-hidden="true">
          {icon}
        </span>
        <div className="verdict__text">
          <div className="verdict__headline">{headline}</div>
          <div className="verdict__detail">{detail}</div>
          {hasRisk && weatherNote && (
            <div className="verdict__detail" style={{ marginTop: 4 }}>
              已按天气修正：{weatherNote}
            </div>
          )}
        </div>
      </div>

      <div className="section">
        <h3 className="section__title">
          风险分布
          <span className="section__count">按里程 · {totalSegments} 分段</span>
        </h3>

        <div className="risk-bar" role="img" aria-label={ariaLabel(distribution)}>
          {RISK_LEVEL_ORDER_UI.map((lv) => {
            const pct = distribution[lv] * 100;
            if (pct <= 0) return null;
            return (
              <div
                key={lv}
                className="risk-bar__seg"
                style={{ width: `${pct}%`, background: RISK_FILL_COLORS[lv] }}
                title={`${lv} ${pct.toFixed(1)}%`}
              />
            );
          })}
        </div>

        <div className="legend">
          {RISK_LEVEL_ORDER_UI.map((lv) => (
            <div className="legend__item" key={lv}>
              <span className="legend__swatch" style={{ background: RISK_FILL_COLORS[lv] }} />
              <span className="legend__label" style={{ color: RISK_TEXT_COLORS[lv] }}>
                {lv}
              </span>
              <span className="legend__pct mono">{(distribution[lv] * 100).toFixed(1)}%</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/** 给读屏软件的完整描述 —— 颜色之外的等价信息 */
function ariaLabel(dist: Record<RiskLevel, number>): string {
  return (
    '风险里程占比：' +
    RISK_LEVEL_ORDER_UI.map((lv) => `${lv} ${(dist[lv] * 100).toFixed(1)}%`).join('，')
  );
}
