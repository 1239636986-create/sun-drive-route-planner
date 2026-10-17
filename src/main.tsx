import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './ui/App.js';

/**
 * 阳光驾驶路线 —— 独立地图产品入口
 *
 * 架构见 docs/q8-api-architecture-decision.md：
 *   前端不持有任何密钥，高德请求经 /amap-api 反向代理。
 *   若在无代理的纯静态环境打开，会看到「API 代理不可用」的引导提示。
 */

import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
