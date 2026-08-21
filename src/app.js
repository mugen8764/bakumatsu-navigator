// app.js — エントリポイント。データ読み込み・状態管理・各ビューの合成を行う薄い司令塔。
// 配信JSは外部依存ゼロ(素のES modules)。DOM操作は各ビューモジュールに委ね、ここでは配線だけを行う。
//
// 「人物・事件・勢力・地図」の4面がある。4面を1画面に積むと 320px 幅で辿れなくなるため、
// 面の切り替え(view)を状態に持ち、選択中の面だけを描く。どの面からでも他の面の対象へ移動できる
// ように、handlers は「対象を選ぶ」と同時に「その対象を表示できる面へ移る」。

import { loadDataset, readStateFromUrl, findStatus } from './state.js';
import { navigate, initRouter } from './router.js';
import { buildSearchIndex, renderSearch } from './search.js';
import { renderTimeline } from './timeline.js';
import { renderPeopleList } from './people-view.js';
import { renderPersonDetail } from './person-detail.js';
import { renderSources } from './sources.js';
import { renderPreservingFocus } from './focus.js';
import { renderRelationGraph, relationsAtTime } from './relation-graph.js';
import { renderEventList, renderEventDetail } from './events-view.js';
import { renderEventGraph } from './event-graph.js';
import { renderFactionList, renderFactionDetail } from './factions-view.js';
import { renderMap, MAP_MODES, normalizeMode } from './map-view.js';

let data = null;
let searchIndex = null;

/** 面の定義。id は URL の view= に入る値。 */
const VIEWS = [
  { id: 'people', label: '人物', panelId: 'view-people' },
  { id: 'events', label: '事件', panelId: 'view-events' },
  { id: 'factions', label: '勢力', panelId: 'view-factions' },
  { id: 'map', label: '地図', panelId: 'view-map' },
];
const VIEW_IDS = VIEWS.map((v) => v.id);

const MAP_MODE_LABELS = { event: '事件', person: '人物', faction: '勢力' };

/** URLに無いキーの既定値。state.js の readStateFromUrl が返さないキーもここで埋まる。 */
const DEFAULT_STATE = {
  view: 'people',
  year: '1858',
  personId: null,
  query: '',
  sourceId: null,
  eventId: null,
  factionId: null,
  placeId: null,
  mapMode: 'event',
};

/** URLと同期する状態。state.js の readStateFromUrl / stateToSearchParams と同じ形。 */
let state = { ...DEFAULT_STATE };

/**
 * 年代変更の直前の状態(変化した項目の強調に使う)。
 * URLには含めない(リロード直後は「変化前」が無いため差分は出ない=仕様として妥当)。
 */
let previousStatusForDiff = null;

/** 相関図の選択中の関係線ID。app.js はこれを保持して再描画時に model へ渡すだけ。 */
let selectedRelationId = null;

const els = {
  timeline: document.getElementById('timeline'),
  viewNav: document.getElementById('view-nav'),
  search: document.getElementById('search'),
  peopleList: document.getElementById('people-list'),
  personDetail: document.getElementById('person-detail'),
  relationGraph: document.getElementById('relation-graph'),
  eventList: document.getElementById('event-list'),
  eventDetail: document.getElementById('event-detail'),
  eventGraph: document.getElementById('event-graph'),
  factionList: document.getElementById('faction-list'),
  factionDetail: document.getElementById('faction-detail'),
  mapControls: document.getElementById('map-controls'),
  map: document.getElementById('map'),
  sources: document.getElementById('sources'),
  live: document.getElementById('a11y-live'),
  fatalError: document.getElementById('fatal-error'),
};

// ---- 支援技術への通知 ----
//
// 読み上げ領域は index.html に常設してある(ビューの内側に置くと再描画で破棄されるため)。
// 同じ文言を続けて入れても読み上げられるよう、いったん空にしてから書く。

function announce(message) {
  if (!els.live || !message) return;
  els.live.textContent = '';
  // 同一フレーム内の空→同文字列は変更として扱われないブラウザがあるため、次のタイミングで書く。
  window.setTimeout(() => {
    els.live.textContent = message;
  }, 50);
}

