/// <reference types="node" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Q8 决策：走「反向代理 + 服务端注入凭据」。
 *
 * ── 决策依据（全部实测，见 docs/q8-api-architecture-decision.md）──────────
 *
 * 1. 高德官方**明确推荐**把凭据放服务端、由服务端生成请求 URL：
 *    「为了增强安全性，建议将安全密钥存储在服务器端，并通过服务器端生成
 *      地图 JS API 的请求 URL。这样可以避免将密钥直接以明文的方式暴露给
 *      Web 端代码中，减少密钥被滥用的风险」—— JS API 安全密钥使用文档
 *
 * 2. 实测：代理注入 `key` 后，返回数据与直连**完全一致**
 *    （distance=138536, steps=21, 17 个有 road, G2京沪高速 97776m）
 *    而浏览器侧零密钥。
 *
 * 3. 实测：`jscode` 参数对 REST v3 接口**无效**（返回 10001）。
 *    高德官方 Nginx 示例里的 `jscode` 是给 JS API 地图服务用的，
 *    路径规划这类 REST 接口要的是 `key`。不要被那个示例误导。
 *
 * ── 为什么不用高德 JS API ──────────────────────────────────────────────
 *
 * 所以不需要 JS API Key，也不需要 securityJsCode。一个 Web服务 Key
 * 就覆盖了路线规划 + 地理编码 + 地图瓦片。
 *
 * ⚠️ 生产环境不要把 key 放这里 —— 用 nginx / serverless 做同样的注入：
 *      location /amap-api/ {
 *        set $args "$args&key=你的Web服务Key";
 *        proxy_pass https://restapi.amap.com/;
 *      }
 *    或用 AMAP_PROXY_TARGET 指向你自己的代理。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const amapKey = env.AMAP_WEB_KEY ?? '';

  if (mode === 'development' && !amapKey) {
    console.warn(
      '\n[amap-proxy] 未找到 AMAP_WEB_KEY —— 前端的路线请求会失败。\n' +
        '             请在 .env 中设置，见 docs/amap-key-application-checklist.md\n',
    );
  }

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },

    server: {
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        /**
         * 前端统一用 `/amap-api/*` 访问高德 REST 接口。
         * 代理在此注入 key —— 客户端产物中不出现任何密钥。
         */
        '/amap-api': {
          target: env.AMAP_PROXY_TARGET ?? 'https://restapi.amap.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/amap-api/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              // 只在直连高德时注入本地 key。
              // 若 AMAP_PROXY_TARGET 指向自建代理，凭据由那一层负责。
              if (!env.AMAP_PROXY_TARGET && amapKey) {
                const url = new URL(proxyReq.path, 'https://restapi.amap.com');
                url.searchParams.set('key', amapKey);
                proxyReq.path = url.pathname + url.search;
              }
            });
          },
        },
      },
    },
  };
});
