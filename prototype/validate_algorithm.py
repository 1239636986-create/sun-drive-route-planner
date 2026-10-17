#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
M0 算法验证原型 —— 用真实高德路线数据跑通完整逆光风险计算链

验证目标（对应 PRD 附录 C 的验收用例）：
  T01/T01b  太阳位置精度（含北京真太阳时 12:22 而非 12:00 的陷阱）
  T04       夜间归零
  T12       正对太阳时 R 随 h 严格单调递减
  T13       6.4.6 校准表逐行复现
  + 真实路线盲测：天安门->天津 138km，看结果是否符合驾驶直觉

重要约束（已在 amap-provider-findings.md 实测确认）：
  - orientation 字段不可用（8 档量化），bearing 必须从 polyline 自算
  - GCJ-02 坐标对 bearing 影响 0.25°，可忽略，无需转换
"""

import json
import math
import subprocess
import sys
import os
from datetime import datetime, timedelta, timezone

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
CST = timezone(timedelta(hours=8), name="CST")   # 中国标准时间，无夏令时
GLARE_T0 = 15.0      # w_angle 的 θ0
GLARE_P = 1.6        # w_angle 的指数

PASS = 0
FAIL = 0
def check(cond, label, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {label}")
    else:
        FAIL += 1
        print(f"  [FAIL] {label}   {detail}")
    return cond


# ===========================================================================
# 1. 太阳位置 —— NOAA Solar Position Algorithm
# ===========================================================================
def julian_day(dt_utc):
    y, m = dt_utc.year, dt_utc.month
    d = (dt_utc.day + dt_utc.hour / 24.0 + dt_utc.minute / 1440.0
         + dt_utc.second / 86400.0)
    if m <= 2:
        y -= 1
        m += 12
    a = y // 100
    b = 2 - a + a // 4
    return int(365.25 * (y + 4716)) + int(30.6001 * (m + 1)) + d + b - 1524.5


def sun_position(lat, lon, dt_utc):
    """返回 (方位角 A, 高度角 h)，单位度。方位角从正北顺时针 0-360。"""
    jd = julian_day(dt_utc)
    t = (jd - 2451545.0) / 36525.0

    # 太阳几何平黄经、平近点角、偏心率
    L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360.0
    M = 357.52911 + t * (35999.05029 - 0.0001537 * t)
    e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)

    # 中心差
    Mr = math.radians(M)
    C = (math.sin(Mr) * (1.914602 - t * (0.004817 + 0.000014 * t))
         + math.sin(2 * Mr) * (0.019993 - 0.000101 * t)
         + math.sin(3 * Mr) * 0.000289)
    true_long = L0 + C

    # 视黄经
    omega = 125.04 - 1934.136 * t
    lam = true_long - 0.00569 - 0.00478 * math.sin(math.radians(omega))

    # 黄赤交角
    eps0 = (23.0 + 26.0 / 60.0 + 21.448 / 3600.0
            - t * (46.8150 + t * (0.00059 - t * 0.001813)) / 3600.0)
    eps = eps0 + 0.00256 * math.cos(math.radians(omega))

    lam_r = math.radians(lam)
    eps_r = math.radians(eps)
    sin_dec = math.sin(eps_r) * math.sin(lam_r)
    decl = math.asin(max(-1.0, min(1.0, sin_dec)))

    # 时差方程（分钟）
    y = math.tan(eps_r / 2.0) ** 2
    L0r = math.radians(L0)
    eqtime = 4 * math.degrees(
        y * math.sin(2 * L0r)
        - 2 * e * math.sin(Mr)
        + 4 * e * y * math.sin(Mr) * math.cos(2 * L0r)
        - 0.5 * y * y * math.sin(4 * L0r)
        - 1.25 * e * e * math.sin(2 * Mr)
    )

    # 真太阳时（分钟）
    minutes = (dt_utc.hour * 60 + dt_utc.minute + dt_utc.second / 60.0
               + dt_utc.microsecond / 6e7)
    true_solar_time = (minutes + eqtime + 4 * lon) % 1440.0

    # 时角
    ha = true_solar_time / 4.0 - 180.0
    if ha < -180:
        ha += 360
    ha_r = math.radians(ha)
    lat_r = math.radians(lat)

    # 天顶角 / 高度角
    cos_zen = (math.sin(lat_r) * math.sin(decl)
               + math.cos(lat_r) * math.cos(decl) * math.cos(ha_r))
    cos_zen = max(-1.0, min(1.0, cos_zen))
    zen = math.acos(cos_zen)
    elev = 90.0 - math.degrees(zen)

    # 方位角
    sin_zen = math.sin(zen)
    if abs(sin_zen) < 1e-10:
        az = 0.0
    else:
        cos_az = ((math.sin(lat_r) * math.cos(zen) - math.sin(decl))
                  / (math.cos(lat_r) * sin_zen))
        cos_az = max(-1.0, min(1.0, cos_az))
        az = math.degrees(math.acos(cos_az))
        if ha > 0:          # 下午 -> 偏西
            az = 360.0 - az
    return az, elev


# ===========================================================================
# 2. 风险模型 —— PRD 6.4（含 6.4.2 的修订版 f_sun）
# ===========================================================================
def off_axis_angle(h, delta_a):
    """离轴角 θ = arccos(cos h · cos ΔA)"""
    c = math.cos(math.radians(h)) * math.cos(math.radians(delta_a))
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def w_angle(theta):
    return 1.0 / (1.0 + (theta / GLARE_T0) ** GLARE_P)


def f_sun(h):
    """单调线性衰减。h<=0 归零；0.5°=1.0；60°+=0.2"""
    if h <= 0:
        return 0.0
    if h >= 60.0:
        return 0.2
    return max(0.2, min(1.0, 1.0 - 0.8 * (h - 0.5) / 59.5))


def risk_score(h, delta_a, f_weather=1.0):
    if h <= 0:
        return 0.0
    return 100.0 * w_angle(off_axis_angle(h, delta_a)) * f_sun(h) * f_weather


def risk_level(r):
    if r >= 80: return "极高"
    if r >= 60: return "高"
    if r >= 30: return "中"
    return "低"


# ===========================================================================
# 3. 几何工具
# ===========================================================================
def bearing_deg(a, b):
    """a,b 为 (lon,lat)。大圆方位角，正北 0°，顺时针。"""
    la1, lo1 = math.radians(a[1]), math.radians(a[0])
    la2, lo2 = math.radians(b[1]), math.radians(b[0])
    dl = lo2 - lo1
    yy = math.sin(dl) * math.cos(la2)
    xx = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dl)
    return (math.degrees(math.atan2(yy, xx)) + 360.0) % 360.0


def haversine(a, b):
    R = 6371008.8
    la1, lo1 = math.radians(a[1]), math.radians(a[0])
    la2, lo2 = math.radians(b[1]), math.radians(b[0])
    h = (math.sin((la2 - la1) / 2) ** 2
         + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(min(1.0, h)))


def percentile(vals, p):
    if not vals:
        return 0.0
    s = sorted(vals)
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * p
    lo = int(math.floor(k))
    hi = int(math.ceil(k))
    if lo == hi:
        return s[lo]
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


# ===========================================================================
# 4. 分段构建
# ===========================================================================
MIN_SEG_M = 1.0      # 丢弃退化段
SPLIT_M = 300.0      # 超过此长度则插值细分


def build_segments(route_json, sample_m=100.0):
    """把高德 steps 展开为统一分段列表（按 sample_m 重采样以保证粒度均匀）"""
    steps = route_json["route"]["paths"][0]["steps"]
    raw = []
    for s in steps:
        pts = [tuple(map(float, p.split(",")))
               for p in s["polyline"].split(";") if "," in p]
        for i in range(len(pts) - 1):
            d = haversine(pts[i], pts[i + 1])
            if d < MIN_SEG_M:
                continue          # 丢弃退化段
            raw.append({
                "a": pts[i], "b": pts[i + 1], "dist": d,
                "road": (s.get("road") or "").strip(),
            })

    # 按固定间距重采样，得到均匀粒度的段
    segs = []
    for r in raw:
        n = max(1, int(round(r["dist"] / sample_m)))
        for k in range(n):
            t0, t1 = k / n, (k + 1) / n
            a = (r["a"][0] + (r["b"][0] - r["a"][0]) * t0,
                 r["a"][1] + (r["b"][1] - r["a"][1]) * t0)
            b = (r["a"][0] + (r["b"][0] - r["a"][0]) * t1,
                 r["a"][1] + (r["b"][1] - r["a"][1]) * t1)
            segs.append({
                "a": a, "b": b,
                "dist": r["dist"] / n,
                "heading": bearing_deg(a, b),
                "road": r["road"],
            })
    return segs


# ===========================================================================
# 5. 风险计算主流程
# ===========================================================================
def compute_route_risk(segs, depart_local, total_dist_m, total_dur_s,
                       sample_min=5.0, f_weather=1.0):
    """返回 (每段风险列表, 每段到达时刻列表)"""
    speed = total_dist_m / total_dur_s if total_dur_s > 0 else 20.0  # m/s

    # 累计里程与到达时刻
    cum = 0.0
    for s in segs:
        s["t_start"] = depart_local + timedelta(seconds=cum / speed)
        cum += s["dist"]
        s["t_end"] = depart_local + timedelta(seconds=cum / speed)

    step_s = sample_min * 60.0
    for s in segs:
        # 时间采样
        ts = []
        t = s["t_start"]
        while t <= s["t_end"]:
            ts.append(t)
            t += timedelta(seconds=step_s)
        if not ts or ts[-1] < s["t_end"]:
            ts.append(s["t_end"])

        scores = []
        best = None
        for t in ts:
            dt_utc = t.astimezone(timezone.utc)
            mid = ((s["a"][0] + s["b"][0]) / 2.0, (s["a"][1] + s["b"][1]) / 2.0)
            az, h = sun_position(mid[1], mid[0], dt_utc)
            dA = abs((az - s["heading"] + 180.0) % 360.0 - 180.0)
            r = risk_score(h, dA, f_weather)
            scores.append(r)
            if best is None or r > best[0]:
                best = (r, t, az, h, dA)
        s["r_p80"] = percentile(scores, 0.80)
        s["r_max"] = max(scores)
        s["r_mean"] = sum(scores) / len(scores)
        s["peak"] = best
    return segs


def merge_windows(segs, min_level="中"):
    """把连续的风险段合并成人类可读的路段清单"""
    order = {"低": 0, "中": 1, "高": 2, "极高": 3}
    thresh = order[min_level]
    out = []
    cur = None
    for s in segs:
        lv = risk_level(s["r_p80"])
        if order[lv] >= thresh:
            if cur is None:
                cur = {"start": s, "end": s, "roads": {s["road"]}, "maxr": s["r_p80"]}
            else:
                cur["end"] = s
                cur["roads"].add(s["road"])
                cur["maxr"] = max(cur["maxr"], s["r_p80"])
        else:
            if cur is not None:
                out.append(cur)
                cur = None
    if cur is not None:
        out.append(cur)
    return out


# ===========================================================================
# 主程序
# ===========================================================================
def main():
    key = os.environ.get("AMAP_WEB_KEY", "").strip()
    if not key:
        envf = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env")
        if os.path.exists(envf):
            for line in open(envf, encoding="utf-8"):
                if line.startswith("AMAP_WEB_KEY="):
                    key = line.split("=", 1)[1].strip()
    if not key:
        print("未找到 AMAP_WEB_KEY（环境变量或 .env）", file=sys.stderr)
        return 2

    here = os.path.dirname(os.path.abspath(__file__))
    cache = os.path.join(here, "data", "route_bj_tj.json")
    os.makedirs(os.path.dirname(cache), exist_ok=True)

    if not os.path.exists(cache):
        print("拉取真实路线：天安门 -> 天津站 ...")
        url = ("https://restapi.amap.com/v3/direction/driving"
               "?key=%s&origin=116.397428,39.90923"
               "&destination=117.201509,39.085308"
               "&extensions=all&strategy=0" % key)
        r = subprocess.run(["curl", "-sS", "--max-time", "30", url],
                           capture_output=True, text=True)
        open(cache, "w", encoding="utf-8").write(r.stdout)
    route = json.load(open(cache, encoding="utf-8-sig"))
    assert route.get("status") == "1", route.get("info")

    path = route["route"]["paths"][0]
    total_dist = float(path["distance"])
    total_dur = float(path["duration"])

    print("=" * 74)
    print("  M0 算法验证原型 —— 真实高德路线")
    print("=" * 74)
    print(f"  路线: 天安门 -> 天津站")
    print(f"  距离: {total_dist/1000:.1f} km   高德预计时长: {total_dur/60:.1f} 分钟")
    print(f"  平均车速: {total_dist/total_dur*3.6:.1f} km/h")
    print()

    # -----------------------------------------------------------------------
    print("-" * 74)
    print("  第 1 步：太阳位置精度（PRD 附录 C T01 / T01b）")
    print("-" * 74)
    bj = (39.9042, 116.4074)
    az1200, h1200 = sun_position(bj[0], bj[1], datetime(2025, 3, 20, 4, 0, tzinfo=timezone.utc))
    print(f"  北京 2025-03-20 12:00 CST -> 方位角 {az1200:.2f}°  高度角 {h1200:.2f}°")
    check(abs(az1200 - 8.7) < 1.0, f"T01 方位角 ≈ 8.7°（实测 {az1200:.2f}°）")
    check(abs(h1200 - 49.2) < 1.0, f"T01 高度角 ≈ 49.2°（实测 {h1200:.2f}°）")

    az1222, h1222 = sun_position(bj[0], bj[1], datetime(2025, 3, 20, 4, 22, tzinfo=timezone.utc))
    print(f"  北京 2025-03-20 12:22 CST -> 方位角 {az1222:.2f}°  高度角 {h1222:.2f}°")
    check(abs(az1222) < 1.0 or abs(az1222 - 360) < 1.0,
          f"T01b 真太阳时正午方位角 ≈ 0°（实测 {az1222:.2f}°）—— 守护 12:22≠12:00 陷阱")

    # 日出方位角（春分应接近正东 90°）
    az_sr, h_sr = sun_position(bj[0], bj[1], datetime(2025, 3, 19, 22, 15, tzinfo=timezone.utc))
    print(f"  北京 2025-03-20 06:15 CST -> 方位角 {az_sr:.2f}°  高度角 {h_sr:.2f}°  (春分日出应近正东)")
    check(abs(az_sr - 90) < 6, f"春分日出方位角接近正东 90°（实测 {az_sr:.2f}°）")
    print()

    # -----------------------------------------------------------------------
    print("-" * 74)
    print("  第 2 步：夜间归零（T04）与单调性（T12）")
    print("-" * 74)
    night_bad = 0
    for hh in range(0, 24):
        t = datetime(2025, 3, 20, hh, 0, tzinfo=timezone.utc)
        _, h = sun_position(bj[0], bj[1], t)
        if h <= 0:
            for dA in (0, 30, 90, 180):
                if risk_score(h, dA) != 0.0:
                    night_bad += 1
    check(night_bad == 0, f"T04 太阳在地平线下时风险恒为 0（违规 {night_bad} 次）")

    mono_ok = True
    prev = None
    for h10 in range(5, 600):
        h = h10 / 10.0
        r = risk_score(h, 0.0)
        if prev is not None and r > prev + 1e-9:
            mono_ok = False
            break
        prev = r
    check(mono_ok, "T12 正对太阳(ΔA=0)时 R 随 h 严格单调递减")
    print()

    # -----------------------------------------------------------------------
    print("-" * 74)
    print("  第 3 步：校准表复现（T13，PRD 6.4.6）")
    print("-" * 74)
    table = [(0.5, 99.6), (1, 98.0), (2, 94.2), (3, 89.8), (5, 80.1), (7, 70.4),
             (10, 57.3), (15, 40.3), (20, 28.5), (30, 15.0), (45, 5.9),
             (60, 2.0), (80, 1.3)]
    print("     h      期望R     实测R     等级")
    max_err = 0.0
    for h, exp in table:
        got = risk_score(h, 0.0)
        max_err = max(max_err, abs(got - exp))
        flag = "" if abs(got - exp) <= 0.2 else "  <<< 偏差超容差"
        print(f"   {h:>5}°   {exp:>6.1f}   {got:>6.1f}   {risk_level(got)}{flag}")
    check(max_err <= 0.2, f"T13 校准表逐行复现（最大偏差 {max_err:.3f}，容差 0.2）")
    print()

    # -----------------------------------------------------------------------
    print("-" * 74)
    print("  第 4 步：真实路线分段")
    print("-" * 74)
    segs = build_segments(route, sample_m=100.0)
    tot = sum(s["dist"] for s in segs)
    print(f"  分段数: {len(segs)}   重采样后总长: {tot/1000:.1f} km  (高德报 {total_dist/1000:.1f} km)")
    check(abs(tot - total_dist) / total_dist < 0.02, "分段总长与高德一致（误差 <2%）")
    heads = [s["heading"] for s in segs]
    print(f"  路段朝向分布: 最小 {min(heads):.1f}°  最大 {max(heads):.1f}°")
    named = sum(1 for s in segs if s["road"])
    print(f"  有道路名的段占比: {100*named/len(segs):.1f}%  (高德部分 step 的 road 为空)")
    print()

    # -----------------------------------------------------------------------
    print("-" * 74)
    print("  第 5 步：真实路线逆光风险 —— 盲测")
    print("-" * 74)
    depart = datetime(2025, 3, 20, 7, 0, tzinfo=CST)
    compute_route_risk(segs, depart, total_dist, total_dur)

    lv_count = {}
    for s in segs:
        lv_count[risk_level(s["r_p80"])] = lv_count.get(risk_level(s["r_p80"]), 0) + 1
    print(f"  出发时间: 2025-03-20 07:00 CST（春分，日出后约 45 分钟，太阳在正东偏南低空）")
    print(f"  北京->天津 总体走向: 东南  ->  逆光风险应较高")
    print()
    print("  风险分级分布:")
    for lv in ("极高", "高", "中", "低"):
        c = lv_count.get(lv, 0)
        bar = "█" * int(c / max(1, len(segs)) * 50)
        print(f"    {lv:<3} {c:>5} 段 ({100*c/len(segs):5.1f}%) {bar}")

    worst = max(segs, key=lambda s: s["r_p80"])
    pk = worst["peak"]
    print()
    print("  最严重的一段:")
    print(f"    道路    : {worst['road'] or '(未命名)'}")
    print(f"    位置    : {worst['a'][1]:.5f},{worst['a'][0]:.5f}")
    print(f"    朝向    : {worst['heading']:.1f}°")
    print(f"    风险分数: P80={worst['r_p80']:.1f}  MAX={worst['r_max']:.1f}  ({risk_level(worst['r_p80'])})")
    print(f"    峰值时刻: {pk[1].strftime('%H:%M:%S')} CST")
    print(f"      太阳方位角={pk[2]:.1f}°  高度角={pk[3]:.1f}°  离轴角={pk[4]:.1f}°")
    print()

    # 高风险清单
    print("-" * 74)
    print("  高风险路段清单（PRD F5 的产出形态）")
    print("-" * 74)
    wins = merge_windows(segs, "高")
    if not wins:
        print("  （无『高』以上路段）")
    for w in wins[:8]:
        s0, s1 = w["start"], w["end"]
        roads = [r for r in w["roads"] if r]
        road = roads[0] if roads else "(未命名路段)"
        if len(set(roads)) > 1:
            road = " / ".join(list(dict.fromkeys(roads))[:3])
        dist_km = (sum(x["dist"] for x in segs[segs.index(s0):segs.index(s1)+1])) / 1000
        print(f"  【{risk_level(w['maxr'])}】{road}")
        print(f"        {s0['t_start'].strftime('%H:%M')}–{s1['t_end'].strftime('%H:%M')} CST"
              f"  |  约 {dist_km:.1f} km  |  峰值 {w['maxr']:.0f} 分")
    print()

    # -----------------------------------------------------------------------
    print("-" * 74)
    print("  第 6 步：整天扫描 —— 何时出发最不刺眼（PRD F6）")
    print("-" * 74)
    print("    出发时刻    总暴露度   峰值   高风险段占比")
    best_t = None
    for hh in range(5, 23):
        t = datetime(2025, 3, 20, hh, 0, tzinfo=CST)
        trial = build_segments(route, sample_m=100.0)
        compute_route_risk(trial, t, total_dist, total_dur)
        expo = sum(s["r_p80"] * s["dist"] for s in trial) / sum(s["dist"] for s in trial)
        peak = max(s["r_p80"] for s in trial)
        hi = sum(1 for s in trial if s["r_p80"] >= 60) / len(trial) * 100
        mark = ""
        if best_t is None or expo < best_t[1]:
            best_t = (t, expo)
            mark = "  <-- 目前最优"
        print(f"    {hh:02d}:00      {expo:6.1f}    {peak:5.1f}   {hi:5.1f}%{mark}")
    print()
    print(f"  最优出发时间: {best_t[0].strftime('%H:%M')} CST (总暴露度 {best_t[1]:.1f})")
    print()

    print("=" * 74)
    print(f"  断言汇总:  通过 {PASS}   失败 {FAIL}")
    print("=" * 74)
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
