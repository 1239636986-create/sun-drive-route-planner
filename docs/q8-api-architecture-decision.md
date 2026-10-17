# Q8 决策：API 调用架构

> 状态：**已定稿**
> 决策日期：M1 收尾阶段
> 相关：[PRD 第 12 章](PRD-sun-glare-route-planner.md)、[高德实测结论](amap-provider-findings.md)

---

## 结论

**走「反向代理 + 服务端注入凭据」。不引入 JS API Key，不需要 securityJsCode。**

- 前端统一请求自己域下的 `/amap-api/*`
- 由反向代理注入 `&key=<Web服务Key>` 后转发到 `restapi.amap.com`
- 开发环境用 Vite dev server 代理；生产环境用 nginx / serverless 做同样的事
- 一个 Web服务 Key 覆盖全部需求：路线规划 + 地理编码 + **地图瓦片**

**客户端产物中不出现任何密钥。**

---

## 决策依据（三条，全部实测）

### 依据 1：高德官方明确推荐把凭据放服务端

来自 [JS API 安全密钥使用](https://developer.amap.com/api/javascript-api-v2/guide/abc/jscode)（更新于 2025-06-18）：

> 为了增强安全性，建议将安全密钥存储在服务器端，并通过服务器端生成地图 JS API 的请求 URL。这样可以避免将密钥直接以明文的方式暴露给 Web 端代码中，减少密钥被滥用的风险。

官方给出的 Nginx 参考配置：

```nginx
location /_AMapService/ {
  set $args "$args&jscode=你的安全密钥";
  proxy_pass https://restapi.amap.com/;
}
```

即 **「反向代理 + 注入凭据」本身就是高德推荐的安全架构**，不是我们要自创的方案。

### 依据 2：实测代理路径返回的数据与直连完全一致

| 指标 | 直连（带 key） | 经代理（客户端零密钥） |
| --- | --- | --- |
| `status` | 1 | **1** |
| `distance` | 138536 m | **138536 m** |
| `steps` | 21 | **21** |
| 有 `road` 的 step | 17 | **17** |
| `G2京沪高速` 段长 | 97776 m | **97776 m** |

**数据零损失。** 并且对照组「直连不带 key」返回 `INVALID_USER_KEY / 10001`，证明代理确实注入了有效凭据。

### 依据 3：`jscode` 对 REST v3 接口**无效**

这是本次实测踩到的坑，必须记下来：

```
GET /v3/direction/driving?...&jscode=<Web服务Key>
-> {"status":"0","info":"INVALID_USER_KEY","infocode":"10001"}
```

**高德官方那个 Nginx 示例里的 `jscode` 是给 JS API 的地图服务用的**，路径规划这类 REST 接口要的是 `key`。

> 如果将来有人照着官方示例去注入 `jscode` 然后困惑于 10001，回来看这一条。

---

## 为什么不走高德 JS API

原本 PRD §7.1 倾向 JS API（前端 Key + 安全密钥 + 域名白名单）。实测后改变：

| | JS API 路线 | **代理路线（选定）** |
| --- | --- | --- |
| 需要的 Key | JS API Key **+** securityJsCode | **仅 Web服务 Key** |
| Key 暴露面 | 前端明文（靠域名白名单兜底） | **完全不暴露** |
| 地图瓦片 | JS API 提供 | JS API 瓦片地址同样可被 MapLibre 使用 |
| 前端责任 | 需正确配置安全密钥，配错就白屏 | 无 |
| 官方态度 | 明文方式「如果你只是想便捷开发可以使用」 | 「强烈建议（安全）」 |

**关键点**：代理路线**不需要多申请任何东西** —— 已有的 Web服务 Key 就够了。而 JS API 路线要多申请一个 Key + 一个安全密钥，还要处理域名白名单。

因为不依赖 JS API，地图渲染用 **MapLibre GL JS + 高德栅格瓦片**（GCJ-02，与路线数据同坐标系，零转换）。这同时兑现了 PRD 里 Q4 的决策。

---

## 生产环境配置

开发环境（已实现）：`vite.config.ts` 的 `/amap-api` 代理，从 `.env` 注入。

生产环境二选一：

### 方案 A：nginx

```nginx
location /amap-api/ {
  set $args "$args&key=你的Web服务Key";
  proxy_pass https://restapi.amap.com/;
  proxy_ssl_server_name on;
}
```

> 注意这里是 `key` 而不是官方示例里的 `jscode` —— 见依据 3。

### 方案 B：指向自建代理

设置 `AMAP_PROXY_TARGET=https://your-proxy.example.com`，
`vite.config.ts` 会停止注入本地 key，改由那一层负责。

---

## 底图瓦片的独立问题（M2 补充）

底图瓦片**不在 Key 体系内**，必须单独选型。核心约束是**坐标系**：

| 瓦片源 | CORS | 实测大小 | 坐标系 | 中文标注 | 性质 |
| --- | --- | --- | --- | --- | --- |
| 高德矢量 `webrd01` | `*` | 17 KB | **GCJ-02** | ✅ | JS API 内部地址，**未公开** |
| 高德卫星 `webst01` | `*` | 34 KB | **GCJ-02** | — | 同上 |
| Esri World Street | `*` | 16 KB | WGS-84 | ❌ 英文 | 官方可编程接口 |
| OSM 德国镜像 | `*` | 33 KB | WGS-84 | 部分 | 社区镜像 |
| Carto | `*` | 2 KB | WGS-84 | ❌ | 疑为空白瓦片，不实用 |

**关键矛盾**：只有高德瓦片与路线数据同坐标系（GCJ-02）。

若用 WGS-84 瓦片，路线会有 **300–600m 整体偏移**（GCJ-02 偏移量），
视觉上「飘在路外」，产品可信度直接崩掉。解决办法是渲染前做
`gcj02ToWgs84` 转换（见 `src/domain/coords.ts`，已实现并有往返一致性测试）。

**当前取舍**：默认高德瓦片（零转换、中文标注、与路线同系），
但做成**可切换注册表**（`src/ui/layerConfig.ts` 的 `TILE_SOURCES`）：
- 高德瓦片失效时，切 Esri（官方稳定接口，代价是英文标注 + 需坐标转换）
- 切换逻辑已实现且有测试守护，上层代码不用改

---

## 仍未解决 / 已知限制

| # | 项 | 说明 |
| --- | --- | --- |
| 1 | **开发代理仅 dev 可用** | `vite.config.ts` 的 `server.proxy` 只在 `vite dev` 生效。构建产物必须部署到有反向代理的环境，否则请求 `/amap-api/*` 会 404 |
| 2 | **没有静态托管的降级方案** | 若要把产物丢到纯静态托管（如 GitHub Pages），这个架构不成立 —— 因为 CORS 直连需要把 key 放前端。届时需重新评估 |
| 3 | **配额保护仍依赖高德侧** | 代理挡住了密钥泄漏，但没有挡「盗用接口」。若担心，需自建代理加限流 |
| 4 | **未验证 JS API 的 `road` 字段** | 我在调研中未能确认 JS API 的 `DriveStep` 是否返回道路名。因为已选定代理路线（用的是实测确认有 `road` 的 REST 接口），此问题不再影响决策 |

---

## 对 M2 的影响

1. **不需要申请 JS API Key** —— [checklist](amap-key-application-checklist.md) 里的「Key ①」可以不做
2. 地图用 **MapLibre GL JS**，瓦片源指向高德（GCJ-02）
3. 前端所有高德请求走 `src/api/client.ts` 的 `amapUrl()`
4. 启动时调用 `probeProxy()`，在代理未配置时给出**可操作的错误提示**而不是白屏
5. `AmapProvider` 构造函数传 `baseUrl: '/amap-api'` 即可复用，无需改动算法层
