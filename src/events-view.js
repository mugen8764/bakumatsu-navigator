// events-view.js — 事件一覧・事件詳細(仕様§4.9)。
// 配信JSは外部依存ゼロ(相対 import のみ。ここでは確度ラベルの正典を state.js から取るだけ)。
//
// 方針:
// - 仕様§4.9 が挙げる表示項目のうち、値があるものだけを並べる(推測で補完しない。person-detail.js と同じ作法)。
// - 値が無い項目・対応するデータ項目が無い項目は、行ごと描画しない。
//   どの項目が埋まっているかは純関数 eventDetailFieldStates() で数えられるようにしてある
//   (画面には出さない。次にどこを埋めるかを開発側で把握するため)。
// - 関連人物・勢力・地点・前後の事件・出典は必ずボタンにして handlers 経由で移動できるようにする
//   (面をまたぐ相互移動。出典は ID 止まりにせず書誌情報まで解決してから出す)。

import { eventRelationTypeLabel, compareEventsChronologically } from './event-graph.js';

/**
 * 仕様§4.9 の表示項目。並び順は仕様の記載順。
 * kind:
 *   'text'     … 文字列フィールド。'' や null は値なし
 *   'list'     … 文字列配列フィールド。空配列は値なし
 *   'date'     … start_date / end_date から組み立てる
 *   'places' | 'people' | 'factions' | 'events' | 'sources' … ID配列 → ボタン化
 *   'absent'   … 現在のデータ設計に対応するフィールドが無い(= 常に「データ項目なし」)
 */
export const EVENT_DETAIL_FIELDS = [
  { key: 'name', label: '事件名', kind: 'text', field: 'name' },
  { key: 'date', label: '日付', kind: 'date' },
  { key: 'era_label', label: '元号', kind: 'text', field: 'era_label' },
  { key: 'place_ids', label: '発生地', kind: 'places', field: 'place_ids' },
  { key: 'background', label: '長期的背景', kind: 'text', field: 'background' },
  { key: 'direct_causes', label: '直接の原因', kind: 'list', field: 'direct_causes' },
  { key: 'participants', label: '当事者', kind: 'absent', note: '関連人物・関連勢力は下に出しているが、「当事者」を区別して持つデータ項目はまだ無い。' },
  { key: 'participant_goals', label: '各当事者の目的', kind: 'absent', note: '対応するデータ項目が未設計。' },
  { key: 'issue_ids', label: '主要な争点', kind: 'list', field: 'issue_ids' },
  { key: 'description', label: '事件の経過', kind: 'text', field: 'description' },
  { key: 'immediate_results', label: '直後の結果', kind: 'list', field: 'immediate_results' },
  { key: 'long_term_effects', label: '数年後への影響', kind: 'list', field: 'long_term_effects' },
  { key: 'beneficiaries', label: '有利になった人物・勢力', kind: 'absent', note: '対応するデータ項目が未設計。' },
  { key: 'losers', label: '不利になった人物・勢力', kind: 'absent', note: '対応するデータ項目が未設計。' },
  { key: 'previous_event_ids', label: '前の事件', kind: 'events', field: 'previous_event_ids' },
  { key: 'next_event_ids', label: '次に読むべき事件', kind: 'events', field: 'next_event_ids' },
  { key: 'person_ids', label: '関連人物', kind: 'people', field: 'person_ids' },
  { key: 'faction_ids', label: '関連勢力', kind: 'factions', field: 'faction_ids' },
  { key: 'related_place_ids', label: '関連地点', kind: 'absent', note: '現在のデータは発生地(place_ids)だけを持ち、発生地以外の関連地点は区別していない。' },
  { key: 'source_ids', label: '出典', kind: 'sources', field: 'source_ids' },
  { key: 'caveats', label: '諸説・注意事項', kind: 'absent', note: 'レコード全体の確度(review_status)のみを持つ。個別の異説を書く項目は未設計。' },
];


function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * 事件1件について、仕様§4.9 の各項目が埋まっているかを返す純関数(データの整備状況を内部で数える用)。
 * @param {object|null} event data/events.json の1レコード
 * @returns {{key: string, label: string, status: 'filled'|'missing'|'no_field'}[]}
 */
export function eventDetailFieldStates(event) {
  return EVENT_DETAIL_FIELDS.map((spec) => {
    let status;
    if (spec.kind === 'absent') {
      status = 'no_field';
    } else if (!event) {
      status = 'missing';
    } else if (spec.kind === 'date') {
      status = isEmptyValue(event.start_date) ? 'missing' : 'filled';
    } else {
      status = isEmptyValue(event[spec.field]) ? 'missing' : 'filled';
    }
    return { key: spec.key, label: spec.label, status };
  });
}

