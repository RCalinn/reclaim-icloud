export const $ = (s) => document.querySelector(s);

export const icon = (id) => `<svg><use href="#i-${id}"/></svg>`;

export function setStatus(text, error = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('error', error);
}

// fraction in [0,1], 'indeterminate', or null to hide.
export function setProgress(p) {
  const el = $('#progress');
  el.classList.toggle('on', p !== null);
  el.classList.toggle('indeterminate', p === 'indeterminate');
  if (typeof p === 'number') el.style.setProperty('--p', p);
}
