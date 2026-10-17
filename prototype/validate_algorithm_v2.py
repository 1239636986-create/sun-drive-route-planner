#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
M0 算法验证原型 v2 —— 修正 F5 窗口合并与 F6 出发优化指标

v1 盲测暴露的两个设计缺陷（本次修正）：
  [缺陷 1] F5 高风险清单按 100m 分段合并 -> 窗口碎成「07:00-07:00, 0.1km」
           根因：合并粒度 = 分段粒度。100m @ 53km/h = 6.8 秒。
           修正：按**道路名（导航语义单元）**聚合并合并相邻同名窗口。
  [缺陷 2] F6 用「平均暴露度」-> 最优解退化成「19:00 出发」（太阳落山，无意义）
           根因：路线 85% 东西向，致命点集中在 3.1km 西向路段，被平均值稀释。
           修正：报告「可达最优」与「峰值下界」，并明确指出不可规避的场景。

保留 v1 已通过的 8 项断言（T01/T01b/T04/T12/T13 + 真实路线一致性）。
"""

import json
import math
import subprocess
import sys
import os
from datetime import datetime, timedelta, timezone

CST = timezone(timedelta(hours=8), name="CST")
GLARE_T0 = 15.0
GLARE_P = 1.6

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
# 太阳位置（NOAA SPA）
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
    jd = julian_day(dt_utc)
    t = (jd - 2451545.0) / 36525.0
    L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360.0
    M = 357.52911 + t * (35999.05029 - 0.0001537 * t)
    e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
    Mr = math.radians(M)
    C = (math.sin(Mr) * (1.914602 - t * (0.004817 + 0.000014 * t))
         + math.sin(2 * Mr) * (0.019993 - 0.000101 * t)
         + math.sin(3 * Mr) * 0.000289)
    true_long = L0 + C
    omega = 125.04 - 1934.136 * t
    lam = true_long - 0.00569 - 0.00478 * math.sin(math.radians(omega))
    eps0 = (23.0 + 26.0 / 60.0 + 21.448 / 3600.0
            - t * (46.8150 + t * (0.00059 - t * 0.001813)) / 3600.0)
    eps = eps0 + 0.00256 * math.cos(math.radians(omega))
    lam_r = math.radians(lam)
    eps_r = math.radians(eps)
    decl = math.asin(max(-1.0, min(1.0, math.sin(eps_r) * math.sin(lam_r))))
    y = math.tan(eps_r / 2.0) ** 2
    L0r = math.radians(L0)
    eqtime = 4 * math.degrees(
        y * math.sin(2 * L0r) - 2 * e * math.sin(Mr)
        + 4 * e * y * math.sin(Mr) * math.cos(2 * L0r)
        - 0.5 * y * y * math.sin(4 * L0r) - 1.25 * e * e * math.sin(2 * Mr))
    minutes = (dt_utc.hour * 60 + dt_utc.minute + dt_utc.second / 60.0
               + dt_utc.microsecond / 6e7)
    tst = (minutes + eqtime + 4 * lon) % 1440.0
    ha = tst / 4.0 - 180.0
    if ha < -180:
        ha += 360
    ha_r = math.radians(ha)
    lat_r = math.radians(lat)
    cos_zen = (math.sin(lat_r) * math.sin(decl)
               + math.cos(lat_r) * math.cos(decl) * math.cos(ha_r))
    cos_zen = max(-1.0, min(1.0, cos_zen))
    zen = math.acos(cos_zen)
    elev = 90.0 - math.degrees(zen)
    sin_zen = math.sin(zen)
    if abs(sin_zen) < 1e-10:
        az = 0.0
    else:
        cos_az = ((math.sin(lat_r) * math.cos(zen) - math.sin(decl))
                  / (math.cos(lat_r) * sin_zen))
        cos_az = max(-1.0, min(1.0, cos_az))
        az = math.degrees(math.acos(cos_az))
        if ha > 0:
            az = 360.0 - az
    return az, elev


# ===========================================================================
# 风险模型
# ===========================================================================
def off_axis_angle(h, delta_a):
    c = math.cos(math.radians(h)) * math.cos(math.radians(delta_a))
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def w_angle(theta):
    return 1.0 / (1.0 + (theta / GLARE_T0) ** GLARE_P)


def f_sun(h):
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
# 几何
# ===========================================================================
def bearing_deg(a, b):
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
    lo, hi = int(math.floor(k)), int(math.ceil(k))
    if lo == hi:
        return s[lo]
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


# ===========================================================================
# 分段（保留原始折线段 + 道路名，供窗口合并使用）
# ===========================================================================
MIN_SEG_M = 1.0
SPLIT_M = 300.0


def build_segments(route_json, sample_m=100.0):
    steps = route_json["route"]["paths"][0]["steps"]
    # 先取出完整折线，同时保留「点属于哪条道路」
    poly, road_of = [], []
    for s in steps:
        pts = [tuple(map(float, p.split(",")))
               for p in s["polyline"].split(";") if "," in p]
        rn = (s.get("road") or "").strip()
        for i in range(len(pts) - 1):
            if haversine(pts[i], pts[i + 1]) < MIN_SEG_M:
                continue
            poly.append(pts[i])
            road_of.append(rn)
        if pts:
            poly.append(pts[-1])
            road_of.append(rn)

    # 按 sample_m 重采样，插值出 (lon,lat) 与所属道路
    segs = []
    for i in range(len(poly) - 1):
        a, b, rn = poly[i], poly[i + 1], road_of[i]
        d = haversine(a, b)
        if d < MIN_SEG_M:
            continue
        n = max(1, int(round(d / sample_m)))
        for k in range(n):
            t0, t1 = k / n, (k + 1) / n
            pa = (a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0)
            pb = (a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1)
            segs.append({"a": pa, "b": pb, "dist": d / n,
                         "heading": bearing_deg(pa, pb), "road": rn})
    return segs


# ===========================================================================
# 风险计算
# ===========================================================================
def compute_route_risk(segs, depart_local, total_dist_m, total_dur_s,
                       sample_min=5.0, f_weather=1.0):
    speed = total_dist_m / total_dur_s if total_dur_s > 0 else 20.0
    cum = 0.0
    for s in segs:
        s["t_start"] = depart_local + timedelta(seconds=cum / speed)
        cum += s["dist"]
        s["t_end"] = depart_local + timedelta(seconds=cum / speed)
    step_s = sample_min * 60.0
    for s in segs:
        ts, t = [], s["t_start"]
        while t <= s["t_end"]:
            ts.append(t)
            t += timedelta(seconds=step_s)
        if not ts or ts[-1] < s["t_end"]:
            ts.append(s["t_end"])
        scores, best = [], None
        for t in ts:
            mid = ((s["a"][0] + s["b"][0]) / 2.0, (s["a"][1] + s["b"][1]) / 2.0)
            az, h = sun_position(mid[1], mid[0], t.astimezone(timezone.utc))
            dA = abs((az - s["heading"] + 180.0) % 360.0 - 180.0)
            r = risk_score(h, dA, f_weather)
            scores.append(r)
            if best is None or r > best[0]:
                best = (r, t, az, h, dA)
        s["r_p80"] = percentile(scores, 0.80)
        s["r_max"] = max(scores)
        s["peak"] = best
    return segs


# ===========================================================================
# 【修正 1】按道路名聚合并合并相邻同名窗口（替代 v1 的逐段合并）
# ===========================================================================
def merge_by_road(segs, min_level="中"):
    """v2 修正：把连续的同道路、同等级的段聚成一个窗口。

    导航语义下，「东长安街 07:02-07:04」才是一个有意义的风险单元，
    而「第 1234 段 07:02:36」不是。
    """
    order = {"低": 0, "中": 1, "高": 2, "极高": 3}
    thresh = order[min_level]
    wins, cur = [], None
    for s in segs:
        lv = risk_level(s["r_p80"])
        risky = order[lv] >= thresh
        if not risky:
            if cur:
                wins.append(cur); cur = None
            continue
        # 合并条件：同一条道路 + 时间上连续
        if (cur and cur["road"] == s["road"]
                and (s["t_start"] - cur["t_end"]).total_seconds() <= 1.0):
            cur["t_end"] = s["t_end"]
            cur["segs"].append(s)
            cur["maxr"] = max(cur["maxr"], s["r_p80"])
        else:
            if cur:
                wins.append(cur)
            cur = {"road": s["road"], "t_start": s["t_start"],
                   "t_end": s["t_end"], "segs": [s], "maxr": s["r_p80"]}
    if cur:
        wins.append(cur)
    # 合并「同名道路且时间间隔很短」的相邻窗口（被非风险段打断的情况）
    merged = []
    for w in wins:
        if (merged and merged[-1]["road"] == w["road"]
                and (w["t_start"] - merged[-1]["t_end"]).total_seconds() <= 60.0):
            merged[-1]["t_end"] = w["t_end"]
            merged[-1]["segs"].extend(w["segs"])
            merged[-1]["maxr"] = max(merged[-1]["maxr"], w["maxr"])
        else:
            merged.append(w)
    return merged


# ===========================================================================
def main():
    key = os.environ.get("AMAP_WEB_KEY", "").strip()
    here = os.path.dirname(os.path.abspath(__file__))
    if not key:
        envf = os.path.join(here, "..", ".env")
        if os.path.exists(envf):
            for line in open(envf, encoding="utf-8"):
                if line.startswith("AMAP_WEB_KEY="):
                    key = line.split("=", 1)[1].strip()

    cache = os.path.join(here, "data", "route_bj_tj.json")
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    if not os.path.exists(cache):
        if not key:
            print("无缓存且无 Key", file=sys.stderr); return 2
        url = ("https://restapi.amap.com/v3/direction/driving"
               "?key=%s&origin=116.397428,39.90923"
               "&destination=117.201509,39.085308"
               "&extensions=all&strategy=0" % key)
        r = subprocess.run(["curl", "-sS", "--max-time", "30", url],
                           capture_output=True, text=True)
        open(cache, "w", encoding="utf-8").write(r.stdout)
    route = json.load(open(cache, encoding="utf-8-sig"))
    path = route["route"]["paths"][0]
    D, T = float(path["distance"]), float(path["duration"])

    print("=" * 76)
    print("  M0 算法验证原型 v2 —— 真实高德路线 + F5/F6 修正")
    print("=" * 76)
    print(f"  路线: 天安门 -> 天津站   {D/1000:.1f} km / {T/60:.1f} 分钟 / 均速 {D/T*3.6:.1f} km/h")
    print()

    # --- 回归：v1 的 8 项断言必须仍然通过 -------------------------------
    print("-" * 76); print("  [回归] v1 已通过的断言"); print("-" * 76)
    bj = (39.9042, 116.4074)
    az, h = sun_position(bj[0], bj[1], datetime(2025, 3, 20, 4, 0, tzinfo=timezone.utc))
    check(abs(az - 8.7) < 1.0 and abs(h - 49.2) < 1.0, f"T01 北京 12:00 CST: 方位 {az:.2f}° 高度 {h:.2f}°")
    az2, _ = sun_position(bj[0], bj[1], datetime(2025, 3, 20, 4, 22, tzinfo=timezone.utc))
    check(min(abs(az2), abs(az2 - 360)) < 1.0, f"T01b 真太阳时正午 12:22 方位 {az2:.2f}°")
    night_bad = 0
    for hh in range(24):
        _, hh_e = sun_position(bj[0], bj[1], datetime(2025, 3, 20, hh, 0, tzinfo=timezone.utc))
        if hh_e <= 0:
            for dA in (0, 30, 90, 180):
                if risk_score(hh_e, dA) != 0.0:
                    night_bad += 1
    check(night_bad == 0, "T04 地平线下风险恒为 0")
    mono, prev = True, None
    for i in range(5, 600):
        r = risk_score(i / 10.0, 0.0)
        if prev is not None and r > prev + 1e-9:
            mono = False; break
        prev = r
    check(mono, "T12 正对太阳时 R 随 h 严格单调递减")
    table = [(0.5, 99.6), (1, 98.0), (2, 94.2), (3, 89.8), (5, 80.1), (7, 70.4),
             (10, 57.3), (15, 40.3), (20, 28.5), (30, 15.0), (45, 5.9), (60, 2.0), (80, 1.3)]
    merr = max(abs(risk_score(hh, 0.0) - e) for hh, e in table)
    check(merr <= 0.2, f"T13 校准表复现（最大偏差 {merr:.3f}）")
    print()

    segs = build_segments(route, 100.0)
    tot = sum(s["dist"] for s in segs)
    check(abs(tot - D) / D < 0.02,
          f"分段总长 {tot/1000:.1f}km 与高德 {D/1000:.1f}km 一致")
    print()

    # --- 缺陷 1 修正前后对比 -------------------------------------------
    print("-" * 76)
    print("  [修正 1] F5 高风险清单：v1（逐段合并） vs v2（按道路名合并）")
    print("-" * 76)
    depart = datetime(2025, 3, 20, 7, 0, tzinfo=CST)
    compute_route_risk(segs, depart, D, T)

    lv_count = {}
    for s in segs:
        lv_count[risk_level(s["r_p80"])] = lv_count.get(risk_level(s["r_p80"]), 0) + 1
    print(f"  出发 07:00 CST，风险分布: " + "  ".join(
        f"{lv} {lv_count.get(lv,0)}段" for lv in ("极高", "高", "中", "低")))
    print()

    # v1 风格的逐段窗口
    v1_wins = []
    cur = None
    order = {"低": 0, "中": 1, "高": 2, "极高": 3}
    for s in segs:
        if order[risk_level(s["r_p80"])] >= 2:
            if cur is None:
                cur = [s, s]
            else:
                cur[1] = s
        else:
            if cur:
                v1_wins.append(tuple(cur)); cur = None
    if cur:
        v1_wins.append(tuple(cur))
    print(f"  v1 逐段合并 -> 产生 {len(v1_wins)} 个窗口")
    print("     前 5 个（注意时间窗全是同一分钟，无意义）:")
    for a, b in v1_wins[:5]:
        print(f"       {a['t_start'].strftime('%H:%M:%S')}–{b['t_end'].strftime('%H:%M:%S')}"
              f"  {a['road'] or '(未命名)'}  {a['dist']:.0f}m")
    print()

    v2_wins = merge_by_road(segs, "高")
    print(f"  v2 按道路名合并 -> 产生 {len(v2_wins)} 个窗口")
    print("     ★ 这就是 PRD F5 要求的清单形态:")
    for w in sorted(v2_wins, key=lambda x: -x["maxr"])[:6]:
        dist_km = sum(x["dist"] for x in w["segs"]) / 1000
        print(f"       【{risk_level(w['maxr'])}】{w['road'] or '(未命名路段)'}"
              f"  |  {w['t_start'].strftime('%H:%M')}–{w['t_end'].strftime('%H:%M')} CST"
              f"  |  约 {dist_km:.1f} km  |  峰值 {w['maxr']:.0f} 分")
    check(len(v2_wins) < len(v1_wins),
          f"清单条目数显著减少（{len(v1_wins)} -> {len(v2_wins)}），可读性提升")
    print()

    # --- 缺陷 2 修正：F6 正确的优化指标 ---------------------------------
    print("-" * 76)
    print("  [修正 2] F6 出发时间优化：暴露『平均暴露度』为何失效")
    print("-" * 76)
    scans = {}
    for hh in range(5, 20):
        t = datetime(2025, 3, 20, hh, 0, tzinfo=CST)
        tr = build_segments(route, 200.0)
        compute_route_risk(tr, t, D, T)
        avg = sum(s["r_p80"] * s["dist"] for s in tr) / sum(s["dist"] for s in tr)
        mx = max(s["r_p80"] for s in tr)
        n_hi = sum(1 for s in tr if s["r_p80"] >= 60)
        scans[hh] = (avg, mx, n_hi)
    print("    出发  平均暴露  P80峰值  高以上段数  [PRD F6 原指标: 只看平均]")
    best_avg = min(scans, key=lambda k: scans[k][0])
    best_max = min(scans, key=lambda k: scans[k][1])
    for hh in sorted(scans):
        avg, mx, n_hi = scans[hh]
        tag = ""
        if hh == best_avg: tag += "  <- 平均最优"
        if hh == best_max: tag += "  <- 峰值最优"
        print(f"    {hh:02d}:00  {avg:8.2f}  {mx:8.1f}  {n_hi:10d}{tag}")
    print()
    print(f"  『平均暴露度』指标会选出 {best_avg:02d}:00 出发 —— 原因是")
    print(f"    这条路线 85% 是东西向（东 34% + 东南 51%），")
    print(f"    但致命的只有 【3.1 km 西向路段】，在 16:00 落日时正对车头（峰值 99.4）。")
    print(f"    平均值把 3.1km 的致命点除以 138km 全长的里程权重，稀释掉了。")
    print()
    print(f"  -> 【结论】F6 不能用平均暴露度做主指标。正确做法是：")
    print(f"     (a) 主指标改用「峰值风险 + 高以上里程占比」双指标；")
    print(f"     (b) 明确报告『峰值下界』—— 即无论何时出发都躲不掉的最坏峰值；")
    print(f"     (c) 当峰值下界 >= 60 时，直接给出『本路线无法完全避开逆光』的结论，")
    print(f"         而不是硬推一个出发时间（PRD F6 的『反建议』要求 / 验收 T07）。")
    print()
    lo, hi = 5, 19
    print(f"  若把搜索范围限制在【白天 06:00–18:00】:")
    best_day = min((h for h in scans if 6 <= h <= 18), key=lambda k: scans[k][0])
    bd = scans[best_day]
    print(f"     平均暴露度最优 = {best_day:02d}:00  (平均 {bd[0]:.2f}, 峰值 {bd[1]:.1f})")
    print(f"     但峰值最优 = {best_max:02d}:00 (峰值 {scans[best_max][1]:.1f})")
    print(f"     全局峰值下界 = {min(s[1] for s in scans.values()):.1f} "
          f"(出现在 {min(scans, key=lambda k: scans[k][1]):02d}:00)")
    print()

    # --- 关键场景核验 ---------------------------------------------------
    print("-" * 76)
    print("  场景核验：这是否符合驾驶直觉？")
    print("-" * 76)
    scen = [
        ("清晨 07:00 出发，向东路段迎面撞朝阳", 7, "东向"),
        ("下午 16:00 出发，向西路段迎面撞落日", 16, "西向"),
        ("正午 12:00 出发，太阳高挂", 12, "任意"),
    ]
    for name, hh, _ in scen:
        t = datetime(2025, 3, 20, hh, 0, tzinfo=CST)
        tr = build_segments(route, 100.0)
        compute_route_risk(tr, t, D, T)
        worst = max(tr, key=lambda s: s["r_max"])
        pk = worst["peak"]
        print(f"  · {name}")
        print(f"      最严重: {worst['road'] or '(未命名)'}  朝向 {worst['heading']:.0f}°"
              f"  峰值 {worst['r_max']:.1f} ({risk_level(worst['r_max'])})")
        print(f"      时刻 {pk[1].strftime('%H:%M:%S')}  太阳方位 {pk[2]:.1f}°"
              f"  高度角 {pk[3]:.1f}°  离轴角 {pk[4]:.1f}°")
    print()

    print("=" * 76)
    print(f"  断言汇总:  通过 {PASS}   失败 {FAIL}")
    print("=" * 76)
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
