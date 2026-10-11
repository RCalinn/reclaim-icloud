// Runs in the icloud.com tab. `content.fetch` sends the request as the page itself
// (same origin + session cookies), so iCloud treats it like its own traffic.

const pageFetch = typeof content !== 'undefined' && content.fetch ? content.fetch : fetch;

if (window.top === window) {
  browser.runtime.onMessage.addListener(async (msg) => {
    if (msg.type !== 'fetch') return;
    const res = await pageFetch(msg.url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(msg.body),
    });
    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 421 ? ' (session expired? reload icloud.com)' : '';
      throw new Error(`iCloud ${res.status}${hint}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text);
  });
}
