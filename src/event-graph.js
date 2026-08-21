// event-graph.js — 事件の因果グラフ(仕様§4.10)。
// T2 が単独で所有するファイル。app.js / index.html / styles.css / data/ には触れない。
// 配信JSは外部依存ゼロ: SVGは document.createElementNS で自前生成する(ライブラリ・力学シミュレーション不使用)。
//
// 方針:
// - 因果は「向き」が本質なので、相関図(同心円)と違い**時系列の縦方向レイアウト**にする。
//   位置は日付順で決まる決定論的レイアウト(乱数・シミュレーションを使わないので描画が毎回同じ)。
// - 関係の種類8種を色だけで区別しない(仕様§7.2): 線種(dasharray)+ 日本語ラベル文字 + aria-label を併用する。
// - SVG の直後に必ずテキスト代替の <table> を置く(仕様§7.2)。表からも事件へ移動でき、出典の書誌情報へ到達できる。
// - data/event-relations.json が空配列・読み込み失敗でも壊れず、その節を出さないだけにする。


const SVG_NS = 'http://www.w3.org/2000/svg';

/** 仕様§4.10「因果関係の種類」8種 → 日本語ラベル(データ側は snake_case)。 */
const EVENT_RELATION_TYPE_LABELS = {
  direct_cause: '直接原因',
  background: '背景',
  reaction: '反動',
  military_result: '軍事的結果',
  political_result: '政治的結果',
  long_term_effect: '長期的影響',
  person_stance_change: '人物の立場変化',
  faction_relation_change: '勢力関係の変化',
};

/**
 * 8種を線種でも区別する(色だけに頼らない。仕様§7.2)。
 * 実線=直接の因果、破線=間接・背景的なもの、点線=変化の記述、と系統を分けてある。
 */
const EVENT_RELATION_DASH = {
  direct_cause: null, // 実線
  background: '8 5',
  reaction: '2 4',
  military_result: '12 4 2 4',
  political_result: '6 3 2 3',
  long_term_effect: '14 6',
  person_stance_change: '1 5',
  faction_relation_change: '10 4 1 4 1 4',
};

/** marker の id 衝突を避けるための連番(同一ページに複数のグラフが描かれても壊れないように)。 */
let graphInstanceSeq = 0;

/**
 * relation_type(snake_case) を日本語ラベルへ変換する純関数。
 * 未知の値は捏造せずそのまま返す。null/undefined は、因果の種類まで特定できる資料に到達していない
 * ことを示す正当な状態(schema 上も null を許容)なので、空欄にせず
 * 種類が無い関係では種類欄を空にする(relation-graph.js の relationTypeLabel とは
 * 別ファイル・別データ契約のため、そちらは「不明」のままでよい)。
 * @param {string|null|undefined} relationType
 * @returns {string}
 */
export function eventRelationTypeLabel(relationType) {
  if (relationType === null || relationType === undefined) return '';
  return EVENT_RELATION_TYPE_LABELS[relationType] ?? String(relationType);
}

/** 8種の値域(スキーマと実装のずれを検出できるよう公開する)。 */
export const EVENT_RELATION_TYPES = Object.keys(EVENT_RELATION_TYPE_LABELS);

/**
 * ある事件の前後の因果を返す純関数。入力は変更しない。
 * @param {object[]} eventRelations data/event-relations.json の配列(無ければ空配列でよい)
 * @param {string} eventId
 * @returns {{incoming: object[], outgoing: object[]}}
 *   incoming = その事件を結果(to_event_id)とする関係 = 原因側
 *   outgoing = その事件を原因(from_event_id)とする関係 = 結果側
 */
export function eventRelationsFor(eventRelations, eventId) {
  const empty = { incoming: [], outgoing: [] };
  if (!Array.isArray(eventRelations) || !eventId) return empty;
  return {
    incoming: eventRelations.filter((r) => r && r.to_event_id === eventId),
    outgoing: eventRelations.filter((r) => r && r.from_event_id === eventId),
  };
}

/** 日付文字列から西暦年(number)を取り出す。解釈できなければ null。 */
function extractYear(value) {
  if (value === null || value === undefined || value === '') return null;
  const m = String(value).match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

function createSvgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    el.setAttribute(key, value);
  }
  return el;
}

function findById(list, id) {
  if (!Array.isArray(list)) return null;
  return list.find((item) => item && item.id === id) || null;
}

