// factions-view.js — 勢力・組織ビュー(仕様§4.8)。
// T3 が単独で所有するファイル。index.html / styles.css / app.js / data/ には触れない。配信JSは外部依存ゼロ。
//
// ---- 方針 ----
// 仕様§4.8 は勢力詳細に10項目を求めるが、data/faction-statuses.json は当初0件であり、
// スキーマ(schema/faction-status.schema.json)にも「軍事的立場」「主要人物」に対応する項目が無い。
// 仕様§11「不明な項目を推測で補完しない」に従い、
//   * データが無い項目は行ごと出さない(推測で補完しない)
//   * データ項目そのものが無い項目は「データ項目が未定義」と、無い理由まで書く
//   * 関連事件から人物を拾って「主要人物」と称するような推測はしない
// を守る。何も無い時点でも壊れず、10項目すべての行が出る(欠けている項目を数えられる状態にする)。

/** 仕様§4.8 が勢力詳細に求める10項目。表示順もこの順にする(仕様の並びのまま)。 */
export const FACTION_DETAIL_FIELDS = [
  'position',       // 選択時点での立場
  'leaders',        // 指導者
  'key_people',     // 主要人物
  'goals',          // 政治的目標
  'military',       // 軍事的立場
  'allied',         // 協力勢力
  'opposed',        // 対立勢力
  'events',         // 関連事件
  'bases',          // 主な拠点
  'changes',        // 前時点からの変化
];

const FIELD_LABELS = {
  position: '選択時点での立場',
  leaders: '指導者',
  key_people: '主要人物',
  goals: '政治的目標',
  military: '軍事的立場',
  allied: '協力勢力',
  opposed: '対立勢力',
  events: '関連事件',
  bases: '主な拠点',
  changes: '前時点からの変化',
};

/** faction-status の中で「前時点からの変化」の比較対象にする項目。 */
const DIFFABLE_STATUS_FIELDS = ['position_summary', 'leaders', 'goals', 'allied_faction_ids', 'opposed_faction_ids'];

const DIFF_FIELD_LABELS = {
  position_summary: '立場',
  leaders: '指導者',
  goals: '政治的目標',
  allied_faction_ids: '協力勢力',
  opposed_faction_ids: '対立勢力',
};

