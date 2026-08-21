// timeline.js — 時点セレクタ(仕様§3.2の11時点)を描画する。


/**
 * 仕様§3.2「主要時点」の11時点。ラベルは同章に列挙された事件名の要約(このアプリのナビゲーション用の見出しであり、
 * 人物・勢力についての史実断定ではないため出典は要さない)。
 */
export const TIME_POINTS = [
  { year: '1853', label: 'ペリー来航' },
  { year: '1854', label: '日米和親条約' },
  { year: '1858', label: '通商条約・将軍継嗣問題・安政の大獄' },
  { year: '1860', label: '桜田門外の変' },
  { year: '1862', label: '文久の改革・寺田屋事件・生麦事件' },
  { year: '1863', label: '攘夷実行・薩英戦争・八月十八日の政変' },
  { year: '1864', label: '池田屋事件・禁門の変・第一次長州征討' },
  { year: '1866', label: '薩長間の提携・第二次長州征討' },
  { year: '1867', label: '大政奉還・王政復古' },
  { year: '1868', label: '鳥羽・伏見の戦い・江戸開城・東北戦争' },
  { year: '1869', label: '箱館戦争終結' },
];

/**
 * 時点セレクタの選択肢の文言を組み立てる純関数。
 * 「その年」と「その年の出来事」だけを示す(データの整備状況は読者に見せない)。
 *
 * @param {{year: string, label: string}} timePoint
 * @returns {string}
 */
export function timePointOptionText(timePoint) {
  return `${timePoint.year}年 ${timePoint.label}`;
}

/**
 * @param {HTMLElement} container
 * @param {{year: string, onChange: (year: string) => void}} params
 */
export function renderTimeline(container, { year, onChange }) {
  container.innerHTML = '';

  const heading = document.createElement('h2');
  heading.className = 'section-heading';
  heading.textContent = '時点選択';
  container.appendChild(heading);

  const controls = document.createElement('div');
  controls.className = 'timeline-controls';

  const idx = TIME_POINTS.findIndex((tp) => tp.year === year);

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'timeline-nav-button';
  prevBtn.setAttribute('data-focus-key', 'timeline-prev');
  prevBtn.textContent = '← 前の時点';
  prevBtn.disabled = idx <= 0;
  prevBtn.addEventListener('click', () => onChange(TIME_POINTS[idx - 1].year));

  const selectLabel = document.createElement('label');
  selectLabel.className = 'sr-only';
  selectLabel.setAttribute('for', 'timeline-select');
  selectLabel.textContent = '時点(西暦年)を選択';

  const select = document.createElement('select');
  select.id = 'timeline-select';
  select.setAttribute('data-focus-key', 'timeline-select');
  for (const tp of TIME_POINTS) {
    const opt = document.createElement('option');
    opt.value = tp.year;
    opt.textContent = timePointOptionText(tp);
    if (tp.year === year) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => onChange(select.value));

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'timeline-nav-button';
  nextBtn.setAttribute('data-focus-key', 'timeline-next');
  nextBtn.textContent = '次の時点 →';
  nextBtn.disabled = idx === -1 || idx >= TIME_POINTS.length - 1;
  nextBtn.addEventListener('click', () => onChange(TIME_POINTS[idx + 1].year));

  controls.append(prevBtn, selectLabel, select, nextBtn);
  container.appendChild(controls);

}