/**
 * 日付文字列を [最早, 最遅] の範囲(YYYY-MM-DD の文字列2つ)へ正規化する純関数。
 *
 * データの日付は粒度がまちまちで(出典が年までしか書いていなければ年までしか入れない=捏造しない)、
 * そのまま文字列比較すると "1858" < "1858-07-29" となり、粗い日付が必ず古い側に来てしまう。
 * ここでは粒度を「その日付が取りうる範囲」として表す。
 *
 *   "1858"       -> ['1858-01-01', '1858-12-31']
 *   "1866-06"    -> ['1866-06-01', '1866-06-30']
 *   "1858-07-29" -> ['1858-07-29', '1858-07-29']
 *   null / 解釈できない値 -> null(推測で補わない)
 *
 * @param {string|null|undefined} value
 * @returns {{min: string, max: string}|null}
 */
export function dateRange(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) return { min: s, max: s };
  const ym = s.match(/^(\d{4})-(\d{2})$/);
  if (ym) {
    const year = Number(ym[1]);
    const month = Number(ym[2]);
    if (month < 1 || month > 12) return null;
    // Date.UTC の day=0 は「前月の末日」。月の日数をカレンダーに計算させる(閏年も含む)。
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { min: `${ym[1]}-${ym[2]}-01`, max: `${ym[1]}-${ym[2]}-${String(lastDay).padStart(2, '0')}` };
  }
  const y = s.match(/^(\d{4})$/);
  if (y) return { min: `${y[1]}-01-01`, max: `${y[1]}-12-31` };
  return null;
}

/** eventRelations から「原因 → 結果」の到達可能性を引く関数を作る(推移的な因果もたどる)。 */
function causalReachability(eventRelations) {
  const edges = new Map();
  for (const r of Array.isArray(eventRelations) ? eventRelations : []) {
    if (!r || !r.from_event_id || !r.to_event_id) continue;
    if (!edges.has(r.from_event_id)) edges.set(r.from_event_id, new Set());
    edges.get(r.from_event_id).add(r.to_event_id);
  }
  return function reaches(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return false;
    const seen = new Set([fromId]);
    const stack = [fromId];
    while (stack.length > 0) {
      const next = edges.get(stack.pop());
      if (!next) continue;
      for (const id of next) {
        if (id === toId) return true;
        if (seen.has(id)) continue; // 循環しても止まる
        seen.add(id);
        stack.push(id);
      }
    }
    return false;
  };
}

/**
 * 事件を「上ほど古い時点」の順に並べる比較関数を作る純関数。
 *
 * 日付の範囲が重ならなければ日付順。**範囲が重なって日付だけでは順序が決まらないときは因果で決める**
 * (`from_event_id` の事件を `to_event_id` の事件より前に置く)。因果グラフは「原因 → 結果」を描くもので、
 * 原因が結果より後に起きることはないため、粒度不足を補う根拠として正当。
 * それでも決まらなければ id 順(表示が入力順に左右されない=決定論的レイアウトの前提)。
 * 日付が解釈できない事件は末尾へ。
 *
 * @param {object[]} eventRelations 因果エッジ(無くてよい。その場合は日付と id だけで決まる)
 * @returns {(a: object, b: object) => number}
 */
export function compareEventsChronologically(eventRelations) {
  const reaches = causalReachability(eventRelations);
  return function compare(a, b) {
    const ar = dateRange(a?.start_date);
    const br = dateRange(b?.start_date);
    if (ar && br) {
      if (ar.max < br.min) return -1; // 範囲が重ならない = 日付だけで決まる
      if (br.max < ar.min) return 1;
      // 範囲が重なる = 日付では決まらない。因果があればそれに従う
      if (reaches(a.id, b.id)) return -1;
      if (reaches(b.id, a.id)) return 1;
    } else if (ar) {
      return -1; // 日付不明は末尾
    } else if (br) {
      return 1;
    }
    return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
  };
}

/**
 * 図に描く事件を決める純関数。
 * 因果関係の両端にある事件(model.events に存在するもの)+ 選択中の事件を、日付の昇順に並べて返す。
 * 孤立ノードを増やさないため、因果に登場しない事件は(選択中でない限り)描かない。
 */
export function eventsForGraph(events, eventRelations, selectedEventId = null) {
  const all = Array.isArray(events) ? events : [];
  const rels = Array.isArray(eventRelations) ? eventRelations : [];
  const ids = new Set();
  for (const r of rels) {
    if (!r) continue;
    if (all.some((e) => e.id === r.from_event_id)) ids.add(r.from_event_id);
    if (all.some((e) => e.id === r.to_event_id)) ids.add(r.to_event_id);
  }
  if (selectedEventId && all.some((e) => e.id === selectedEventId)) ids.add(selectedEventId);
  return all.filter((e) => ids.has(e.id)).sort(compareEventsChronologically(rels));
}