function nameOf(list, id, key) {
  const found = (Array.isArray(list) ? list : []).find((item) => item?.id === id);
  return (found && found[key]) || id;
}

// ---- 状態遷移 ----

function setState(patch, { replace = false, announcement = null } = {}) {
  state = { ...state, ...patch };
  navigate(state, { replace });
  // 読み上げは renderAll() より先に出す。announce() は live region の textContent を置き換えるので、
  // 後から呼んだものだけが支援技術に届く。年代切替の定型文を後に出すと、
  // 描画中に出る「〜が変わりました / 〜が無くなりました」を必ず打ち消してしまう。
  // 差分がある切替では差分の文が残り、差分が無ければこの定型文が残る。
  if (announcement) announce(announcement);
  renderAll();
}

function onYearChange(newYear) {
  if (newYear === state.year) return;
  previousStatusForDiff = state.personId ? findStatus(data, state.personId, state.year) : null;
  setState({ year: newYear }, { announcement: `${newYear}年時点の表示に切り替えました。` });
}

function onViewChange(view) {
  if (view === state.view || !VIEW_IDS.includes(view)) return;
  const label = VIEWS.find((v) => v.id === view)?.label || view;
  setState({ view }, { announcement: `${label}の表示に切り替えました。` });
}

// 以下の4つは「対象を選ぶ」と同時に「その対象が表示できる面へ移る」(面をまたぐ相互移動)。
// 面をまたいだ移動は画面全体が入れ替わるので、何が起きたかを必ず読み上げる。

function onPersonSelect(personId) {
  if (personId === state.personId && state.view === 'people') return;
  previousStatusForDiff = null; // 別人物を選んだ直後は比較対象が無いので差分は出さない
  setState(
    { personId, view: 'people' },
    { announcement: `人物「${nameOf(data.people, personId, 'canonical_name')}」を表示しました。` },
  );
}

function onEventSelect(eventId) {
  if (eventId === state.eventId && state.view === 'events') return;
  setState(
    { eventId, view: 'events' },
    { announcement: `事件「${nameOf(data.events, eventId, 'name')}」を表示しました。` },
  );
}

function onFactionSelect(factionId) {
  if (factionId === state.factionId && state.view === 'factions') return;
  setState(
    { factionId, view: 'factions' },
    { announcement: `勢力「${nameOf(data.factions, factionId, 'name')}」を表示しました。` },
  );
}

function onPlaceSelect(placeId) {
  if (placeId === state.placeId && state.view === 'map') return;
  setState(
    { placeId, view: 'map' },
    { announcement: `場所「${nameOf(data.places, placeId, 'name')}」を地図で表示しました。` },
  );
}

function onMapModeChange(mode) {
  const next = normalizeMode(mode);
  if (next === state.mapMode) return;
  setState({ mapMode: next }, { announcement: `地図を${MAP_MODE_LABELS[next]}モードに切り替えました。` });
}

function onSourceSelect(sourceId) {
  state = { ...state, sourceId };
  navigate(state);
  renderSourcesSection();
  announce(`出典「${nameOf(data.sources, sourceId, 'title')}」を開きました。`);
}

function onSourceClose() {
  state = { ...state, sourceId: null };
  navigate(state);
  renderSourcesSection();
}

/**
 * 検索欄の入力ごとに呼ばれる。search.js は自身の innerHTML を作り直すため、素朴に呼ぶと
 * 入力中のフォーカス・カーソル位置が毎回失われる。renderSearchSection() 内の renderPreservingFocus
 * (focus.js。他の再描画箇所と共通の仕組み)がフォーカスと選択範囲を保存/復元する。
 */
function onQueryChange(query) {
  state = { ...state, query };
  navigate(state, { replace: true }); // 検索入力中の連打で履歴を積まない(router.jsのコメント参照)
  renderSearchSection();
}

/** 全ビュー共通のハンドラ束。どのビューも「選んだら移動できる」形にそろえる。 */
const crossNav = {
  onSelectPerson: onPersonSelect,
  onSelectEvent: onEventSelect,
  onSelectFaction: onFactionSelect,
  onSelectPlace: onPlaceSelect,
  onSelectSource: onSourceSelect,
};