/** 日付を「YYYY-MM-DD」または「YYYY-MM-DD 〜 YYYY-MM-DD」に整形する。無ければ null(呼び出し側は行ごと出さない)。 */
export function formatEventDate(event) {
  const start = event?.start_date ?? null;
  const end = event?.end_date ?? null;
  if (!start && !end) return null;
  if (!start) return `〜${end}`;
  if (!end || end === start) return start;
  return `${start} 〜 ${end}`;
}

/** 日付文字列から西暦年(number)を取り出す。解釈できなければ null(推測で補わない)。 */
function extractYear(value) {
  if (value === null || value === undefined || value === '') return null;
  const m = String(value).match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

/**
 * 事件を日付の昇順に並べる純関数(日付不明は末尾。同着は id 順で決定論的にする)。
 * 並び順の規則は因果グラフと**同じ比較関数**を使う(2箇所で違う並びになると原因→結果が読めなくなる)。
 * `eventRelations` は日付の粒度が違って順序が決まらないときのタイブレークに使う。無くても動く。
 */
export function sortEventsByDate(events, eventRelations = []) {
  if (!Array.isArray(events)) return [];
  return [...events].sort(compareEventsChronologically(eventRelations));
}

function findById(list, id) {
  if (!Array.isArray(list)) return null;
  return list.find((item) => item && item.id === id) || null;
}


/**
 * ID配列を移動ボタン群に変換する。handler が無い場合はボタンにせずテキストで出す
 * (モジュール単体利用でも壊れず、押せない見た目のボタンを作らない)。
 */
function appendIdButtons(parent, { ids, resolve, handler, keyPrefix, ariaSuffix }) {
  const wrap = document.createElement('span');
  wrap.className = 'event-field-links';
  ids.forEach((id, i) => {
    const entity = resolve(id);
    const text = entity ? entity.name : `${id}(見つかりません)`;
    if (typeof handler === 'function') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'event-link-button';
      btn.setAttribute('data-focus-key', `${keyPrefix}-${id}`);
      btn.setAttribute('aria-label', `${text}${ariaSuffix}`);
      btn.textContent = text;
      btn.addEventListener('click', () => handler(id));
      wrap.appendChild(btn);
    } else {
      const span = document.createElement('span');
      span.className = 'event-field-plain';
      span.textContent = text;
      wrap.appendChild(span);
    }
    if (i < ids.length - 1) wrap.appendChild(document.createTextNode(' '));
  });
  parent.appendChild(wrap);
}

/**
 * 事件一覧(仕様§4.9)。日付順に並べ、選択中の事件を aria-pressed で示す。
 * 選択時点(year)との前後関係は文字で注記する(色だけで区別しない。仕様§7.2)。
 * 一覧からは事件を隠さない(時点で絞ると「その年に何も無い=データが無い」と誤読されるため)。
 *
 * @param {HTMLElement} container 中身を空にして描画してよい
 * @param {{events: object[], places: object[], year: string|number, selectedEventId: string|null,
 *          eventRelations?: object[]}} model
 *   eventRelations は並び順のタイブレークにのみ使う(日付の粒度が違って順序が決まらないとき)。無くても動く。
 * @param {{onSelectEvent: (eventId: string) => void}} handlers
 */
