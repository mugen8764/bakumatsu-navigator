// map-view.js — 日本地図ビュー(仕様§4.11)。
// このファイルは index.html / styles.css / app.js / data/ には触れない。
// 配信JSは外部依存ゼロ: SVG は document.createElementNS で自前生成し、背景地形は
// assets/edo-coastline.js(CC BY 4.0 の派生物。生成手順は assets/README.md)を静的 import するだけ。
//
// ---- このビューが意図的に「描かないもの」----
// ・藩境は描きません(史料に基づき、ライセンスの明確な幕末期の藩境データが確認できていないため)。
// ・移動経路・伝達経路の線は引きません(地図上の線を実際の経路と断定しないため)。
// ・位置の確からしさは画面に出しません(おおよその位置が分かれば足りるため。データとしては保持しています)。
// ・座標が無い地点・表示枠の外にある地点は点を打たず、下の表からたどれるようにします。

import { EDO_COASTLINE } from '../assets/edo-coastline.js';
import { extractYear, FACTION_FOUNDING_YEAR } from './factions-view.js';
import { personExistsAtYear } from './state.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** §4.11 の表示モードのうち現在の3種(同時期比較モードは作らない)。 */
export const MAP_MODES = ['event', 'person', 'faction'];

const MODE_LABELS = {
  event: '事件モード(事件の発生地)',
  person: '人物モード(人物の出身地)',
  faction: '勢力モード(勢力の主な拠点)',
};

/** 地図の投影・表示枠。assets/edo-coastline.js が持つ値をそのまま使う(背景と点の座標系を必ず一致させる)。 */
export const MAP_PROJECTION = EDO_COASTLINE.projection;

/** 位置の確からしさ(place.precision)の表示ラベル。色ではなく記号+文字で区別する(仕様§7.2)。 */
const PRECISION_LABELS = {
  exact: { symbol: '●', label: '正確な位置' },
  approximate: { symbol: '≈', label: '概略地点' },
};
const PRECISION_UNKNOWN = { symbol: '?', label: 'おおよその位置' };

/** place.precision → { symbol, label }。未知の値・null は「おおよその位置」に寄せる(推測で埋めない)。 */
export function precisionInfo(precision) {
  return PRECISION_LABELS[precision] || PRECISION_UNKNOWN;
}

/** place.precision → 日本語ラベル。 */
export function precisionLabel(precision) {
  return precisionInfo(precision).label;
}