// ---- 各セクションの描画 ----
//
// どのセクションも中身を container.innerHTML = '' で作り直す(各ビューモジュールの実装)。
// 素朴に呼ぶと、そのとき操作していた要素からフォーカスが <body> に落ちてしまい、キーボード操作のたびに
// 毎回Tabで最初から辿り直す必要が生じる(仕様§7.2に反する)。renderPreservingFocus(focus.js)で
// 全セクション共通にフォーカス位置を保存・復元する(各ビューモジュール側は data-focus-key を振るだけでよい)。

function renderTimelineSection() {
  renderPreservingFocus(els.timeline, () => {
    renderTimeline(els.timeline, {
      year: state.year,
      onChange: onYearChange,
    });
  });
}

function renderViewNav() {
  renderPreservingFocus(els.viewNav, () => {
    els.viewNav.innerHTML = '';
    const counts = {
      people: data.people?.length ?? 0,
      events: data.events?.length ?? 0,
      factions: data.factions?.length ?? 0,
      map: data.places?.length ?? 0,
    };
    for (const view of VIEWS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'view-nav-button';
      button.dataset.focusKey = `view-nav:${view.id}`;
      if (view.id === state.view) button.setAttribute('aria-current', 'page');
      const label = document.createElement('span');
      label.textContent = view.id === state.view ? `▶ ${view.label}` : view.label;
      button.appendChild(label);
      const count = document.createElement('span');
      count.className = 'view-nav-count';
      count.textContent = `${counts[view.id]}件`;
      button.appendChild(count);
      button.addEventListener('click', () => onViewChange(view.id));
      els.viewNav.appendChild(button);
    }
  });
}

/** 選択中の面のパネルだけを表示する。hidden の付け外しだけで、中身の描画は各 render*Section が行う。 */
function applyViewVisibility() {
  for (const view of VIEWS) {
    const panel = document.getElementById(view.panelId);
    if (panel) panel.hidden = view.id !== state.view;
  }
}

function renderSearchSection() {
  renderPreservingFocus(els.search, () => {
    renderSearch(els.search, {
      data,
      index: searchIndex,
      query: state.query,
      year: state.year,
      onQueryChange,
      onSelect: onPersonSelect,
    });
  });
}

function renderPeopleSection() {
  renderPreservingFocus(els.peopleList, () => {
    renderPeopleList(els.peopleList, {
      data,
      year: state.year,
      selectedPersonId: state.personId,
      onSelect: onPersonSelect,
    });
  });
}

function renderPersonDetailSection() {
  renderPreservingFocus(els.personDetail, () => {
    renderPersonDetail(els.personDetail, {
      data,
      personId: state.personId,
      year: state.year,
      previousStatus: previousStatusForDiff,
      onSelectSource: onSourceSelect,
      onSelectPerson: onPersonSelect,
      onSelectEvent: onEventSelect,
    });
  });
}

function renderSourcesSection() {
  renderPreservingFocus(els.sources, () => {
    renderSources(els.sources, {
      data,
      sourceId: state.sourceId,
      onClose: onSourceClose,
    });
  });
}

