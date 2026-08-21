// router.js — ブラウザ履歴(history API)との橋渡しのみを担当する薄いモジュール。
// 状態⇔URL文字列の変換ロジック自体は state.js に置く(責務分離)。

import { readStateFromUrl, stateToSearchParams } from './state.js';

/**
 * 状態をURLに反映する。
 * @param {object} state - {year, personId, query, sourceId, view, eventId, factionId, placeId, mapMode}
 * @param {{replace?: boolean}} options - replace:true なら履歴を積まずに置き換える(検索入力中の連打対策)
 */
export function navigate(state, { replace = false } = {}) {
  const params = stateToSearchParams(state);
  const url = `${window.location.pathname}?${params.toString()}`;
  if (replace) {
    window.history.replaceState(state, '', url);
  } else {
    window.history.pushState(state, '', url);
  }
}

/**
 * ブラウザの戻る/進む操作(popstate)を検知し、URLから復元した状態でコールバックを呼ぶ。
 * リロード時は popstate が発火しないが、初期状態は呼び出し側が readStateFromUrl() を直接使えばよい。
 */
export function initRouter(onPopState) {
  window.addEventListener('popstate', () => {
    onPopState(readStateFromUrl());
  });
}