export function renderEventList(container, model, handlers) {
  if (!container) return;
  const {
    events = [], places = [], year = '', selectedEventId = null, eventRelations = [],
  } = model || {};
  const onSelectEvent = typeof handlers?.onSelectEvent === 'function' ? handlers.onSelectEvent : null;

  container.innerHTML = '';
  container.classList.add('event-list');

  const heading = document.createElement('h2');
  heading.className = 'section-heading';
  heading.textContent = '事件一覧';
  container.appendChild(heading);

  if (!Array.isArray(events) || events.length === 0) {
    const p = document.createElement('p');
    p.className = 'data-gap-notice';
    p.setAttribute('role', 'note');
    p.textContent = '表示できる事件がありません。';
    container.appendChild(p);
    return;
  }

  const selectedYear = extractYear(year);
  const ul = document.createElement('ul');
  ul.className = 'event-list-items';

  for (const event of sortEventsByDate(events, eventRelations)) {
    const li = document.createElement('li');
    li.className = 'event-list-item';
    const isSelected = event.id === selectedEventId;
    if (isSelected) li.classList.add('event-list-item--selected');

    const dateText = formatEventDate(event) || '';
    const placeNames = (Array.isArray(event.place_ids) ? event.place_ids : [])
      .map((pid) => findById(places, pid)?.name || pid)
      .join('、');

    if (onSelectEvent) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'event-list-button';
      btn.setAttribute('data-focus-key', `event-list-${event.id}`);
      btn.setAttribute('aria-pressed', String(isSelected));
      btn.setAttribute('aria-label', `${event.name}(${dateText})の詳細を表示`);
      btn.addEventListener('click', () => onSelectEvent(event.id));

      const name = document.createElement('span');
      name.className = 'event-list-name';
      name.textContent = event.name;

      const date = document.createElement('span');
      date.className = 'event-list-date';
      date.textContent = event.era_label ? `${dateText}(${event.era_label})` : dateText;

      btn.append(name, date);
      li.appendChild(btn);
    } else {
      const span = document.createElement('span');
      span.className = 'event-list-name';
      span.textContent = `${event.name}(${dateText})`;
      li.appendChild(span);
    }

    const meta = document.createElement('span');
    meta.className = 'event-list-meta';
    meta.textContent = placeNames ? `発生地: ${placeNames}` : '';
    li.appendChild(meta);

    // 選択時点との前後関係。色ではなく文字で示す(仕様§7.2)。
    const eventYear = extractYear(event.start_date);
    if (selectedYear !== null && eventYear !== null) {
      const rel = document.createElement('span');
      rel.className = 'event-list-timing';
      if (eventYear === selectedYear) {
        rel.textContent = '● この時点の事件';
        rel.classList.add('event-list-timing--current');
        li.appendChild(rel);
      } else if (eventYear > selectedYear) {
        rel.textContent = `(選択時点 ${selectedYear}年より後)`;
        li.appendChild(rel);
      }
    }

    ul.appendChild(li);
  }

  container.appendChild(ul);
}

/**
 * 事件詳細(仕様§4.9 の項目のうち、値があるもの)。
 * 関連人物・勢力・地点・前後の事件・出典はボタン化し、handlers 経由で相互移動できるようにする。
 *
 * @param {HTMLElement} container 中身を空にして描画してよい
 * @param {{event: object|null, places: object[], people: object[], factions: object[],
 *          sources: object[], eventRelations: object[]}} model
 * @param {{onSelectPerson?: Function, onSelectFaction?: Function, onSelectPlace?: Function,
 *          onSelectEvent?: Function, onSelectSource?: Function, onSelectEventRelationSource?: Function}} handlers
 */
