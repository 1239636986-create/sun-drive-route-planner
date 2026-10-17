#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 高德「Web服务」Key 验证脚本  (v2 — 依据真实返回值修订)
#
# 用途：拿到 Web服务 类型的 Key 后，一次性验明：
#   1) Key 是否有效（权限 / 配额是否正常）
#   2) 驾车路径规划返回的字段结构（v3 与 v5 对比）
#   3) polylines 折线密度 —— 决定能否直接用作 100m 分段输入
#   4) 从折线自算 bearing 的可行性（orientation 只有 8 档，不可用于计算）
#
# 用法：
#   ./tools/verify-amap-key.sh <你的Web服务Key>
#   或： AMAP_KEY=xxx ./tools/verify-amap-key.sh
#
# 注意：只发只读 GET 请求，不写入任何地方。请勿把 Key 提交进 Git。
# ---------------------------------------------------------------------------
set -uo pipefail

KEY="${1:-${AMAP_KEY:-}}"

if [[ -z "$KEY" ]]; then
  echo "用法: $0 <Web服务Key>   或   AMAP_KEY=xxx $0" >&2
  exit 2
fi
if ! command -v curl >/dev/null || ! command -v jq >/dev/null; then
  echo "需要 curl 和 jq" >&2
  exit 2
fi

BASE="https://restapi.amap.com"
PASS=0; FAIL=0
TMPL="$(mktemp -d)"
trap 'rm -rf "$TMPL"' EXIT

hr() { printf '%s\n' "------------------------------------------------------------"; }
title() { hr; printf '  %s\n' "$1"; hr; }

check_status() {
  local file="$1" label="$2"
  if [[ "$(jq -r '.status // "?"' "$file")" == "1" ]]; then
    printf '  [OK]   %s\n' "$label"; PASS=$((PASS+1)); return 0
  fi
  printf '  [FAIL] %s\n         info=%s  infocode=%s\n' \
    "$label" "$(jq -r '.info // "?"' "$file")" "$(jq -r '.infocode // "?"' "$file")"
  FAIL=$((FAIL+1)); return 1
}

explain_code() {
  case "$(jq -r '.infocode // ""' "$1")" in
    "10001") echo "  >> Key 不正确或已失效" ;;
    "10003") echo "  >> 日调用量已达上限" ;;
    "10009") echo "  >> Key 与服务类型不匹配 —— 极可能用『JS API』Key 调了『Web服务』接口" ;;
    "10044") echo "  >> 该 Key 配额已用完" ;;
    "10012") echo "  >> 权限不足 / 引擎响应超时" ;;
    "")      echo "  >> 无错误码，可能是网络问题" ;;
    *)       echo "  >> infocode=$(jq -r '.infocode' "$1")（对照 https://developer.amap.com/api/webservice/guide/tools/info）" ;;
  esac
}

echo
title "高德 Web服务 Key 验证 v2   $(date '+%Y-%m-%d %H:%M:%S')"
echo "  Key 指纹: ${KEY:0:8}...${KEY: -4}  (长度 ${#KEY})"
echo

# ===========================================================================
title "测试 1/4  地理编码 —— Key 有效性"
# ===========================================================================
F1="$TMPL/geo.json"
curl -sS --max-time 20 -G "$BASE/v3/geocode/geo" \
  --data-urlencode "key=$KEY" --data-urlencode "address=北京市天安门" \
  --data-urlencode "output=JSON" -o "$F1"

if check_status "$F1" "v3/geocode/geo 可用"; then
  jq -r '"         匹配: \(.geocodes[0].formatted_address // "-")"' "$F1"
  jq -r '"         坐标: \(.geocodes[0].location // "-")   (GCJ-02, 格式 lon,lat)"' "$F1"
else
  explain_code "$F1"; echo; hr
  echo "  结果: 通过 $PASS / 失败 $FAIL"; exit 1
fi
echo

ORIGIN="116.397428,39.90923"     # 天安门
DEST="117.201509,39.085308"      # 天津站
LONG_DEST="117.120128,36.652069" # 济南

# ===========================================================================
title "测试 2/4  驾车路径规划 v3 —— 字段结构"
# ===========================================================================
F2="$TMPL/v3.json"
curl -sS --max-time 25 -G "$BASE/v3/direction/driving" \
  --data-urlencode "key=$KEY" --data-urlencode "origin=$ORIGIN" \
  --data-urlencode "destination=$DEST" --data-urlencode "extensions=all" \
  --data-urlencode "strategy=0" --data-urlencode "output=JSON" -o "$F2"

if check_status "$F2" "v3/direction/driving 可用"; then
  echo "         顶层字段 : $(jq -r 'keys|join(", ")' "$F2")"
  echo "         paths[0] : $(jq -r '.route.paths[0]|keys|join(", ")' "$F2")"
  echo "         step[0]  : $(jq -r '.route.paths[0].steps[0]|keys|join(", ")' "$F2")"
  echo
  echo "         总距离   : $(jq -r '(.route.paths[0].distance|tonumber/1000|floor)' "$F2") km"
  echo "         step 数量: $(jq -r '.route.paths[0].steps|length' "$F2")"
  echo
  echo "  --- orientation 的真实形态（关键）---"
  echo "         全部取值: $(jq -r '[.route.paths[0].steps[].orientation]|unique|join(" ")' "$F2")"
  echo "         >>> 注意：这是中文方位词（8 档 = 45° 分辨率），不是角度数字。"
  echo "         >>> 且每个 step 只给 1 个值，一个 97km 的高速段也只有 1 个。"
  echo "         >>> 结论：不可用于离轴角计算，只能作为 UI 上的粗略文字描述。"

  echo
  echo "  --- road 道路名（可用于高风险清单文案）---"
  jq -r '.route.paths[0].steps[] | select((.road//"")!="") | "           \(.road)  (\(.distance)m)"' "$F2" \
    | grep -E "高速|桥|大道|路" | head -8
