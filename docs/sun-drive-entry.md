# 阳光驾驶路线 · 独立入口

该地图产品使用独立入口运行，不覆盖或替换现有 StepCode 页面。

## 开发入口

```bash
npm run dev:sun-drive
```

打开：

- <http://127.0.0.1:5188>

默认的 `npm run dev` 和其他现有页面配置保持不变。

## 独立生产构建

```bash
npm run build:sun-drive
```

产物目录：

```text
dist-sun-drive/
```

该目录与默认 `dist/` 分离，不会覆盖其他网页版本。

## 本地预览生产版本

```bash
npm run preview:sun-drive
```

打开：

- <http://127.0.0.1:5189>

## API 代理

地图产品的地点搜索、路线规划和天气请求统一访问 `/amap-api/*`。
开发入口会从项目根目录 `.env` 读取：

```env
AMAP_WEB_KEY=你的高德Web服务Key
```

Key 只在 Vite/Node 代理侧注入，不会进入浏览器构建产物。

生产部署时仍需由 nginx、serverless 或其他代理层注入 Key；具体配置见项目根目录 [README](../README.md) 和 [Q8 架构决策](q8-api-architecture-decision.md)。

## 产品名称

- 浏览器标题：**阳光驾驶路线 · 出发前看清逆光路段**
- 页面名称：**阳光驾驶路线**

## 与 StepCode 的关系

本入口为单独端口、单独构建目录：

| 页面 | 地址/目录 |
| --- | --- |
| 现有 StepCode 页面 | 保持原入口不变 |
| 阳光驾驶路线开发版 | `http://127.0.0.1:5188` |
| 阳光驾驶路线生产预览 | `http://127.0.0.1:5189` |
| 阳光驾驶路线构建产物 | `dist-sun-drive/` |
