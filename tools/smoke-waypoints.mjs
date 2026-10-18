/**
 * 冒烟：打开页面 → 点途径点 → 搜索廊坊 → 开始分析 → 截图
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = '/opt/cursor/artifacts/screenshots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: '/usr/bin/google-chrome-stable',
  args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('CONSOLE', m.text());
});

await page.goto('http://127.0.0.1:5188/', { waitUntil: 'networkidle', timeout: 60_000 });
await page.getByText('天安门').first().waitFor({ timeout: 30_000 });
// 等初始路线
await page.waitForFunction(() => document.body.innerText.includes('km'), { timeout: 60_000 });
await page.screenshot({ path: `${OUT}/smoke-thick-route.png`, fullPage: false });
console.log('screenshot: smoke-thick-route.png');

const viaBtn = page.getByRole('button', { name: '＋ 途径点' });
await viaBtn.click();
const viaInput = page.locator('#waypoint-0');
await viaInput.waitFor({ timeout: 10_000 });
console.log('waypoint form opened');

await viaInput.fill('廊坊');
await viaInput.press('Enter');
// 等候选或自动选中（单结果 PlaceSearch 会直接 onSelect）
await page.waitForTimeout(3000);
const candidate = page.locator('.search-result').first();
if (await candidate.isVisible().catch(() => false)) {
  await candidate.click();
}
await page.locator('.waypoint-row .place-selected__text').waitFor({ timeout: 15_000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/smoke-waypoint-form.png`, fullPage: false });
console.log('screenshot: smoke-waypoint-form.png');

await page.getByRole('button', { name: '开始分析' }).click();
await page.getByText('途1', { exact: false }).first().waitFor({ timeout: 90_000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/smoke-waypoint-route.png`, fullPage: false });
console.log('screenshot: smoke-waypoint-route.png');

const body = await page.innerText('aside');
console.log('HAS_VIA1', body.includes('途1'));
console.log('SUMMARY_SNIP', body.slice(0, 400).replace(/\s+/g, ' '));

await browser.close();
console.log('OK');
