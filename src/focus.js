// focus.js — 再描画をまたいでキーボードフォーカスを保つための汎用ユーティリティ。
//
// 各ビュー(timeline/people-view/person-detail/sources/search/relation-graph)は再描画のたびに
// container.innerHTML = '' でDOMを作り直す。素朴に呼ぶと、そのときフォーカスされていた要素が消えて
// フォーカスが <body> に落ちる(仕様§7.2「フォーカス位置が視認できる」の精神に反する。連続してキーボード
// 操作できなくなる=年代を1つ進めるたびに毎回Tabで最初から辿り直す必要が生じる)。
//
// 対応: 再描画で「同じ役割の要素」として復元してほしいDOM要素に data-focus-key 属性を振っておけば、
// renderPreservingFocus() が再描画後に同じキーを持つ要素を探してフォーカスを戻す(見つからなければ何もしない
// =操作していた場所が消えた場合に別の要素へ勝手に飛ばさない)。テキスト入力のカーソル位置
// (selectionStart/selectionEnd)も持てる要素なら復元する(検索欄の既存挙動と同じ)。

/**
 * container 内にフォーカスがあるときだけ、render() の前後でフォーカス位置を保存・復元する。
 * render は同期関数でも、Promise を返す非同期関数でもよい。
 *
 * @param {HTMLElement} container 再描画で中身が作り直される要素
 * @param {() => (void | Promise<void>)} render 実際の再描画処理(container.innerHTML='' を含む)
 * @returns {void | Promise<void>} render の戻り値がPromiseならフォーカス復元後に解決するPromiseを返す
 */
export function renderPreservingFocus(container, render) {
  const active = document.activeElement;
  const hadFocus = !!(container && active && container.contains(active));
  const focusKey =
    hadFocus && typeof active.getAttribute === 'function' ? active.getAttribute('data-focus-key') : null;
  const selStart = hadFocus && typeof active.selectionStart === 'number' ? active.selectionStart : null;
  const selEnd = hadFocus && typeof active.selectionEnd === 'number' ? active.selectionEnd : null;

  const restore = () => {
    if (!focusKey) return;
    const next = container.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
    if (!next) return; // 再描画後に同じ要素が消えていたら、別の場所へは飛ばさない(仕様§7.2)
    next.focus();
    if (selStart !== null && typeof next.setSelectionRange === 'function') {
      try {
        next.setSelectionRange(selStart, selEnd);
      } catch {
        // input type によっては setSelectionRange が使えない場合がある。無視してよい。
      }
    }
  };

  const result = render();
  if (result && typeof result.then === 'function') {
    return result.then(restore);
  }
  restore();
  return result;
}
