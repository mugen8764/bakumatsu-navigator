// state.js — アプリの状態管理(データ読み込み・URL⇔状態変換・純関数のドメインヘルパー)。
// DOM を直接操作しない(render系は各ビュー担当モジュールに置く)。
// 配信JSは外部依存ゼロ(fetch / URLSearchParams / history のみ使用)。

/** URLに状態が無いときの既定の時点年。実測データが存在する最初期の年。 */
export const DEFAULT_YEAR = '1858';

/**
 * 確度(review_status)は読者向けの画面には出さない。
 * データとしては保持し続けるが、記号・ラベルへ変換する経路は持たない。
 * ここを空にしておくことで、どこかのビューが確度を描画しようとしても文字列にならない。
 */
export const STATUS_LABELS = {};

/**
 * 確度を画面に出すときの文字列。**常に空文字を返す**(読者向けには確度を表示しない)。
 * 呼び出し側は空文字なら行・欄ごと出さない作りにしてある。
 */
export function statusLabelText() {
  return '';
}

/** 確度を画面に出してよいか。読者向けには一切出さないので常に false。 */
export function isShowableStatus() {
  return false;
}

/** display_name を「欄自体を出さない」扱いにする確度。 */
const DISPLAY_NAME_HIDDEN_STATUSES = new Set(['needs_review', 'unknown']);

const DATA_FILES = [
  'people',
  'person-statuses',
  'aliases',
  'relations',
  'factions',
  'faction-statuses',
  'events',
  'event-relations',
  'places',
  'sources',
];

const CAMEL_KEY = {
  people: 'people',
  'person-statuses': 'personStatuses',
  aliases: 'aliases',
  relations: 'relations',
  factions: 'factions',
  'faction-statuses': 'factionStatuses',
  events: 'events',
  'event-relations': 'eventRelations',
  places: 'places',
  sources: 'sources',
};

/**
 * data/*.json を fetch で読み込み、{people, personStatuses, aliases, ...} 形式で返す。
 * `python3 -m http.server` 等で配信されている前提(README参照。file:// では ES modules の CORS 制約により動かない)。
 */