export function renderEventDetail(container, model, handlers) {
  if (!container) return;
  const {
    event = null,
    places = [],
    people = [],
    factions = [],
    sources = [],
    eventRelations = [],
  } = model || {};
  const h = handlers || {};

  container.innerHTML = '';
  container.classList.add('event-detail');

  const heading = document.createElement('h2');
  heading.className = 'section-heading';
  heading.textContent = '事件詳細';
  container.appendChild(heading);

  if (!event) {
    const p = document.createElement('p');
    p.className = 'event-detail-empty';
    p.textContent = '事件一覧または因果グラフから事件を選択してください。';
    container.appendChild(p);
    return;
  }

  const nameHeading = document.createElement('h3');
  nameHeading.className = 'event-detail-name';
  nameHeading.textContent = event.name;
  container.appendChild(nameHeading);


  const fieldsWrap = document.createElement('div');
  fieldsWrap.className = 'event-fields';

  for (const spec of EVENT_DETAIL_FIELDS) {
    const row = document.createElement('div');
    row.className = 'event-field';

    const label = document.createElement('span');
    label.className = 'event-field-label';
    label.textContent = spec.label;
    row.appendChild(label);

    const value = document.createElement('span');
    value.className = 'event-field-value';
    row.appendChild(value);

    // 対応するデータ項目そのものが無い要件項目は、行ごと出さない。
    if (spec.kind === 'absent') continue;

    if (spec.kind === 'date') {
      const text = formatEventDate(event);
      if (!text) continue; // 日付が無ければ行ごと出さない
      value.textContent = text;
      fieldsWrap.appendChild(row);
      continue;
    }

    const raw = event[spec.field];
    if (isEmptyValue(raw)) continue; // 値が無い項目は行ごと出さない

    if (spec.kind === 'text') {
      value.textContent = raw;
    } else if (spec.kind === 'list') {
      const ul = document.createElement('ul');
      ul.className = 'event-field-list';
      for (const item of raw) {
        const li = document.createElement('li');
        li.textContent = item;
        ul.appendChild(li);
      }
      value.appendChild(ul);
    } else if (spec.kind === 'places') {
      appendIdButtons(value, {
        ids: raw,
        resolve: (id) => findById(places, id),
        handler: h.onSelectPlace,
        keyPrefix: `event-place-${event.id}`,
        ariaSuffix: 'の地点を表示',
      });
    } else if (spec.kind === 'people') {
      appendIdButtons(value, {
        ids: raw,
        resolve: (id) => {
          const p = findById(people, id);
          return p ? { name: p.canonical_name || p.name || id } : null;
        },
        handler: h.onSelectPerson,
        keyPrefix: `event-person-${event.id}`,
        ariaSuffix: 'の人物詳細を表示',
      });
    } else if (spec.kind === 'factions') {
      appendIdButtons(value, {
        ids: raw,
        resolve: (id) => findById(factions, id),
        handler: h.onSelectFaction,
        keyPrefix: `event-faction-${event.id}`,
        ariaSuffix: 'の勢力ビューを表示',
      });
    } else if (spec.kind === 'events') {
      appendIdButtons(value, {
        ids: raw,
        resolve: (id) => {
          // model.events は契約に含まれないため、名前は eventRelations 由来では解決できない。
          // 呼び出し側が渡してくれる場合(model.events)は使い、無ければ ID を表示する。
          const e = findById(model?.events, id);
          return e ? { name: e.name } : null;
        },
        handler: h.onSelectEvent,
        keyPrefix: `event-linked-${event.id}`,
        ariaSuffix: 'の事件詳細を表示',
      });
    } else if (spec.kind === 'sources') {
      appendIdButtons(value, {
        ids: raw,
        resolve: (id) => {
          const s = findById(sources, id);
          return s ? { name: s.title } : null;
        },
        handler: h.onSelectSource,
        keyPrefix: `event-source-${event.id}`,
        ariaSuffix: 'の書誌情報を表示',
      });
    }

    fieldsWrap.appendChild(row);
  }

  container.appendChild(fieldsWrap);

  // ---- 因果関係(前後)。事件同士の相互移動と、関係ごとの出典への到達経路 ----
  const rels = Array.isArray(eventRelations) ? eventRelations : [];
  const incoming = rels.filter((r) => r && r.to_event_id === event.id);
  const outgoing = rels.filter((r) => r && r.from_event_id === event.id);

  // 因果が1件も無ければ、見出しごと出さない。
  if (incoming.length === 0 && outgoing.length === 0) return;

  const relHeading = document.createElement('h4');
  relHeading.className = 'event-detail-subheading';
  relHeading.textContent = '因果関係(前後)';
  container.appendChild(relHeading);

  const relList = document.createElement('ul');
  relList.className = 'event-relation-list';

  const addRelationItem = (relation, direction) => {
    const otherId = direction === 'in' ? relation.from_event_id : relation.to_event_id;
    const other = findById(model?.events, otherId);
    const li = document.createElement('li');
    li.className = 'event-relation-item';

    const dir = document.createElement('span');
    dir.className = 'event-relation-direction';
    dir.textContent = direction === 'in' ? '← 原因側の事件' : '→ 結果側の事件';
    li.appendChild(dir);

    appendIdButtons(li, {
      ids: [otherId],
      resolve: () => (other ? { name: other.name } : null),
      handler: h.onSelectEvent,
      keyPrefix: `event-causal-${relation.id}`,
      ariaSuffix: 'の事件詳細を表示',
    });

    const typeSpan = document.createElement('span');
    typeSpan.className = 'event-relation-type';
    // 種類の日本語ラベルの正典は event-graph.js(8種の定義を1か所に集約する。event-graph.js は
    // events-view.js を import しないので循環参照にはならない)。未知の値は捏造せずそのまま出る。
    typeSpan.textContent = eventRelationTypeLabel(relation.relation_type);
    li.appendChild(typeSpan);

    if (relation.description) {
      const desc = document.createElement('span');
      desc.className = 'event-relation-description';
      desc.textContent = relation.description;
      li.appendChild(desc);
    }


    const srcIds = Array.isArray(relation.source_ids) ? relation.source_ids : [];
    if (srcIds.length > 0) {
      const srcLabel = document.createElement('span');
      srcLabel.className = 'event-relation-sources-label';
      srcLabel.textContent = '出典: ';
      li.appendChild(srcLabel);
      appendIdButtons(li, {
        ids: srcIds,
        resolve: (id) => {
          const s = findById(sources, id);
          return s ? { name: s.title } : null;
        },
        handler: h.onSelectSource,
        keyPrefix: `event-relation-source-${relation.id}`,
        ariaSuffix: 'の書誌情報を表示',
      });
    }

    relList.appendChild(li);
  };

  for (const r of incoming) addRelationItem(r, 'in');
  for (const r of outgoing) addRelationItem(r, 'out');
  container.appendChild(relList);
}
