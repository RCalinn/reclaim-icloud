// Learns the iCloud Photos API endpoint from the requests icloud.com makes,
// then relays API calls from the review page through the logged-in iCloud tab.

const PHOTOS_RE =
  /^(https:\/\/[^/]*ckdatabasews\.icloud\.com\/database\/1\/com\.apple\.photos\.cloud\/production\/private)\/([^?]*)(\?.*)?$/;

let endpoint = null; // { base, query }

browser.storage.local.get('endpoint').then((r) => {
  if (r.endpoint && !endpoint) endpoint = r.endpoint;
});

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    const m = details.url.match(PHOTOS_RE);
    if (!m || details.method !== 'POST') return;
    const query = m[3] || '';
    if (!new URLSearchParams(query).get('dsid')) return;
    if (!endpoint || endpoint.base !== m[1] || endpoint.query !== query) {
      endpoint = { base: m[1], query };
      browser.storage.local.set({ endpoint });
    }
  },
  { urls: ['*://*.icloud.com/*'] }
);

async function findICloudTab() {
  const tabs = await browser.tabs.query({ url: 'https://www.icloud.com/*' });
  return tabs.find((t) => t.url.includes('/photos')) || tabs[0];
}

browser.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'status') {
    return { endpoint: !!endpoint, tab: !!(await findICloudTab()) };
  }
  if (msg.type === 'ck') {
    const tab = await findICloudTab();
    if (!tab) throw new Error('Open https://www.icloud.com/photos in a tab first.');
    if (!endpoint) throw new Error('Reload the iCloud Photos tab so the extension can see its API endpoint.');
    const url = `${endpoint.base}/${msg.path}${endpoint.query}`;
    return browser.tabs.sendMessage(tab.id, { type: 'fetch', url, body: msg.body }, { frameId: 0 });
  }
});

browser.browserAction.onClicked.addListener(() => {
  browser.tabs.create({ url: browser.runtime.getURL('review.html') });
});