export async function loadDataset(baseUrl = 'data') {
  const entries = await Promise.all(
    DATA_FILES.map(async (name) => {
      const res = await fetch(`${baseUrl}/${name}.json`);
      if (!res.ok) {
        throw new Error(`${name}.json の読み込みに失敗しました(HTTP ${res.status})`);
      }
      const json = await res.json();
      return [CAMEL_KEY[name], json];
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * URLのクエリパラメータから状態を復元する。
 * 「選択中の面(view)・選択中の事件/勢力/場所・地図の表示モード」もここで読む。
 * ここでは値域チェックはしない(既知のビュー名かどうか・IDが実データに存在するかは、データを持たない
 * この関数では判定できないため)。呼び出し側(app.js の normalizeState)が既定値の補完と値域外の
 * フォールバックを行う契約(view/mapMode の既定値・存在しないIDの null 化)。
 */
export function readStateFromUrl(location = window.location) {
  const params = new URLSearchParams(location.search);
  return {
    year: params.get('year') || DEFAULT_YEAR,
    personId: params.get('person') || null,
    query: params.get('q') || '',
    sourceId: params.get('source') || null,
    view: params.get('view') || null,
    eventId: params.get('event') || null,
    factionId: params.get('faction') || null,
    placeId: params.get('place') || null,
    mapMode: params.get('mapMode') || null,
  };
}

/**
 * 状態をURLのクエリパラメータへ変換する。
 * 既定値のときはパラメータを出さない(view の既定値 'people'・mapMode の既定値 'event' は
 * app.js の DEFAULT_STATE / map-view.js の normalizeMode と揃えてある)。
 */
export function stateToSearchParams(state) {
  const params = new URLSearchParams();
  params.set('year', state.year || DEFAULT_YEAR);
  if (state.personId) params.set('person', state.personId);
  if (state.query) params.set('q', state.query);
  if (state.sourceId) params.set('source', state.sourceId);
  if (state.view && state.view !== 'people') params.set('view', state.view);
  if (state.eventId) params.set('event', state.eventId);
  if (state.factionId) params.set('faction', state.factionId);
  if (state.placeId) params.set('place', state.placeId);
  if (state.mapMode && state.mapMode !== 'event') params.set('mapMode', state.mapMode);
  return params;
}

// ---- ドメインヘルパー(純関数) ----

export function findPerson(data, personId) {
  return data.people.find((p) => p.id === personId) || null;
}

export function findStatus(data, personId, year) {
  return data.personStatuses.find((s) => s.person_id === personId && s.as_of === year) || null;
}

export function findAliasesForPerson(data, personId) {
  return data.aliases.filter((a) => a.person_id === personId);
}

export function findSource(data, sourceId) {
  return data.sources.find((s) => s.id === sourceId) || null;
}

/** その人物の time-of-record が1件でも存在する年の集合。 */
export function yearsWithData(personStatuses) {
  return new Set(personStatuses.map((s) => s.as_of));
}

/** 日付文字列(YYYY / YYYY-MM / YYYY-MM-DD)から年を取り出す。解釈できなければ null。 */
function extractYear(value) {
  if (value === null || value === undefined || value === '') return null;
  const m = String(value).match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

/**
 * 指定年に、その人物の time-of-record が「無いのが正しい(生前/死後)」のか、
 * それとも「本来ありうるが登録されていない」のかを判定する。
 * 生没年が不明な人物・不明な側の境界は、存在しないと断定できないので安全側(gap)に倒す
 * (仕様§11「不明な項目を推測で補完しない」を出し分け判定にも適用する)。
 * @returns {{kind: 'not-yet-born'|'after-death', boundaryDate: string}|{kind: 'gap'}}
 */
export function personStatusGapReason(person, year) {
  const target = extractYear(year);
  if (target === null || !person) return { kind: 'gap' };
  const birthYear = extractYear(person.birth_date);
  if (birthYear !== null && target < birthYear) {
    return { kind: 'not-yet-born', boundaryDate: person.birth_date };
  }
  const deathYear = extractYear(person.death_date);
  if (deathYear !== null && target > deathYear) {
    return { kind: 'after-death', boundaryDate: person.death_date };
  }
  return { kind: 'gap' };
}

/**
 * 指定年にその人物が(生没年から見て)存在しうるか。生没年が不明な場合は否定できないので true。
 * map-view.js の人物モード(出身地)の時点絞り込みに使う。
 */
export function personExistsAtYear(person, year) {
  return personStatusGapReason(person, year).kind === 'gap';
}

/**
 * display_name をその時点で表示してよいか。
 * 値が null、または確度が needs_review/unknown の場合は「欄自体を出さない」。
 */
export function isDisplayNameVisible(status) {
  if (!status || status.display_name === null || status.display_name === undefined) return false;
  const reviewStatus = status.field_review_status?.display_name;
  return !DISPLAY_NAME_HIDDEN_STATUSES.has(reviewStatus);
}

/**
 * 複数フィールドをまとめて1行で要約表示する際(people-view.js の一覧カード等)に、
 * 「調べた上で状態が存在しない」(unknown。例: 没後で役職という状態自体が無い)と
 * 「まだ確認していない」(needs_review)を区別するためのラベルキーを1つ選ぶ。
 *
 * fields のうち値が null/undefined のものだけを見て、
 * - 1件も無ければ(=要約対象がすべて埋まっている)null を返す(この関数を呼ぶ必要が無いケース)
 * - null な項目全部に field_review_status が記録されていて、かつ全部 'unknown' なら 'unknown'
 * - それ以外(review_status が無い/needs_review が混じる/一部だけ記録がある等、判定が付かない場合)は
 *   安全側(=「まだ確認していない」)に倒して 'needs_review' を返す
 *
 * @param {object|null} status person-statuses の1レコード
 * @param {string[]} fields 要約に使うフィールド名(例: ['affiliation_text', 'role', 'activity_description'])
 * @returns {'unknown'|'needs_review'|null}
 */
export function missingFieldsStatus(status, fields) {
  if (!status) return 'needs_review';
  const nullFields = fields.filter((f) => status[f] === null || status[f] === undefined);
  if (nullFields.length === 0) return null;

  const recordedStatuses = nullFields
    .map((f) => status.field_review_status?.[f])
    .filter((s) => s !== undefined);
  if (recordedStatuses.length === 0) return 'needs_review';

  const allUnknown = recordedStatuses.every((s) => s === 'unknown');
  return allUnknown ? 'unknown' : 'needs_review';
}

/**
 * 2つの時点の person-status を比較し、変化したフィールド名を返す。
 * 戻り値: { fromYear, toYear, fields: string[] } または比較不能なら null。
 *
 * **両方の時点に値があるときだけ変化に数える。** 片側が空欄の項目は、値が入っている側と比べて
 * 違って見えても「変化」として扱わない。裏づけの無い項目を画面に出さない方針と同じ向きで、
 * display_name は元からこの規則を守っており、残る3項目を後から同じ規則へ揃えた。
 *
 * **ただし空欄には2種類ある。** missingFieldsStatus が区別しているとおり、
 * 「まだ確認できていない」空欄(needs_review)と、「調べた上でその状態が存在しないことが分かった」空欄
 * (unknown。例 = 死去・役職の罷免・官位の剥奪。資料がその旨を明記している)。
 * **後者は「無くなった」という変化そのもの**なので、`lost` として別に返し、画面でも別の言い方で伝える。
 *
 * 戻り値の `fields` と `lost` は読者に伝える意味が違うので混ぜない:
 * - `fields` = 値が別の値に**変わった**項目
 * - `lost`   = 値があったのに、**調べた上で存在しないことが確定した**項目
 *
 * `lost` の対象は所属と役職だけにする。表示名は、人の名前が死去や罷免で無くなるわけではなく
 * その時点の名乗りの記録が無いだけだから。活動は、その年に何をしたかであって
 * 「無くなる状態」ではないから(「活動が無くなりました」は日本語として意味をなさない)。
 * また、後の時点から前の時点へ戻る操作でも呼ばれるので、`lost` は年が進むときだけ返す
 * (戻る操作で「無くなりました」と出ると時間の向きを取り違えた文になる)。
 */
const LOSABLE_FIELDS = ['affiliation_text', 'role'];
export function computeStatusDiff(prevStatus, nextStatus) {
  if (!prevStatus || !nextStatus) return null;
  const fields = [];
  const lost = [];
  const fromYear = Number(prevStatus.as_of);
  const toYear = Number(nextStatus.as_of);
  const goingForward = Number.isFinite(fromYear) && Number.isFinite(toYear) && toYear > fromYear;

  // display_name だけは「欄が画面に出ているか」も条件に入る(出ていない欄を差分にしない)。
  const prevName = isDisplayNameVisible(prevStatus) ? prevStatus.display_name : null;
  const nextName = isDisplayNameVisible(nextStatus) ? nextStatus.display_name : null;
  if (prevName !== null && nextName !== null && prevName !== nextName) {
    fields.push('display_name');
  }

  for (const key of ['affiliation_text', 'role', 'activity_description']) {
    const prevVal = prevStatus[key] ?? null;
    const nextVal = nextStatus[key] ?? null;
    if (prevVal !== null && nextVal !== null && prevVal !== nextVal) {
      fields.push(key);
    } else if (
      goingForward
      && LOSABLE_FIELDS.includes(key)
      && prevVal !== null
      && nextVal === null
      && nextStatus.field_review_status?.[key] === 'unknown'
    ) {
      lost.push(key);
    }
  }

  return { fromYear: prevStatus.as_of, toYear: nextStatus.as_of, fields, lost };
}