function renderRelationGraphSection() {
  const container = els.relationGraph;
  renderPreservingFocus(container, () => {
    container.innerHTML = '';

    if (!state.personId) {
      const p = document.createElement('p');
      p.className = 'relation-graph-empty';
      p.textContent = '人物を選択すると相関図が表示されます。';
      container.appendChild(p);
      return;
    }

    // relation-graph.js の renderRelationGraph は model.people に含まれる人物同士の関係だけを線として描く
    // (時点でのフィルタは行わない)。そのため呼び出し側(ここ)で、①relationsAtTime で当該年に有効な関係だけに絞り、
    // ②選択中の人物とその関係先(隣接ノード)だけを people に渡す。これで仕様§4.6 が求める
    // 「選択人物を中心とした最小の相関図(3〜5名)」になる(全10名を毎回渡すと孤立ノードだらけの図になってしまう)。
    const relevantRelations = relationsAtTime(data.relations, state.year);
    const neighborIds = new Set();
    for (const r of relevantRelations) {
      if (r.person_a_id === state.personId) neighborIds.add(r.person_b_id);
      if (r.person_b_id === state.personId) neighborIds.add(r.person_a_id);
    }
    const peopleForGraph = [state.personId, ...neighborIds]
      .map((id) => data.people.find((p) => p.id === id))
      .filter(Boolean)
      .map((p) => ({ id: p.id, canonical_name: p.canonical_name }));

    // 仲介者(mediator_person_ids)が上記の隣接ノードに含まれないケースがある(例: 西郷⇄木戸の同盟の
    // 仲介者=坂本龍馬が、当該人物の直接の関係先ではない場合)。図にノードや線を増やさず(孤立ノード回避)、
    // 名前解決のためだけに relation-graph.js の任意フィールド model.mediatorPeople へ渡す。
    const mediatorIds = new Set();
    for (const r of relevantRelations) {
      if (!Array.isArray(r.mediator_person_ids)) continue;
      for (const mid of r.mediator_person_ids) {
        if (mid !== state.personId && !neighborIds.has(mid)) mediatorIds.add(mid);
      }
    }
    const mediatorPeople = [...mediatorIds]
      .map((id) => data.people.find((p) => p.id === id))
      .filter(Boolean)
      .map((p) => ({ id: p.id, canonical_name: p.canonical_name }));

    renderRelationGraph(
      container,
      {
        centerPersonId: state.personId,
        asOf: state.year,
        people: peopleForGraph,
        relations: relevantRelations,
        selectedRelationId,
        mediatorPeople,
        sources: data.sources,
      },
      {
        onSelectRelation(relationId) {
          selectedRelationId = relationId;
          renderRelationGraphSection();
        },
        onSelectPerson: onPersonSelect,
        onSelectSource: onSourceSelect,
      },
    );
  });
}

// ---- 事件 ----

function selectedEvent() {
  return (data.events || []).find((e) => e.id === state.eventId) || null;
}

function renderEventListSection() {
  renderPreservingFocus(els.eventList, () => {
    renderEventList(
      els.eventList,
      {
        events: data.events || [],
        places: data.places || [],
        year: state.year,
        selectedEventId: state.eventId,
        // 日付の粒度が違う事件どうしの並び順を因果で決めるため(因果グラフと同じ規則にする)
        eventRelations: data.eventRelations || [],
      },
      { onSelectEvent: onEventSelect },
    );
  });
}

function renderEventDetailSection() {
  renderPreservingFocus(els.eventDetail, () => {
    renderEventDetail(
      els.eventDetail,
      {
        event: selectedEvent(),
        places: data.places || [],
        people: data.people || [],
        factions: data.factions || [],
        sources: data.sources || [],
        eventRelations: data.eventRelations || [],
        // events-view.js の renderEventDetail は「前の事件」「次に読むべき事件」フィールドと因果関係欄で
        // model.events から事件名を解決する(渡さないとIDがそのまま「(見つかりません)」付きで出る)。
        events: data.events || [],
      },
      crossNav,
    );
  });
}

function renderEventGraphSection() {
  renderPreservingFocus(els.eventGraph, () => {
    renderEventGraph(
      els.eventGraph,
      {
        events: data.events || [],
        eventRelations: data.eventRelations || [],
        selectedEventId: state.eventId,
        sources: data.sources || [],
      },
      { onSelectEvent: onEventSelect, onSelectSource: onSourceSelect },
    );
  });
}

// ---- 勢力 ----

function renderFactionListSection() {
  renderPreservingFocus(els.factionList, () => {
    renderFactionList(
      els.factionList,
      {
        factions: data.factions || [],
        factionStatuses: data.factionStatuses || [],
        year: state.year,
        selectedFactionId: state.factionId,
      },
      { onSelectFaction: onFactionSelect },
    );
  });
}

