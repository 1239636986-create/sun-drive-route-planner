/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

/**
 * Vitest 独立配置。
 *
 * 与 vite.config.ts 分开的原因：
 *   vite.config.ts 的 `test` 字段在 Vite 的类型里不存在（那是 Vitest 的扩展），
 *   混在一起会让 `tsc --noEmit` 报错。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    // domain 层是纯函数，不需要 DOM
    // 若将来加 UI 测试，用 environmentMatchGlobs 给 .tsx 单独指定 jsdom
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
  },
});