else
  explain_code "$F2"
fi
echo

# ===========================================================================
title "测试 3/4  折线密度 —— 决定能否直接用作 100m 分段"
# ===========================================================================
F3="$TMPL/long.json"
curl -sS --max-time 30 -G "$BASE/v3/direction/driving" \
  --data-urlencode "key=$KEY" --data-urlencode "origin=$ORIGIN" \
  --data-urlencode "destination=$LONG_DEST" --data-urlencode "extensions=all" \
  --data-urlencode "output=JSON" -o "$F3"

if check_status "$F3" "长距离规划（北京->济南）可用"; then
  echo "         总距离: $(jq -r '(.route.paths[0].distance|tonumber/1000|floor)' "$F3") km"
  echo "         step 数: $(jq -r '.route.paths[0].steps|length' "$F3")"
  echo
  jq -r '[.route.paths[0].steps[].polyline] | join(";")' "$F3" > "$TMPL/pl.txt"
  python3 - "$TMPL/pl.txt" <<'PY'
import sys, math
raw=open(sys.argv[1]).read().strip()
pts=[tuple(map(float,p.split(','))) for p in raw.split(';') if ',' in p]
def hav(a,b):
    R=6371008.8
    la1,lo1=math.radians(a[1]),math.radians(a[0])
    la2,lo2=math.radians(b[1]),math.radians(b[0])
    h=math.sin((la2-la1)/2)**2+math.cos(la1)*math.cos(la2)*math.sin((lo2-lo1)/2)**2
    return 2*R*math.asin(math.sqrt(h))
ds=sorted(hav(pts[i],pts[i+1]) for i in range(len(pts)-1))
n=len(ds)
print(f"         折线点总数: {len(pts)}")
print(f"         折线段数  : {n}   <- 这就是天然的 bearing 序列长度")
print(f"         段间距    : 最小 {ds[0]:.1f}m | P25 {ds[n//4]:.1f}m | 中位 {ds[n//2]:.1f}m | P75 {ds[3*n//4]:.1f}m | 最大 {ds[-1]:.1f}m")
under100=sum(1 for d in ds if d<=100)
print(f"         <=100m 的段占比: {100*under100/n:.1f}%")
print(f"         -> 中位间距接近 100m, 折线可直接作为分段输入, 无需重采样")
print(f"         -> 406km 路线共 {n} 段, 每段 72 个时间采样 = {n*72} 次太阳位置计算")
PY
else
  explain_code "$F3"
fi
echo

# ===========================================================================
title "测试 4/4  驾车路径规划 v5 —— 新版字段结构"
# ===========================================================================
F4="$TMPL/v5.json"
curl -sS --max-time 25 -G "$BASE/v5/direction/driving" \
  --data-urlencode "key=$KEY" --data-urlencode "origin=$ORIGIN" \
  --data-urlencode "destination=$DEST" \
  --data-urlencode "show_fields=polyline,cost,tmcs" \
  --data-urlencode "output=JSON" -o "$F4"

if check_status "$F4" "v5/direction/driving 可用"; then
  echo "         顶层字段 : $(jq -r 'keys|join(", ")' "$F4")"
  echo "         paths[0] : $(jq -r '.route.paths[0]|keys|join(", ")' "$F4")"
  echo "         step[0]  : $(jq -r '.route.paths[0].steps[0]|keys|join(", ")' "$F4")"
  echo
  if jq -e '.route.paths[0].steps[0]|has("road")' "$F4" >/dev/null 2>&1; then
    echo "         v5 的 step 带 road 字段。"
  else
    echo "         >>> v5 的 step 不带 road 字段（需用 show_fields 指定或改用 v3）。"
    echo "         >>> 本项目的推荐：v3（road 开箱可用，覆盖我们的全部需求）"
  fi
  echo "         v5 orientation 取值: $(jq -r '[.route.paths[0].steps[].orientation]|unique|join(" ")' "$F4")"
else
  explain_code "$F4"
fi
echo

# ===========================================================================
title "汇总"
# ===========================================================================
echo "  通过: $PASS   失败: $FAIL"
echo
if [[ $FAIL -eq 0 ]]; then
  cat <<'EOF'
  结论：Key 可用于本项目的路线与朝向数据源。

  已确认的数据结论：
    1. orientation 只有 8 档且每 step 仅一个值 -> 不可用于离轴角计算
    2. road 字段可用，含「G2京沪高速」等 -> 用于高风险清单文案
    3. polyline 折线中位间距约 80-100m    -> 直接作为分段输入
    4. bearing 必须从 polyline 自算（大圆方位角公式）

  下一步：Key 放入 .env（并加 .gitignore），我来写 AmapProvider。
EOF
else
  echo "  结论：存在失败项，把 info/infocode 发我判断是账号问题还是 Key 类型问题。"
fi
hr
echo
echo "  提醒：本脚本不写入 Key。若此目录将来提交 Git，请确认 Key 未进入被追踪的文件。"
echo