/** mode を既知の3値へ正規化する。未知・未指定は 'event'(既定)。 */
export function normalizeMode(mode) {
  return MAP_MODES.includes(mode) ? mode : 'event';
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 場所を地図に描けるか判定する純関数。
 * @returns {{mappable: boolean, reason: 'ok'|'no_coords'|'out_of_frame', reasonLabel: string}}
 *   no_coords    … 緯度経度が null(または数値でない)。地図に描かず一覧に出す(条件5)
 *   out_of_frame … 座標はあるが背景地形の表示枠の外。クランプせず一覧に出す
 */
export function classifyPlace(place) {
  const lat = place?.latitude;
  const lon = place?.longitude;
  if (!isFiniteNumber(lat) || !isFiniteNumber(lon)) {
    return { mappable: false, reason: 'no_coords', reasonLabel: '位置未確定' };
  }
  const p = MAP_PROJECTION;
  if (lat < p.latMin || lat > p.latMax || lon < p.lonMin || lon > p.lonMax) {
    return { mappable: false, reason: 'out_of_frame', reasonLabel: '地図の表示範囲外' };
  }
  return { mappable: true, reason: 'ok', reasonLabel: '地図に表示' };
}

/** 地図に描ける場所だけを返す。 */
export function mappablePlaces(places) {
  return (Array.isArray(places) ? places : []).filter((place) => classifyPlace(place).mappable);
}

/** 地図に描けない場所を、理由つきで返す(仕様§4.11・条件5 の「一覧に出す」対象)。 */
export function unmappablePlaces(places) {
  return (Array.isArray(places) ? places : [])
    .map((place) => ({ place, ...classifyPlace(place) }))
    .filter((entry) => !entry.mappable);
}

/**
 * 緯度経度を SVG の viewBox 座標へ投影する(正距円筒図法。背景地形の生成時と同じ式)。
 * 枠外・不正値は null を返す(勝手に枠へ寄せない)。
 */
export function projectLatLon(latitude, longitude) {
  if (!isFiniteNumber(latitude) || !isFiniteNumber(longitude)) return null;
  const p = MAP_PROJECTION;
  if (latitude < p.latMin || latitude > p.latMax || longitude < p.lonMin || longitude > p.lonMax) return null;
  return {
    x: (longitude - p.lonMin) * p.lonScaleK * p.unitsPerDegree,
    y: (p.latMax - latitude) * p.unitsPerDegree,
  };
}

/**
 * 事件がその年に該当するか(start_date〜end_date の範囲に year を含むか)。
 * 年が特定できない(target が null)場合、またはイベント自体の年が読み取れない場合は絞り込まない
 * (「判定できない」を「該当しない」に倒さない = 仕様§11)。
 */
function eventMatchesYear(event, targetYear) {
  if (targetYear === null) return true;
  const startYear = extractYear(event?.start_date);
  if (startYear === null) return true;
  const endYear = event?.end_date == null ? startYear : (extractYear(event.end_date) ?? startYear);
  return targetYear >= startYear && targetYear <= endYear;
}

/**
 * 勢力の拠点を、その年に結成済みと確認できる場合だけ対象にする。
 * 結成年が特定できない勢力(factions-view.js の FACTION_FOUNDING_YEAR に無い勢力。court/bakufu/
 * satsuma/echizen_fukui 等)は除外しない——データが無いだけで実在した可能性が高いものを地図から
 * 消してしまうと、存在しなかったと誤解させるため。
 */
function factionMatchesYear(factionId, targetYear) {
  if (targetYear === null) return true;
  const founding = FACTION_FOUNDING_YEAR[factionId];
  if (founding === undefined) return true;
  return targetYear >= founding;
}

/**
 * 表示モードごとに「地図に載せる対象の場所ID」を求める純関数。
 *   event   … model.events[].place_ids のうち、その年に該当する事件だけ
 *   person  … model.people[].birth_place_id のうち、その年に存在しうる(生前/死後で除外できない)人物だけ
 *             (活動地に対応するデータ項目は持たない)
 *   faction … model.factions[].base_place_ids のうち、その年に結成済みと確認できる勢力だけ
 *
 * 標準の model には factions が無いため、勢力モードでは任意フィールド model.factions を見る。
 * 渡されていない場合は ids を null で返し、呼び出し側は「絞り込めない」と明示したうえで全地点を出す
 * (黙って空にすると、データが無いのか渡し忘れなのかが画面から区別できなくなるため)。
 *
 * 時点による絞り込み(仕様§4.1「年代を変更した場合、…地図…を同期して更新する」。
 * )は model.year を見て行う。model.year が無い/解釈できない場合は絞り込みをしない
 * (存在を否定する材料が無いのに除外しない。仕様§11の「不明な項目を推測で補完しない」を
 * 絞り込み判定にも適用する)。
 *
 * @returns {{ids: Set<string>|null, missingInput: string|null}}
 */
export function scopedPlaceIds(model) {
  const mode = normalizeMode(model?.mode);
  const ids = new Set();
  const targetYear = extractYear(model?.year);

  if (mode === 'event') {
    if (!Array.isArray(model?.events)) return { ids: null, missingInput: 'events' };
    for (const event of model.events) {
      if (!eventMatchesYear(event, targetYear)) continue;
      for (const id of event?.place_ids || []) ids.add(id);
    }
    return { ids, missingInput: null };
  }

  if (mode === 'person') {
    if (!Array.isArray(model?.people)) return { ids: null, missingInput: 'people' };
    for (const person of model.people) {
      if (!person?.birth_place_id) continue;
      if (!personExistsAtYear(person, model?.year)) continue;
      ids.add(person.birth_place_id);
    }
    return { ids, missingInput: null };
  }

  // faction
  if (!Array.isArray(model?.factions)) return { ids: null, missingInput: 'factions' };
  for (const faction of model.factions) {
    if (!factionMatchesYear(faction?.id, targetYear)) continue;
    for (const id of faction?.base_place_ids || []) ids.add(id);
  }
  return { ids, missingInput: null };
}

/** 表示モードで絞り込んだ場所の配列を返す(絞り込めない場合は全件)。 */
export function placesForMode(model) {
  const places = Array.isArray(model?.places) ? model.places : [];
  const { ids } = scopedPlaceIds(model);
  if (ids === null) return places;
  return places.filter((place) => ids.has(place?.id));
}

/** その場所で起きた事件(events[].place_ids に place_id を含むもの)。 */
export function eventsAtPlace(events, placeId) {
  return (Array.isArray(events) ? events : []).filter((e) => (e?.place_ids || []).includes(placeId));
}

/** その場所を出身地とする人物。活動地はデータ項目が無いので出身地のみ(推測で補わない)。 */
export function peopleBornAtPlace(people, placeId) {
  return (Array.isArray(people) ? people : []).filter((p) => p?.birth_place_id === placeId);
}

/** 緯度経度の表示文字列。 */
export function formatCoords(place) {
  if (!isFiniteNumber(place?.latitude) || !isFiniteNumber(place?.longitude)) return '';
  return `北緯 ${place.latitude.toFixed(4)} / 東経 ${place.longitude.toFixed(4)}`;
}

// ---- 以下は DOM 描画(node:test の対象外) ----

function createSvgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** クリックと Enter/Space の両方で発火するボタンを作る(キーボードだけで操作できること)。 */
function makeButton({ label, focusKey, ariaLabel, className, onActivate, pressed }) {
  const button = el('button', className, label);
  button.type = 'button';
  button.setAttribute('data-focus-key', focusKey);
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
  if (pressed !== undefined) button.setAttribute('aria-pressed', String(pressed));
  if (typeof onActivate === 'function') {
    button.addEventListener('click', onActivate);
  } else {
    button.disabled = true;
  }
  return button;
}

function externalLink(href, text) {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  a.target = '_blank';
  a.rel = 'noopener noreferrer'; // 仕様§7.4
  return a;
}

/**
 * 地図(SVG)+ テキスト代替の表 + 選択中の地点の詳細を container に描画する。
 *
 * @param {HTMLElement} container 中身を空にして描画してよい
 * @param {{places: object[], events: object[], people: object[], year: string|number,
 *          mode: 'event'|'person'|'faction', selectedPlaceId: string|null, sources: object[],
 *          factions?: object[]}} model
 *   factions は契約外の任意フィールド(勢力モードの絞り込みに使う)。渡されなくても動く。
 * @param {{onSelectPlace: (placeId: string) => void, onSelectEvent: (eventId: string) => void,
 *          onSelectPerson: (personId: string) => void, onSelectSource: (sourceId: string) => void}} handlers
 */
export function renderMap(container, model, handlers) {
  if (!container) return;
  const {
    places = [],
    events = [],
    people = [],
    year = '',
    selectedPlaceId = null,
    sources = [],
  } = model || {};
  const mode = normalizeMode(model?.mode);
  const onSelectPlace = typeof handlers?.onSelectPlace === 'function' ? handlers.onSelectPlace : null;
  const onSelectEvent = typeof handlers?.onSelectEvent === 'function' ? handlers.onSelectEvent : null;
  const onSelectPerson = typeof handlers?.onSelectPerson === 'function' ? handlers.onSelectPerson : null;
  const onSelectSource = typeof handlers?.onSelectSource === 'function' ? handlers.onSelectSource : null;

  container.innerHTML = '';
  container.classList.add('map-view');

  const { missingInput } = scopedPlaceIds({ ...model, mode });
  const scoped = placesForMode({ ...model, mode });
  const drawable = mappablePlaces(scoped);
  const notDrawable = unmappablePlaces(scoped);

  // ---- モードと注記 ----
  const modeNote = el('p', 'map-mode-note');
  modeNote.setAttribute('role', 'note');
  // 仕様§4.1: 地図は時点で絞り込む(scopedPlaceIds が model.year を見る)。
  // 除外は「存在しないと確認できる」場合だけに限定している(結成前の勢力・生前/死後の人物)。
  // データが無いだけ(存在した可能性が高い)の対象は除外しない——除外すると
  // 「存在しなかった」と誤解させてしまうため。
  const targetYear = extractYear(year);
  const FILTER_EXPLANATION = {
    event: 'その年に起きた(開始から終了までにその年を含む)事件の地点のみ',
    person: '生没年から見てその時点に存在しうる人物の出身地のみ(生没年不明の人物は除外していません)',
    faction: 'その時点で結成済みと確認できる勢力の拠点のみ(結成年が不明な勢力は除外していません)',
  };
  const filterNote =
    targetYear !== null
      ? `${year}年時点で絞り込んでいます(${FILTER_EXPLANATION[mode]})。`
      : '時点が指定・解釈できないため、時点では絞り込んでいません(全期間の地点を表示)。';
  modeNote.textContent = `${MODE_LABELS[mode]}。地点 ${scoped.length} 件(地図に表示 ${drawable.length} 件 / 一覧のみ ${notDrawable.length} 件)。${filterNote}`;
  container.appendChild(modeNote);

  if (missingInput) {
    const warn = el(
      'p',
      'map-scope-warning',
      `このモードの絞り込みに必要な ${missingInput} が渡されていないため、全地点を表示しています。`,
    );
    warn.setAttribute('role', 'note');
    container.appendChild(warn);
  }

  if (mode === 'person' && scoped.length > 0) {
    // 出身地のみを表示している旨は、地図の見方として利用者に伝える価値がある実情報(内部の
    // データ設計の説明は含めない)。
    const note = el('p', 'map-data-gap-note', '出身地のみを表示しています。');
    note.setAttribute('role', 'note');
    container.appendChild(note);
  }

  // ---- 地図(SVG) ----
  if (drawable.length === 0) {
    // 0件の理由を取り違えない。「対象が1件も無い」と「対象はあるが座標が無い」は別の状態。
    const empty = el(
      'p',
      'map-empty',
      scoped.length === 0
        ? `${MODE_LABELS[mode]}に結びついた地点が1件も登録されていないため、地図に表示するものがありません。`
        : '地図に表示できる地点がありません(座標が不明、または表示範囲外)。下の一覧を参照してください。',
    );
    container.appendChild(empty);
  } else {
    const p = MAP_PROJECTION;
    const svg = createSvgEl('svg', {
      viewBox: `0 0 ${p.width} ${p.height}`,
      class: 'map-svg',
      role: 'img',
      'aria-label': `幕末期の海岸線に${drawable.length}件の地点を示した地図。同じ内容を下の表でも読めます。`,
    });

    // 水域(背景)。land は evenodd で内側の水域(湖沼)が抜ける。
    svg.appendChild(createSvgEl('rect', { class: 'map-water', x: 0, y: 0, width: p.width, height: p.height }));
    svg.appendChild(createSvgEl('path', { class: 'map-land', d: EDO_COASTLINE.path, 'fill-rule': 'evenodd' }));

    const pointsLayer = createSvgEl('g', { class: 'map-points' });
    for (const place of drawable) {
      const pos = projectLatLon(place.latitude, place.longitude);
      if (!pos) continue; // classifyPlace と二重に守る
      const isSelected = place.id === selectedPlaceId;
      const group = createSvgEl('g', {
        class: `map-point${isSelected ? ' map-point--selected' : ''}`,
        transform: `translate(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)})`,
        tabindex: '0',
        role: 'button',
        'aria-pressed': String(isSelected),
        'aria-label': `${place.name} を選択`,
        'data-focus-key': `map-point-${place.id}`,
      });

      group.appendChild(createSvgEl('circle', { class: 'map-point-hit', r: 14 }));
      group.appendChild(createSvgEl('circle', { class: 'map-point-mark', r: isSelected ? 8 : 6 }));

      const label = createSvgEl('text', { class: 'map-point-label', x: 12, y: 5 });
      label.textContent = place.name;
      group.appendChild(label);

      if (onSelectPlace) {
        const activate = () => onSelectPlace(place.id);
        group.addEventListener('click', activate);
        group.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
          }
        });
      }
      pointsLayer.appendChild(group);
    }
    svg.appendChild(pointsLayer);
    container.appendChild(svg);

  }

  // ---- 背景地形の帰属表示(CC BY 4.0 の要求。画面から到達可能にする) ----
  const attribution = el('p', 'map-attribution');
  attribution.appendChild(document.createTextNode('背景の海岸線: '));
  attribution.appendChild(externalLink(EDO_COASTLINE.sourceUrl, EDO_COASTLINE.attribution));
  attribution.appendChild(document.createTextNode(' / ライセンス: '));
  attribution.appendChild(externalLink(EDO_COASTLINE.licenseUrl, EDO_COASTLINE.license));
  attribution.appendChild(
    document.createTextNode(
      `(${EDO_COASTLINE.datasetUpdatedAt} 版を ${EDO_COASTLINE.retrievedAt} に取得し、表示用に簡略化した派生物)`,
    ),
  );
  container.appendChild(attribution);

  // ---- テキスト代替の表(仕様§7.2。SVG の直後に置く) ----
  const table = el('table', 'map-table');
  const caption = el('caption', 'map-visually-hidden', `地図のテキスト代替(${MODE_LABELS[mode]})`);
  table.appendChild(caption);

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const text of ['地点名', '位置', '関連事件', '関連人物']) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = text;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (scoped.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = 'このモードで表示できる地点がありません。';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    for (const place of scoped) {
      const cls = classifyPlace(place);
      const tr = document.createElement('tr');
      if (place.id === selectedPlaceId) tr.className = 'map-table-row--selected';

      // 地点名(地図に描けない地点もここから選べる = キーボードだけで全地点に到達できる)
      const tdName = document.createElement('td');
      tdName.appendChild(
        makeButton({
          label: place.name,
          focusKey: `map-row-${place.id}`,
          ariaLabel: `${place.name} を選択`,
          className: 'map-table-place-button',
          pressed: place.id === selectedPlaceId,
          onActivate: onSelectPlace ? () => onSelectPlace(place.id) : null,
        }),
      );
      tr.appendChild(tdName);


      const tdPos = el('td', null, cls.mappable ? formatCoords(place) : cls.reasonLabel);
      if (!cls.mappable) tdPos.className = 'map-table-cell--gap';
      tr.appendChild(tdPos);


      const tdEvents = document.createElement('td');
      const placeEvents = eventsAtPlace(events, place.id);
      if (placeEvents.length === 0) {
        tdEvents.textContent = '—';
      } else {
        placeEvents.forEach((event, i) => {
          if (i > 0) tdEvents.appendChild(document.createTextNode(' '));
          tdEvents.appendChild(
            makeButton({
              label: event.name,
              focusKey: `map-event-${place.id}-${event.id}`,
              ariaLabel: `事件 ${event.name} へ移動`,
              className: 'map-link-button',
              onActivate: onSelectEvent ? () => onSelectEvent(event.id) : null,
            }),
          );
        });
      }
      tr.appendChild(tdEvents);

      const tdPeople = document.createElement('td');
      const placePeople = peopleBornAtPlace(people, place.id);
      if (placePeople.length === 0) {
        tdPeople.textContent = '—';
      } else {
        placePeople.forEach((person, i) => {
          if (i > 0) tdPeople.appendChild(document.createTextNode(' '));
          tdPeople.appendChild(
            makeButton({
              label: person.canonical_name,
              focusKey: `map-person-${place.id}-${person.id}`,
              ariaLabel: `人物 ${person.canonical_name} へ移動`,
              className: 'map-link-button',
              onActivate: onSelectPerson ? () => onSelectPerson(person.id) : null,
            }),
          );
        });
      }
      tr.appendChild(tdPeople);

      tbody.appendChild(tr);
    }
  }
  table.appendChild(tbody);
  container.appendChild(table);

  // ---- 選択中の地点の詳細 ----
  const selected = scoped.find((p) => p.id === selectedPlaceId) || null;
  if (selected) {
    const detail = el('div', 'map-detail');
    detail.setAttribute('role', 'region');
    detail.setAttribute('aria-live', 'polite');
    detail.setAttribute('aria-label', `${selected.name} の詳細`);

    detail.appendChild(el('p', 'map-detail-heading', selected.name));

    const dl = document.createElement('dl');
    const addRow = (term, value) => {
      dl.appendChild(el('dt', null, term));
      dl.appendChild(el('dd', null, value));
    };
    const cls = classifyPlace(selected);
    addRow('位置', cls.mappable ? formatCoords(selected) : `${cls.reasonLabel}(${formatCoords(selected)})`);
    if (selected.summary) addRow('概要', selected.summary);
    detail.appendChild(dl);

    // 出典(source_ids を sources[] で書誌情報に解決してから出す。IDのまま出さない)
    // 出典が無い地点では、見出しごと出さない。
    // 座標を取るためだけに使った地理データの出典は、読者向けの出典一覧には出さない
    // (資料としての価値は歴史資料の側にあり、データとしては保持している)。
    const sourceIds = (Array.isArray(selected.source_ids) ? selected.source_ids : []).filter(
      (id) => !/_gsi_/.test(id),
    );
    if (sourceIds.length > 0) {
      detail.appendChild(el('p', 'map-detail-sources-heading', '出典'));
      const ul = el('ul', 'map-detail-sources');
      sourceIds.forEach((sourceId) => {
        const source = (sources || []).find((s) => s.id === sourceId) || null;
        const li = document.createElement('li');
        const title = source ? source.title : `${sourceId}(出典データに見つかりません)`;
        li.appendChild(
          makeButton({
            label: title,
            focusKey: `map-source-${selected.id}-${sourceId}`,
            ariaLabel: `出典「${title}」の書誌情報を表示`,
            className: 'map-link-button',
            onActivate: onSelectSource ? () => onSelectSource(sourceId) : null,
          }),
        );
        if (source?.publisher) li.appendChild(el('span', 'map-detail-source-publisher', ` — ${source.publisher}`));
        ul.appendChild(li);
      });
      detail.appendChild(ul);
    }

    // 相互移動: この地点 → 事件 / 人物
    const relEvents = eventsAtPlace(events, selected.id);
    if (relEvents.length > 0) {
      detail.appendChild(el('p', 'map-detail-subheading', 'この地点の事件'));
      const ul = el('ul', 'map-detail-links');
      for (const event of relEvents) {
        const li = document.createElement('li');
        li.appendChild(
          makeButton({
            label: event.name,
            focusKey: `map-detail-event-${event.id}`,
            ariaLabel: `事件 ${event.name} へ移動`,
            className: 'map-link-button',
            onActivate: onSelectEvent ? () => onSelectEvent(event.id) : null,
          }),
        );
        if (event.era_label) li.appendChild(el('span', 'map-detail-note', ` (${event.era_label})`));
        ul.appendChild(li);
      }
      detail.appendChild(ul);
    }

    const relPeople = peopleBornAtPlace(people, selected.id);
    if (relPeople.length > 0) {
      detail.appendChild(el('p', 'map-detail-subheading', 'この地点を出身地とする人物'));
      const ul = el('ul', 'map-detail-links');
      for (const person of relPeople) {
        const li = document.createElement('li');
        li.appendChild(
          makeButton({
            label: person.canonical_name,
            focusKey: `map-detail-person-${person.id}`,
            ariaLabel: `人物 ${person.canonical_name} へ移動`,
            className: 'map-link-button',
            onActivate: onSelectPerson ? () => onSelectPerson(person.id) : null,
          }),
        );
        ul.appendChild(li);
      }
      detail.appendChild(ul);
    }

    container.appendChild(detail);
  }
}
