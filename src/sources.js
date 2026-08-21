// sources.js — 出典表示(仕様§6)。
// 出典を持つ項目は person-detail.js のボタンから onSelectSource(sourceId) を経由してここに到達する。
// URL を持つ出典は rel="noopener noreferrer" つきの新規タブリンクで開き、URL を持たない出典は
// 資料名・発行元・参照日・リンク・引用・注記を表示する(現在のデータは全件URLつきだが、将来 URL 無しの
// 出典が入っても壊れないよう分岐を残す)。

import { findSource } from './state.js';

function addRow(dl, term, value) {
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = value;
  dl.append(dt, dd);
}

/**
 * @param {HTMLElement} container
 * @param {{data: object, sourceId: string|null, onClose: () => void}} params
 */
export function renderSources(container, { data, sourceId, onClose }) {
  container.innerHTML = '';

  const heading = document.createElement('h2');
  heading.className = 'section-heading';
  heading.textContent = '出典';
  container.appendChild(heading);

  if (!sourceId) {
    const p = document.createElement('p');
    p.className = 'sources-empty';
    p.textContent = '人物・事件・勢力・地図の各項目にある「出典」ボタンを選ぶと、ここに詳細が表示されます。';
    container.appendChild(p);
    return;
  }

  const source = findSource(data, sourceId);
  if (!source) {
    const p = document.createElement('p');
    p.className = 'sources-empty';
    p.textContent = `出典 ${sourceId} が見つかりません。`;
    container.appendChild(p);
    return;
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'sources-close-button';
  closeBtn.setAttribute('data-focus-key', 'sources-close');
  closeBtn.textContent = '閉じる';
  closeBtn.addEventListener('click', () => onClose());
  container.appendChild(closeBtn);

  const title = document.createElement('h3');
  title.className = 'source-detail-title';
  title.textContent = source.title;
  container.appendChild(title);

  const meta = document.createElement('dl');
  meta.className = 'source-detail-meta';
  // 読者に必要なのは「どの資料か」と「原文で何と書いてあるか」。
  // 資料の分類・内部の確度スコア・取得手段は出さない(データとしては保持している)。
  addRow(meta, '発行元', source.publisher);
  if (source.accessed_at) addRow(meta, '参照日', source.accessed_at);
  container.appendChild(meta);

  if (source.url) {
    const urlP = document.createElement('p');
    urlP.className = 'source-detail-url';
    urlP.append('リンク: ');
    const a = document.createElement('a');
    a.href = source.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = source.url;
    urlP.appendChild(a);
    container.appendChild(urlP);
  } else {
    const noUrlP = document.createElement('p');
    noUrlP.className = 'source-detail-no-url';
    noUrlP.textContent = 'URLのない出典です(書誌情報のみを表示しています)。';
    container.appendChild(noUrlP);
  }

  const quoteLabel = document.createElement('p');
  quoteLabel.className = 'source-detail-quote-label';
  quoteLabel.textContent = '引用(原文の逐語コピー):';
  container.appendChild(quoteLabel);

  const quote = document.createElement('blockquote');
  quote.className = 'source-detail-quote';
  quote.textContent = source.quote || '(引用なし)';
  container.appendChild(quote);

  if (source.notes) {
    const notesP = document.createElement('p');
    notesP.className = 'source-detail-notes';
    notesP.textContent = source.notes;
    container.appendChild(notesP);
  }
}
