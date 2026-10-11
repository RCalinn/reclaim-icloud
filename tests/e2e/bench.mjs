// Scan-speed benchmark: first-scan time for the fake library under a given CDN latency / 429 rate.
// Usage: node tests/e2e/bench.mjs [latencyMs] [throttleShare] [bursts ≈ photos/3.5]
import { Builder, By } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { start } from './server.mjs';

const [latency = 100, throttle = 0, bursts = 300] = process.argv.slice(2).map(Number);
const { server, count, stats } = await start(8765, { latency, throttle, bursts });
const opts = new firefox.Options().addArguments('-headless');
opts.setBinary(process.env.FIREFOX || '/Applications/Firefox.app/Contents/MacOS/firefox');
// iCloud's CDN speaks HTTP/2 (many requests share one connection); the local test server is
// HTTP/1.1, so lift Firefox's 6-connections-per-host cap to compare fairly.
opts.setPreference('network.http.max-persistent-connections-per-server', 64);
const d = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).build();
const times = [];
for (let run = 0; run < 3; run++) {
  await d.get('http://localhost:8765/__h/test.html');
  await d.executeScript('localStorage.clear()');
  await d.navigate().refresh();
  await d.findElement(By.css('.empty'));
  const t = Date.now();
  await d.findElement(By.id('scan')).click();
  if (run === 0) { await d.sleep(4000); console.log('mid-scan:', await d.executeScript(`return document.getElementById('status').textContent`)); }
  await d.wait(async () => /^Scanned/.test(await d.executeScript(`return document.getElementById('status').textContent`)), 120000);
  times.push(Date.now() - t);
  console.log('page-side peak', await d.executeScript('return window.__fetch.peak'), 'server peak so far', stats.peak);
  if (run === 0) console.log(await d.executeScript(`return document.getElementById('status').textContent`));
}
await d.quit();
server.close();
times.sort((a, b) => a - b);
console.log(`${count} photos, latency ${latency} ms, ${throttle * 100}% 429s: median first scan ${times[1]} ms (${(count / times[1] * 1000).toFixed(0)}/s), peak ${stats.peak} downloads at once`);
