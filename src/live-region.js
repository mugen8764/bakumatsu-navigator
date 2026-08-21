// live-region.js — 常設の aria-live 領域を介した読み上げ通知。
//
// 各ビュー(search.js / person-detail.js / relation-graph.js など)は container.innerHTML = '' で
// 再描画するため、ビューの内側に aria-live 属性つきの要素を置いても、再描画のたびに要素ごと破棄され
// 中身入りで新規挿入される。多くのスクリーンリーダーはこのパターンを読み上げない
// (ライブリージョンは変更が起きる前から DOM に存在している必要がある)。
//
// 対応: どのビューにも属さない常設の要素 #a11y-live を1つだけ用意し、通知したい文言は
// この要素の textContent を書き換えることで届ける(要素自体は作り直さない)。
//
// #a11y-live は index.html 側に常設要素として置かれている想定だが、
// 読み込み順やタイミングの前後に関わらず壊れないよう、無ければここで自分で body 直下に作る。

const LIVE_REGION_ID = 'a11y-live';

/** 視覚的に隠す最低限のインラインスタイル(styles.css の .visually-hidden が無くても壊れないためのフォールバック)。 */
function applyVisuallyHiddenFallbackStyle(el) {
  el.style.position = 'absolute';
  el.style.width = '1px';
  el.style.height = '1px';
  el.style.overflow = 'hidden';
  el.style.clip = 'rect(0, 0, 0, 0)';
  el.style.whiteSpace = 'nowrap';
  el.style.border = '0';
  el.style.padding = '0';
  el.style.margin = '-1px';
}

/** #a11y-live を取得する。存在しなければ body 直下に作る(index.html 側の常設要素と競合しない)。 */
function ensureLiveRegion() {
  let el = document.getElementById(LIVE_REGION_ID);
  if (el) return el;

  el = document.createElement('div');
  el.id = LIVE_REGION_ID;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  el.className = 'visually-hidden';
  applyVisuallyHiddenFallbackStyle(el);
  document.body.appendChild(el);
  return el;
}

/**
 * スクリーンリーダーへ通知したい文言を、常設のライブリージョンへ流し込む。
 * 同じ文字列を連続で流しても DOM 上は変化が無いため再読み上げされない場合があるが、
 * これは元の(壊れていた)実装でも起きていた挙動ではなく新たな制約であり、現状は許容する
 * (呼び出し側が変化のあるタイミングでのみ呼ぶ前提)。
 * @param {string} message
 */
export function announce(message) {
  const el = ensureLiveRegion();
  el.textContent = message || '';
}