function renderFactionDetailSection() {
  renderPreservingFocus(els.factionDetail, () => {
    renderFactionDetail(
      els.factionDetail,
      {
        faction: (data.factions || []).find((f) => f.id === state.factionId) || null,
        factions: data.factions || [], // 契約外の任意フィールド。協力・対立勢力のIDを名前へ解決するため
        factionStatuses: data.factionStatuses || [],
        year: state.year,
        people: data.people || [],
        events: data.events || [],
        places: data.places || [],
        sources: data.sources || [],
      },
      { ...crossNav, onSelectFaction: onFactionSelect },
    );
  });
}

// ---- 地図 ----

function renderMapControlsSection() {
  renderPreservingFocus(els.mapControls, () => {
    els.mapControls.innerHTML = '';
    const heading = document.createElement('h2');
    heading.className = 'section-heading';
    heading.textContent = '地図の表示モード';
    els.mapControls.appendChild(heading);

    const group = document.createElement('div');
    group.className = 'map-mode-controls';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', '地図の表示モード');
    for (const mode of MAP_MODES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'map-mode-button';
      button.dataset.focusKey = `map-mode:${mode}`;
      button.setAttribute('aria-pressed', String(mode === state.mapMode));
      button.textContent = MAP_MODE_LABELS[mode];
      button.addEventListener('click', () => onMapModeChange(mode));
      group.appendChild(button);
    }
    els.mapControls.appendChild(group);
  });
}

function renderMapSection() {
  renderPreservingFocus(els.map, () => {
    renderMap(
      els.map,
      {
        places: data.places || [],
        events: data.events || [],
        people: data.people || [],
        factions: data.factions || [], // 契約外の任意フィールド。勢力モードの絞り込みに使う
        year: state.year,
        mode: state.mapMode,
        selectedPlaceId: state.placeId,
        sources: data.sources || [],
      },
      crossNav,
    );
  });
}

// ---- 全体の再描画 ----
//
// 選択中の面のセクションだけを描く。隠れている面まで毎回描くと、320px 幅の端末で
// 目に見えない DOM の生成コストだけが積み上がるため(仕様§7.3)。

function renderAll() {
  renderTimelineSection();
  renderViewNav();
  applyViewVisibility();

  if (state.view === 'people') {
    renderSearchSection();
    renderPeopleSection();
    renderPersonDetailSection();
    renderRelationGraphSection();
  } else if (state.view === 'events') {
    renderEventListSection();
    renderEventDetailSection();
    renderEventGraphSection();
  } else if (state.view === 'factions') {
    renderFactionListSection();
    renderFactionDetailSection();
  } else if (state.view === 'map') {
    renderMapControlsSection();
    renderMapSection();
  }

  renderSourcesSection();
}

// ---- 初期化 ----

/**
 * URL から読んだ状態を既定値で補い、値域外の値を既定へ戻す。
 * URL はブラウザのアドレスバーから利用者が自由に書き換えられるため、view は既知のビュー名のみ、
 * eventId/factionId/placeId は実データに存在するIDのみを採用する。不正値はアプリを落とさず、
 * 既定値(view は 'people'、ID類は null = 未選択)へ静かにフォールバックする。
 */
function normalizeState(raw) {
  const merged = { ...DEFAULT_STATE, ...raw };
  if (!VIEW_IDS.includes(merged.view)) merged.view = DEFAULT_STATE.view;
  merged.mapMode = normalizeMode(merged.mapMode);
  if (merged.eventId && !(data.events || []).some((e) => e.id === merged.eventId)) {
    merged.eventId = null;
  }
  if (merged.factionId && !(data.factions || []).some((f) => f.id === merged.factionId)) {
    merged.factionId = null;
  }
  if (merged.placeId && !(data.places || []).some((p) => p.id === merged.placeId)) {
    merged.placeId = null;
  }
  return merged;
}

async function init() {
  try {
    data = await loadDataset('data');
  } catch (err) {
    if (els.fatalError) {
      els.fatalError.hidden = false;
      els.fatalError.textContent = `データの読み込みに失敗しました: ${err.message}`;
    }
    return;
  }

  searchIndex = buildSearchIndex(data);
  state = normalizeState(readStateFromUrl());

  initRouter((restored) => {
    previousStatusForDiff = null; // 戻る/進む操作では「直前の年」を追跡していないので差分は出さない
    state = normalizeState(restored);
    renderAll();
  });

  renderAll();
}

init();
