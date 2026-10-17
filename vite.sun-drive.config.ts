/// <reference types="node" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * 「阳光驾驶路线」独立入口配置。
 *
 * 与默认 vite.config.ts 刻意分离，确保：
 *   1. 不占用 StepCode 或其他页面的默认入口/端口；
 *   2. 生产构建进入独立目录 dist-sun-drive/；
 *   3. 保留同样的高德安全代理能力，前端构建产物不包含 Key。
 *
 * 开发地址：http://127.0.0.1:5188
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const amapKey = env.AMAP_WEB_KEY ?? '';

  if (mode === 'development' && !amapKey) {
    console.warn(
      '\n[sun-drive] 未找到 AMAP_WEB_KEY，路线、天气与地点搜索将不可用。\n' +
        '            请在项目根目录 .env 中设置 AMAP_WEB_KEY。\n',
    );
  }

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },

    /** 独立生产构建目录，不覆盖任何现有网页产物 */
    build: {
      outDir: 'dist-sun-drive',
      emptyOutDir: true,
    },

    server: {
      host: '127.0.0.1',
      port: 5188,
      strictPort: true,
      proxy: createAmapProxy(env.AMAP_PROXY_TARGET, amapKey),
    },

    preview: {
      host: '127.0.0.1',
      port: 5189,
      strictPort: true,
      proxy: createAmapProxy(env.AMAP_PROXY_TARGET, amapKey),
    },
  };
});

/**
 * 开发/预览环境的高德代理。
 * 凭据只在 Node 侧注入，不会进入浏览器 bundle。
 */
function createAmapProxy(proxyTarget: string | undefined, amapKey: string) {
  return {
    '/amap-api': {
      target: proxyTarget || 'https://restapi.amap.com',
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/amap-api/, ''),
      configure: (proxy: {
        on: (
          event: 'proxyReq',
          listener: (proxyReq: { path: string }) => void,
        ) => void;
      }) => {
        proxy.on('proxyReq', (proxyReq) => {
          if (!proxyTarget && amapKey) {
            const url = new URL(proxyReq.path, 'https://restapi.amap.com');
            url.searchParams.set('key', amapKey);
            proxyReq.path = url.pathname + url.search;
          }
        });
      },
    },
  };
}