/** 事件名の見出し文字列(年つき)。名前が無ければ ID を出す(捏造しない)。 */
function nodeLabel(event) {
  return event?.name || event?.id || '';
}

/**
 * 因果グラフ(SVG)+ テキスト代替の表を container に描画する。純関数ではない(DOMを書き換える)。
 *
 * @param {HTMLElement} container 中身を空にして描画してよい
 * @param {{events: object[], eventRelations: object[], selectedEventId: string|null, sources: object[]}} model
 * @param {{onSelectEvent?: (eventId: string) => void, onSelectSource?: (sourceId: string) => void}} handlers
 */
export function renderEventGraph(container, model, handlers) {
  if (!container) return;
  const {
    events = [],
    eventRelations = [],
    selectedEventId = null,
    sources = [],
  } = model || {};
  const onSelectEvent = typeof handlers?.onSelectEvent === 'function' ? handlers.onSelectEvent : null;
  const onSelectSource = typeof handlers?.onSelectSource === 'function' ? handlers.onSelectSource : null;

  container.innerHTML = '';
  container.classList.add('event-graph');

  const heading = document.createElement('h2');
  heading.className = 'section-heading';
  heading.textContent = '事件の因果グラフ';
  container.appendChild(heading);

  const rels = Array.isArray(eventRelations) ? eventRelations : [];
  const nodes = eventsForGraph(events, rels, selectedEventId);
  const nodeIndex = new Map(nodes.map((e, i) => [e.id, i]));
  // 図に描く因果は、両端が図のノードとして存在するものだけ(表もこれに揃え、視覚とテキスト代替を一致させる)。
  const edges = rels.filter((r) => r && nodeIndex.has(r.from_event_id) && nodeIndex.has(r.to_event_id));

  if (rels.length === 0 || nodes.length === 0) {
    const p = document.createElement('p');
    p.className = 'data-gap-notice';
    p.setAttribute('role', 'note');
    p.textContent = '表示できる因果関係がありません。';
    container.appendChild(p);
    return;
  }

  // ---- レイアウト(決定論的。日付順に上から下へ) ----
  const nodeHeight = 40;
  const rowGap = 108;
  const marginY = 28;
  const charWidth = 15;
  const boxWidths = nodes.map((e) => Math.max(132, nodeLabel(e).length * charWidth + 28));
  const maxBox = Math.max(...boxWidths);
  const width = Math.max(440, Math.round(maxBox + 240));
  const height = marginY * 2 + nodeHeight + (nodes.length - 1) * rowGap;
  const cx = width / 2;

  const positions = nodes.map((e, i) => ({
    id: e.id,
    cx,
    cy: marginY + nodeHeight / 2 + i * rowGap,
    w: boxWidths[i],
    h: nodeHeight,
  }));

  const uid = `event-graph-${++graphInstanceSeq}`;
  const svg = createSvgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'event-graph-svg',
    role: 'img',
    'aria-label': `事件の因果グラフ。事件${nodes.length}件、因果${edges.length}件。上ほど古い時点、矢印は原因から結果へ向かう。`,
  });

  // 矢印マーカー(通常/選択)。色だけでなく線の太さでも選択を示す。
  const defs = createSvgEl('defs');
  for (const variant of ['normal', 'selected']) {
    const marker = createSvgEl('marker', {
      id: `${uid}-arrow-${variant}`,
      viewBox: '0 0 10 10',
      refX: '9',
      refY: '5',
      markerWidth: '7',
      markerHeight: '7',
      orient: 'auto-start-reverse',
      markerUnits: 'userSpaceOnUse',
    });
    const head = createSvgEl('path', {
      d: 'M 0 0 L 10 5 L 0 10 z',
      class: variant === 'selected' ? 'event-graph-arrow-head event-graph-arrow-head--selected' : 'event-graph-arrow-head',
    });
    marker.appendChild(head);
    defs.appendChild(marker);
  }
  svg.appendChild(defs);

  // ---- 因果線(edge) ----
  const edgesLayer = createSvgEl('g', { class: 'event-graph-edges' });
  let curvedSeq = 0;

  edges.forEach((relation) => {
    const fromIdx = nodeIndex.get(relation.from_event_id);
    const toIdx = nodeIndex.get(relation.to_event_id);
    const from = positions[fromIdx];
    const to = positions[toIdx];
    if (!from || !to || from === to) return;

    const downward = from.cy < to.cy;
    const startX = from.cx;
    const startY = downward ? from.cy + from.h / 2 : from.cy - from.h / 2;
    const endX = to.cx;
    const endY = downward ? to.cy - to.h / 2 - 8 : to.cy + to.h / 2 + 8;

    const skips = Math.abs(toIdx - fromIdx) > 1;
    let d;
    let labelX;
    let labelY;
    if (!skips) {
      d = `M ${startX} ${startY} L ${endX} ${endY}`;
      labelX = (startX + endX) / 2;
      labelY = (startY + endY) / 2;
    } else {
      // 隣接しない事件同士の線は、間のノードに重ならないよう横へ膨らませる(左右交互で重なりを減らす)。
      const side = curvedSeq % 2 === 0 ? 1 : -1;
      const bulge = maxBox / 2 + 40 + Math.floor(curvedSeq / 2) * 26;
      curvedSeq += 1;
      const ctrlX = cx + side * bulge * 2; // 二次ベジェの実際の膨らみは制御点の半分
      const ctrlY = (startY + endY) / 2;
      d = `M ${startX} ${startY} Q ${ctrlX} ${ctrlY} ${endX} ${endY}`;
      labelX = (startX + 2 * ctrlX + endX) / 4;
      labelY = (startY + 2 * ctrlY + endY) / 4;
    }

    const isSelected =
      selectedEventId !== null &&
      (relation.from_event_id === selectedEventId || relation.to_event_id === selectedEventId);

    const fromEvent = findById(nodes, relation.from_event_id);
    const toEvent = findById(nodes, relation.to_event_id);
    const typeLabel = eventRelationTypeLabel(relation.relation_type);

    const edgeGroup = createSvgEl('g', {
      class: `event-graph-edge${isSelected ? ' event-graph-edge-selected' : ''}`,
      tabindex: '0',
      role: 'button',
      'aria-label': `${nodeLabel(fromEvent)} から ${nodeLabel(toEvent)} への因果: ${typeLabel}。${relation.description || ''} 選択すると ${nodeLabel(toEvent)} の詳細へ移動します。`,
      'data-focus-key': `event-edge-${relation.id}`,
    });

    const path = createSvgEl('path', {
      d,
      class: 'event-graph-edge-line',
      fill: 'none',
      'stroke-dasharray': EVENT_RELATION_DASH[relation.relation_type] ?? null,
      'marker-end': `url(#${uid}-arrow-${isSelected ? 'selected' : 'normal'})`,
    });
    edgeGroup.appendChild(path);

    // 種類ラベル(色だけに頼らず、常に文字で因果の種類を示す)。
    const labelWidth = typeLabel.length * 11 + 10;
    const clampedX = Math.min(Math.max(labelX, labelWidth / 2 + 4), width - labelWidth / 2 - 4);
    const labelBg = createSvgEl('rect', {
      class: 'event-graph-edge-label-bg',
      x: clampedX - labelWidth / 2,
      y: labelY - 10,
      width: labelWidth,
      height: 18,
      rx: 4,
    });
    const labelText = createSvgEl('text', {
      x: clampedX,
      y: labelY + 3,
      class: 'event-graph-edge-label',
      'text-anchor': 'middle',
    });
    labelText.textContent = typeLabel;
    edgeGroup.append(labelBg, labelText);

    // 因果線を選択したら結果側の事件へ移動する(handlers に onSelectRelation が無いため。契約どおり)。
    if (onSelectEvent) {
      const activate = () => onSelectEvent(relation.to_event_id);
      edgeGroup.addEventListener('click', activate);
      edgeGroup.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      });
    }

    edgesLayer.appendChild(edgeGroup);
  });
  svg.appendChild(edgesLayer);

  // ---- 事件ノード ----
  const nodesLayer = createSvgEl('g', { class: 'event-graph-nodes' });
  nodes.forEach((event, i) => {
    const pos = positions[i];
    const isSelected = event.id === selectedEventId;
    const year = extractYear(event.start_date);

    const nodeGroup = createSvgEl('g', {
      class: `event-graph-node${isSelected ? ' event-graph-node-selected' : ''}`,
      tabindex: '0',
      role: 'button',
      'aria-pressed': String(isSelected),
      'aria-label': year !== null ? `${nodeLabel(event)}(${year}年)の事件詳細を表示` : `${nodeLabel(event)}の事件詳細を表示`,
      transform: `translate(${pos.cx}, ${pos.cy})`,
      'data-focus-key': `event-node-${event.id}`,
    });

    const rect = createSvgEl('rect', {
      class: 'event-graph-node-box',
      x: -pos.w / 2,
      y: -pos.h / 2,
      width: pos.w,
      height: pos.h,
      rx: 6,
    });
    const text = createSvgEl('text', {
      class: 'event-graph-node-label',
      'text-anchor': 'middle',
      y: -1,
    });
    text.textContent = nodeLabel(event);
    const yearText = createSvgEl('text', {
      class: 'event-graph-node-year',
      'text-anchor': 'middle',
      y: 13,
    });
    yearText.textContent = year !== null ? `${year}年` : '年不明';

    nodeGroup.append(rect, text, yearText);

    if (onSelectEvent) {
      const activate = () => onSelectEvent(event.id);
      nodeGroup.addEventListener('click', activate);
      nodeGroup.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      });
    }

    nodesLayer.appendChild(nodeGroup);
  });
  svg.appendChild(nodesLayer);

  container.appendChild(svg);

  // ---- テキスト代替の表(仕様§7.2。SVGの直後に置く) ----
  const table = document.createElement('table');
  table.className = 'event-graph-table';

  const caption = document.createElement('caption');
  caption.className = 'eg-visually-hidden';
  caption.textContent = '因果グラフのテキスト代替(原因 → 結果)';
  table.appendChild(caption);

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['原因(前の事件)', '因果の種類', '結果(次の事件)', '説明', '出典']) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (edges.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.textContent = '表示できる因果関係がありません。';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    for (const relation of edges) {
      const tr = document.createElement('tr');
      const isSelected =
        selectedEventId !== null &&
        (relation.from_event_id === selectedEventId || relation.to_event_id === selectedEventId);
      if (isSelected) tr.className = 'event-graph-table-row-selected';

      const appendEventCell = (eventId, keySuffix) => {
        const td = document.createElement('td');
        const event = findById(nodes, eventId);
        const label = nodeLabel(event) === eventId ? eventId : nodeLabel(event);
        if (onSelectEvent) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'event-graph-table-event-button';
          btn.setAttribute('data-focus-key', `event-table-${keySuffix}-${relation.id}`);
          btn.setAttribute('aria-label', `${label} の事件詳細を表示`);
          btn.textContent = label;
          btn.addEventListener('click', () => onSelectEvent(eventId));
          td.appendChild(btn);
        } else {
          td.textContent = label;
        }
        tr.appendChild(td);
      };

      appendEventCell(relation.from_event_id, 'from');

      const tdType = document.createElement('td');
      tdType.textContent = eventRelationTypeLabel(relation.relation_type);
      tr.appendChild(tdType);

      appendEventCell(relation.to_event_id, 'to');

      const tdDesc = document.createElement('td');
      tdDesc.textContent = relation.description || '';
      tr.appendChild(tdDesc);


      const tdSources = document.createElement('td');
      const srcIds = Array.isArray(relation.source_ids) ? relation.source_ids : [];
      if (srcIds.length === 0) {
        tdSources.textContent = '';
      } else {
        srcIds.forEach((sid, i) => {
          const src = findById(sources, sid);
          const label = src ? src.title : `${sid}(見つかりません)`;
          if (onSelectSource) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'event-graph-source-button';
            btn.setAttribute('data-focus-key', `event-graph-source-${relation.id}-${sid}`);
            btn.setAttribute('aria-label', `出典 ${label} の書誌情報を表示`);
            btn.textContent = label;
            btn.addEventListener('click', () => onSelectSource(sid));
            tdSources.appendChild(btn);
          } else {
            const span = document.createElement('span');
            span.textContent = label;
            tdSources.appendChild(span);
          }
          if (i < srcIds.length - 1) tdSources.appendChild(document.createTextNode(' '));
        });
      }
      tr.appendChild(tdSources);

      tbody.appendChild(tr);
    }
  }
  table.appendChild(tbody);
  container.appendChild(table);

  // ---- 凡例(線種と種類の対応。色だけで区別しないための併記) ----
  const usedTypes = [...new Set(edges.map((r) => r.relation_type))];
  if (usedTypes.length > 0) {
    const legend = document.createElement('p');
    legend.className = 'event-graph-legend';
    legend.textContent = `この図に出ている因果の種類: ${usedTypes.map((t) => eventRelationTypeLabel(t)).join('、')}(線の種類と線上の文字で区別しています)`;
    container.appendChild(legend);
  }
}
