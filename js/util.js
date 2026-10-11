export function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function fmtWindow(s) {
  return s < 60 ? `${s}s` : s < 3600 ? `${s / 60} min` : `${s / 3600} h`;
}

// Runs fn over xs in parallel; the number of parallel jobs adapts: it grows by one after each full round
// without trouble (up to max) and drops by 30% when a job calls throttle() (down to min).
// (Halving was too timid: occasional 429s then made it slower than a fixed pool.)
// fn(x, throttle) runs per item; errors are the caller's business (catch inside fn).
export function adaptivePool(xs, { start, min, max }, fn) {
  const ctl = { limit: start, peak: start };
  let i = 0, active = 0, streak = 0, cooldown = 0;
  const throttle = () => {
    const now = Date.now();
    if (now < cooldown) return; // one cut per burst of 429s, not one per request
    cooldown = now + 2000;
    ctl.limit = Math.max(min, Math.floor(ctl.limit * 0.7));
    streak = 0;
  };
  return new Promise((resolve) => {
    const pump = () => {
      while (active < ctl.limit && i < xs.length) {
        const x = xs[i++];
        active++;
        Promise.resolve()
          .then(() => fn(x, throttle))
          .catch(() => {})
          .finally(() => {
            active--;
            if (++streak >= ctl.limit && Date.now() >= cooldown) {
              streak = 0;
              ctl.limit = Math.min(max, ctl.limit + 1);
              ctl.peak = Math.max(ctl.peak, ctl.limit);
            }
            if (i >= xs.length && !active) resolve(ctl);
            else pump();
          });
      }
      if (!xs.length) resolve(ctl);
    };
    pump();
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(status) { super(`HTTP ${status}`); this.status = status; }
}
export const isExpired = (e) => [401, 403, 404, 410].includes(e?.status);
