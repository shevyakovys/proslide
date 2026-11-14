// Optional presentation styles: old slides keep theme defaults.
export function normalizeTextStyle(value = {}) {
  const style = value && typeof value === 'object' ? value : {};
  const size = (v, fallback, min, max) => Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Math.min(max, Math.max(min, Number(v)))) : fallback;
  const color = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null;
  return { titleSize: size(style.titleSize, 44, 24, 96), bodySize: size(style.bodySize, 20, 12, 48), titleColor: color(style.titleColor), bodyColor: color(style.bodyColor) };
}
export function slideStyle(slide) {
  if (!slide.textStyle) return '';
  const s = normalizeTextStyle(slide.textStyle);
  return `--title-size:${s.titleSize}px;--body-size:${s.bodySize}px;${s.titleColor ? `--title-color:${s.titleColor};` : ''}${s.bodyColor ? `--body-color:${s.bodyColor};` : ''}`;
}
export function moveSlide(slides, from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= slides.length || to >= slides.length) return slides.slice();
  const next = slides.slice(), [slide] = next.splice(from, 1); next.splice(to, 0, slide); return next;
}
export function answerCount(n) {
  const last = n % 10, hundred = n % 100;
  return `${n} ${last === 1 && hundred !== 11 ? 'ответ' : last >= 2 && last <= 4 && (hundred < 12 || hundred > 14) ? 'ответа' : 'ответов'}`;
}