/** 日付文字列(YYYY / YYYY-MM / YYYY-MM-DD)または数値から年を取り出す。解釈できなければ null。 */
export function extractYear(value) {
  if (value === null || value === undefined || value === '') return null;
  const m = String(value).match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

/** findFactionStatus が主(start_date が最も遅い)を決めた後、他候補から欠けている項目を埋める対象。 */
const FILLABLE_ARRAY_FIELDS = ['leaders', 'goals', 'allied_faction_ids', 'opposed_faction_ids'];

/**
 * donor が primary と「本当に同時併存(同じ年を跨いで何年も重なる)」しているか。
 * 見せかけの重なり(年単位に丸めたことで生じる、隣接する2つの status の境界年が
 * 同じ年に丸まっただけの「引き継ぎ」)は対象にしない——例: 水戸藩は「徳川斉昭期」(〜1844)と
 * 「その後任期」(1844〜)の2つの status の境界がどちらも1844年になり、年単位の判定では
 * 1844年に両方該当してしまうが、これは前任者から後任への引き継ぎであって同時併存ではない。
 * 引き継ぎ側から項目を借りると、隠居させられた側が主のまま指導者として居座る誤りになる。
 * 判定: donor の end(null は無制限=+∞)が primary の start より真に後(年単位で1年以上)である場合だけ
 * 「同時併存」とみなす(donor.end === primary.start はちょうど引き継ぎの境界なので対象外)。
 */
function trulyOverlaps(donor, primary) {
  const donorEnd = donor.end_date == null ? Infinity : extractYear(donor.end_date);
  const primaryStart = extractYear(primary.start_date) ?? -Infinity;
  return donorEnd > primaryStart;
}

/**
 * 同じ年に複数の faction-status が同時に成り立つ場合(例: 朝廷は「孝明天皇の status」と
 * 「岩倉具視の処遇の status」が1854〜1867年で重なる)、主(start_date が最も遅いもの)の側で
 * 空になっている配列項目だけを、本当に同時併存している候補(trulyOverlaps)から埋める
 * (値を上書きはしない。埋めた項目の出典は source_ids へ合流させる=表示される値が必ず出典まで
 * 辿れる状態を保つ)。埋める項目が無ければ primary をそのまま返す(この場合オブジェクトの複製もしない)。
 */
function mergeOverlappingStatuses(primary, candidates) {
  const donors = candidates.filter((c) => c !== primary && trulyOverlaps(c, primary));
  if (donors.length === 0) return primary;
  let merged = primary;
  const borrowedSourceIds = [];
  for (const field of FILLABLE_ARRAY_FIELDS) {
    const primaryVal = Array.isArray(primary[field]) ? primary[field] : [];
    if (primaryVal.length > 0) continue;
    const donor = donors.find((c) => Array.isArray(c[field]) && c[field].length > 0);
    if (!donor) continue;
    if (merged === primary) merged = { ...primary };
    merged[field] = donor[field];
    borrowedSourceIds.push(...(Array.isArray(donor.source_ids) ? donor.source_ids : []));
  }
  if (borrowedSourceIds.length > 0) {
    const existing = Array.isArray(merged.source_ids) ? merged.source_ids : [];
    merged.source_ids = [...new Set([...existing, ...borrowedSourceIds])];
  }
  return merged;
}

/**
 * 指定年に有効な faction-status を返す純関数(start_date <= year <= end_date、null は無制限)。
 * 複数該当する場合は start_date が最も遅いものを主に採る(より新しい状態を優先)が、
 * 主の側で空になっている項目(leaders等)は他の該当候補から埋める(上の
 * mergeOverlappingStatuses を参照)。
 */
export function findFactionStatus(factionStatuses, factionId, year) {
  const target = extractYear(year);
  if (target === null) return null;
  const candidates = (Array.isArray(factionStatuses) ? factionStatuses : []).filter((s) => {
    if (s?.faction_id !== factionId) return false;
    const start = extractYear(s.start_date);
    const end = s.end_date == null ? null : extractYear(s.end_date);
    if (start !== null && target < start) return false;
    if (end !== null && target > end) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  const primary = candidates.reduce((best, s) => {
    const a = extractYear(best.start_date);
    const b = extractYear(s.start_date);
    if (a === null) return s;
    if (b === null) return best;
    return b > a ? s : best;
  });
  if (candidates.length === 1) return primary;
  return mergeOverlappingStatuses(primary, candidates);
}

/**
 * 勢力の「結成年」が、データ・出典に照らして明確に特定できる場合だけを列挙する。
 * これより前の時点は「結成前(まだ無い)」として、状態が登録されていないだけの時点と区別する。
 *
 * 収録基準: 単なる「最初の status の start_date」では採らない(藩や朝廷のように幕末より前から存在する
 * 勢力では、最初の status は「記録の開始」であって「結成」ではないため)。ここに載せるのは
 * events.json 側にも結成そのものを裏づける事件があり、かつその年より前に活動を示す事件が
 * 一切無い勢力だけ。
 *   - shinsengumi: 1863年結成(新選組の結成年として広く確認できる史実)。events.json 上でも
 *     shinsengumi に紐づく唯一の事件(ikedaya_jiken)は1864年で、1863年より前の関連事件は無い。
 *   - new_government: faction-statuses.json の唯一の status が 1868-01-03 に始まり、
 *     これは events.json の ousei_fukko_no_daigorei(王政復古の大号令 = 新政府樹立を告げる事件)と
 *     同日。新政府という名称そのものがこの事件による樹立を指す。
 * court(朝廷)/bakufu(幕府)/satsuma(薩摩藩)/echizen_fukui(越前福井藩)は、結成/消滅の単一の境界を
 * データから確定できない(藩・朝廷は元々幕末より前から存在し、幕府の消滅時期も events.json 上で
 * 1868年の鳥羽・伏見の戦い(toba_fushimi_no_tatakai)に bakufu が紐づいており言い切れない)ため、
 * ここには含めない(=それらの空白は、状態が登録されていないだけの時点として扱う)。
 */
export const FACTION_FOUNDING_YEAR = {
  shinsengumi: 1863,
  new_government: 1868,
};

/**
 * その勢力の状態が指定年に無いとき、それが「結成前(まだ無い)」かどうかを判定する。
 * @returns {{kind: 'not-yet-founded', foundingYear: number} | {kind: 'gap'}}
 */
export function factionGapReason(factionId, year) {
  const target = extractYear(year);
  const founding = FACTION_FOUNDING_YEAR[factionId];
  if (founding !== undefined && target !== null && target < founding) {
    return { kind: 'not-yet-founded', foundingYear: founding };
  }
  return { kind: 'gap' };
}

/**
 * 「前時点」の faction-status(指定年に有効なものより前に始まり、かつ現在のものではないもののうち最新)を返す。
 * 見つからなければ null(= 比較できないので、変化の項目は出さない)。
 */
export function previousFactionStatus(factionStatuses, factionId, year) {
  const current = findFactionStatus(factionStatuses, factionId, year);
  const currentStart = current ? extractYear(current.start_date) : extractYear(year);
  if (currentStart === null) return null;
  const earlier = (Array.isArray(factionStatuses) ? factionStatuses : []).filter((s) => {
    if (s?.faction_id !== factionId) return false;
    if (current && s === current) return false;
    const start = extractYear(s.start_date);
    return start !== null && start < currentStart;
  });
  if (earlier.length === 0) return null;
  return earlier.reduce((best, s) => (extractYear(s.start_date) > extractYear(best.start_date) ? s : best));
}

function sameArray(a, b) {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  if (x.length !== y.length) return false;
  return x.every((v, i) => v === y[i]);
}

/**
 * 2つの faction-status を比較し、変化した項目名(内部キー)の配列を返す純関数。
 * 比較できない(どちらかが無い)場合は null を返す(「変化なし」と区別する)。
 */
export function computeFactionStatusDiff(prevStatus, nextStatus) {
  if (!prevStatus || !nextStatus) return null;
  const fields = [];
  for (const key of DIFFABLE_STATUS_FIELDS) {
    const prev = prevStatus[key];
    const next = nextStatus[key];
    if (Array.isArray(prev) || Array.isArray(next)) {
      if (!sameArray(prev, next)) fields.push(key);
    } else if ((prev ?? null) !== (next ?? null)) {
      fields.push(key);
    }
  }
  return fields;
}

/** 差分の内部キー → 日本語ラベル。 */
export function factionDiffFieldLabel(key) {
  return DIFF_FIELD_LABELS[key] ?? key;
}

/** その勢力が関与した事件(events[].faction_ids に faction_id を含むもの)を返す。 */
export function eventsForFaction(events, factionId) {
  return (Array.isArray(events) ? events : []).filter((e) => (e?.faction_ids || []).includes(factionId));
}

// ---- 以下は DOM 描画(node:test の対象外) ----

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

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

/** 補足の一行(注記として出す)。 */
function gapText(parent, text) {
  const p = el('p', 'faction-gap', text);
  p.setAttribute('role', 'note');
  parent.appendChild(p);
}

function nameOf(list, id, key) {
  const found = (Array.isArray(list) ? list : []).find((item) => item?.id === id);
  return found ? found[key] : id;
}

/**
 * 勢力一覧を描画する。
 *
 * 標準の model は renderFactionList / renderFactionDetail で共通のため、
 * 一覧に必要な「勢力の配列」と「選択中の勢力ID」、および onSelectFaction が含まれていない。
 * ここでは model.factions(配列)/ model.selectedFactionId / handlers.onSelectFaction を任意で受け取り、
 * 無い場合は model.faction 単体へ退避する(渡されなくても壊れない)。
 *
 * @param {HTMLElement} container
 * @param {{factions?: object[], faction?: object, factionStatuses?: object[], year?: string|number,
 *          selectedFactionId?: string|null}} model
 * @param {{onSelectFaction?: (factionId: string) => void}} handlers
 */
export function renderFactionList(container, model, handlers) {
  if (!container) return;
  const { factionStatuses = [], year = '', selectedFactionId = null } = model || {};
  const factions = Array.isArray(model?.factions)
    ? model.factions
    : model?.faction
      ? [model.faction]
      : [];
  const onSelectFaction = typeof handlers?.onSelectFaction === 'function' ? handlers.onSelectFaction : null;

  container.innerHTML = '';
  container.classList.add('faction-list');

  if (factions.length === 0) {
    gapText(container, '表示できる勢力がありません。');
    return;
  }

  const ul = el('ul', 'faction-list-items');
  for (const faction of factions) {
    const li = document.createElement('li');
    li.className = faction.id === selectedFactionId ? 'faction-list-item faction-list-item--selected' : 'faction-list-item';

    li.appendChild(
      makeButton({
        label: faction.name,
        focusKey: `faction-list-${faction.id}`,
        ariaLabel: `勢力 ${faction.name} の詳細を表示`,
        className: 'faction-list-button',
        pressed: faction.id === selectedFactionId,
        onActivate: onSelectFaction ? () => onSelectFaction(faction.id) : null,
      }),
    );

    const status = findFactionStatus(factionStatuses, faction.id, year);
    let noteText;
    let noteClass = 'faction-list-status';
    if (status && status.position_summary) {
      noteText = ` — ${status.position_summary}`;
    } else if (!status) {
      // 結成前で状態がそもそも無い場合だけ、その事実を添える。
      // それ以外(この時点の状態が登録されていないだけ)は名前だけを並べる。
      const gap = factionGapReason(faction.id, year);
      if (gap.kind === 'not-yet-founded') {
        noteText = ` — ${year}年時点はまだ結成前です(結成: ${gap.foundingYear}年〜)`;
        noteClass = 'faction-list-status faction-list-status--not-yet';
      }
    }
    const note = el('span', noteClass, noteText);
    li.appendChild(note);
    ul.appendChild(li);
  }
  container.appendChild(ul);
}

/**
 * 勢力詳細を描画する(仕様§4.8 の10項目のうち、値があるもの)。
 *
 * @param {HTMLElement} container
 * @param {{faction: object|null, factionStatuses: object[], year: string|number, people: object[],
 *          events: object[], places: object[], sources: object[], factions?: object[]}} model
 *   factions は契約外の任意フィールド(協力勢力・対立勢力のIDを名前へ解決するために使う)。
 *   渡されない場合は勢力IDをそのまま表示する。
 * @param {{onSelectPerson: (personId: string) => void, onSelectEvent: (eventId: string) => void,
 *          onSelectPlace: (placeId: string) => void, onSelectSource: (sourceId: string) => void,
 *          onSelectFaction?: (factionId: string) => void}} handlers
 */
export function renderFactionDetail(container, model, handlers) {
  if (!container) return;
  const {
    faction = null,
    factionStatuses = [],
    year = '',
    people = [],
    events = [],
    places = [],
    sources = [],
    factions = [],
  } = model || {};
  const onSelectPerson = typeof handlers?.onSelectPerson === 'function' ? handlers.onSelectPerson : null;
  const onSelectEvent = typeof handlers?.onSelectEvent === 'function' ? handlers.onSelectEvent : null;
  const onSelectPlace = typeof handlers?.onSelectPlace === 'function' ? handlers.onSelectPlace : null;
  const onSelectSource = typeof handlers?.onSelectSource === 'function' ? handlers.onSelectSource : null;
  const onSelectFaction = typeof handlers?.onSelectFaction === 'function' ? handlers.onSelectFaction : null;

  container.innerHTML = '';
  container.classList.add('faction-detail');

  if (!faction) {
    gapText(container, '勢力一覧から勢力を選択してください。');
    return;
  }

  container.appendChild(el('h3', 'faction-detail-name', faction.name));
  if (faction.summary) container.appendChild(el('p', 'faction-detail-summary', faction.summary));

  const status = findFactionStatus(factionStatuses, faction.id, year);
  const previous = previousFactionStatus(factionStatuses, faction.id, year);

  // 結成前でそもそも状態が無い時点だけ、その事実を明示する(factionGapReason)。
  // それ以外で状態が無い時点は、時点依存の項目を出さないだけにする。
  const gap = status ? null : factionGapReason(faction.id, year);
  let bannerText;
  let bannerClass = 'faction-detail-asof';
  if (status) {
    // 期間は分かっている側だけを書く(両方無ければ年だけ)。
    const span = [status.start_date, status.end_date].filter(Boolean);
    bannerText = span.length === 2
      ? `${year}年時点の状態(${span[0]}〜${span[1]})`
      : span.length === 1
        ? `${year}年時点の状態(${status.start_date ? `${span[0]}〜` : `〜${span[0]}`})`
        : `${year}年時点の状態`;
  } else if (gap.kind === 'not-yet-founded') {
    bannerText = `${faction.name}は${year}年時点ではまだ結成されていません(結成: ${gap.foundingYear}年〜)。この勢力の状態はまだ存在しません(データの欠落ではありません)。`;
    bannerClass = 'faction-detail-asof faction-detail-asof--not-yet';
  } else {
    bannerText = null;
  }
  if (bannerText) {
    const banner = el('p', bannerClass, bannerText);
    banner.setAttribute('role', status ? 'note' : 'status');
    container.appendChild(banner);
  }

  const dl = el('dl', 'faction-fields');

  // 中身が1つも作られなかった項目は、見出しごと出さない。
  const addField = (fieldKey, build) => {
    const dd = el('dd', 'faction-field-value');
    build(dd);
    if (dd.childNodes.length === 0) return;
    dl.appendChild(el('dt', 'faction-field-label', FIELD_LABELS[fieldKey]));
    dl.appendChild(dd);
  };

  const idListField = (dd, ids, { list, key, focusPrefix, onActivate, ariaVerb }) => {
    const arr = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (arr.length === 0) return;
    arr.forEach((id, i) => {
      if (i > 0) dd.appendChild(document.createTextNode(' '));
      const label = nameOf(list, id, key);
      dd.appendChild(
        makeButton({
          label,
          focusKey: `${focusPrefix}-${faction.id}-${id}`,
          ariaLabel: `${ariaVerb} ${label}`,
          className: 'faction-link-button',
          onActivate: onActivate ? () => onActivate(id) : null,
        }),
      );
    });
  };

  // 1. 選択時点での立場
  addField('position', (dd) => {
    if (status?.position_summary) dd.appendChild(document.createTextNode(status.position_summary));
  });

  // 2. 指導者(faction-status.leaders。人物IDとして解決を試み、people に無ければ文字列のまま出す)
  addField('leaders', (dd) => {
    const leaders = Array.isArray(status?.leaders) ? status.leaders.filter(Boolean) : [];
    if (leaders.length === 0) return;
    leaders.forEach((leader, i) => {
      if (i > 0) dd.appendChild(document.createTextNode(' '));
      const person = (people || []).find((p) => p?.id === leader);
      if (person) {
        dd.appendChild(
          makeButton({
            label: person.canonical_name,
            focusKey: `faction-leader-${faction.id}-${leader}`,
            ariaLabel: `人物 ${person.canonical_name} へ移動`,
            className: 'faction-link-button',
            onActivate: onSelectPerson ? () => onSelectPerson(leader) : null,
          }),
        );
      } else {
        // 人物データに無い指導者名は、勝手に人物へ結びつけずそのまま文字列として出す。
        dd.appendChild(el('span', 'faction-plain-value', leader));
      }
    });
  });

  // 3. 主要人物 — 対応するデータ項目が無いので出さない(関連事件から人物へ移動できる)。

  // 4. 政治的目標
  addField('goals', (dd) => {
    const goals = Array.isArray(status?.goals) ? status.goals.filter(Boolean) : [];
    if (goals.length === 0) return;
    const ul = el('ul', 'faction-goals');
    for (const goal of goals) ul.appendChild(el('li', null, goal));
    dd.appendChild(ul);
  });

  // 5. 軍事的立場 — 対応するデータ項目が無いので出さない。

  // 6. 協力勢力
  addField('allied', (dd) => {
    idListField(dd, status?.allied_faction_ids, {
      list: factions,
      key: 'name',
      focusPrefix: 'faction-allied',
      onActivate: onSelectFaction,
      ariaVerb: '勢力へ移動:',
    });
  });

  // 7. 対立勢力
  addField('opposed', (dd) => {
    idListField(dd, status?.opposed_faction_ids, {
      list: factions,
      key: 'name',
      focusPrefix: 'faction-opposed',
      onActivate: onSelectFaction,
      ariaVerb: '勢力へ移動:',
    });
  });

  // 8. 関連事件(相互移動)
  const relatedEvents = eventsForFaction(events, faction.id);
  addField('events', (dd) => {
    if (relatedEvents.length === 0) return;
    const ul = el('ul', 'faction-events');
    for (const event of relatedEvents) {
      const li = document.createElement('li');
      li.appendChild(
        makeButton({
          label: event.name,
          focusKey: `faction-event-${faction.id}-${event.id}`,
          ariaLabel: `事件 ${event.name} へ移動`,
          className: 'faction-link-button',
          onActivate: onSelectEvent ? () => onSelectEvent(event.id) : null,
        }),
      );
      if (event.era_label) li.appendChild(el('span', 'faction-note', ` (${event.era_label})`));

      // その事件に登場する人物へも移動できるようにする(「主要人物」とは称さない)。
      const eventPeople = (event.person_ids || [])
        .map((pid) => (people || []).find((p) => p?.id === pid))
        .filter(Boolean);
      if (eventPeople.length > 0) {
        li.appendChild(el('span', 'faction-note', ' 登場人物: '));
        eventPeople.forEach((person, i) => {
          if (i > 0) li.appendChild(document.createTextNode(' '));
          li.appendChild(
            makeButton({
              label: person.canonical_name,
              focusKey: `faction-event-person-${faction.id}-${event.id}-${person.id}`,
              ariaLabel: `人物 ${person.canonical_name} へ移動`,
              className: 'faction-link-button',
              onActivate: onSelectPerson ? () => onSelectPerson(person.id) : null,
            }),
          );
        });
      }
      ul.appendChild(li);
    }
    dd.appendChild(ul);
  });

  // 9. 主な拠点(相互移動)
  addField('bases', (dd) => {
    idListField(dd, faction.base_place_ids, {
      list: places,
      key: 'name',
      focusPrefix: 'faction-base',
      onActivate: onSelectPlace,
      ariaVerb: '場所へ移動:',
    });
  });

  // 10. 前時点からの変化
  addField('changes', (dd) => {
    const diff = computeFactionStatusDiff(previous, status);
    if (diff === null) return; // 比較できる前時点が無ければ項目ごと出さない
    if (diff.length === 0) {
      dd.appendChild(
        document.createTextNode(
          `${previous.start_date || '前時点'} から変化した項目はありません(記録されている項目の範囲で)。`,
        ),
      );
      return;
    }
    const p = el('p', 'faction-changes-summary');
    p.setAttribute('role', 'status');
    p.setAttribute('aria-live', 'polite');
    p.textContent = `${previous.start_date || '前時点'} → ${status.start_date || '現時点'} で ${diff
      .map(factionDiffFieldLabel)
      .join('、')} が変わりました。`;
    dd.appendChild(p);
  });

  container.appendChild(dl);

  // ---- 出典(勢力そのもの + 選択時点の状態。書誌情報へ到達できるボタンにする) ----
  const sourceGroups = [
    { heading: '勢力の出典', ids: faction.source_ids, keyPrefix: `faction-src-${faction.id}` },
    { heading: `${year}年時点の状態の出典`, ids: status?.source_ids, keyPrefix: `faction-status-src-${faction.id}` },
  ];
  // 出典が1件も無ければ、見出しごと出さない。
  if (!sourceGroups.some((g) => (Array.isArray(g.ids) ? g.ids.filter(Boolean).length : 0) > 0)) return;
  container.appendChild(el('h4', 'faction-detail-subheading', '出典'));
  for (const group of sourceGroups) {
    const ids = Array.isArray(group.ids) ? group.ids.filter(Boolean) : [];
    if (ids.length === 0) continue;
    container.appendChild(el('p', 'faction-sources-heading', group.heading));
    const ul = el('ul', 'faction-sources');
    for (const sourceId of ids) {
      const source = (sources || []).find((s) => s?.id === sourceId) || null;
      const title = source ? source.title : `${sourceId}(出典データに見つかりません)`;
      const li = document.createElement('li');
      li.appendChild(
        makeButton({
          label: title,
          focusKey: `${group.keyPrefix}-${sourceId}`,
          ariaLabel: `出典「${title}」の書誌情報を表示`,
          className: 'faction-link-button',
          onActivate: onSelectSource ? () => onSelectSource(sourceId) : null,
        }),
      );
      if (source?.publisher) li.appendChild(el('span', 'faction-note', ` — ${source.publisher}`));
      ul.appendChild(li);
    }
    container.appendChild(ul);
  }
}
