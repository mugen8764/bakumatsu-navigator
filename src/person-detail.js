// person-detail.js — 人物詳細(仕様§4.4)。選択時点での基本情報・4項目(表示名/所属/役職/活動)を
// 出典つきで表示する。
//
// - 条件1: findStatus(state.js)で選択時点の role 等を取得して表示するだけで、年代切替に自動追随する。
// - 条件2: computeStatusDiff(state.js。既存)の結果を使い、変化した項目に「●変更あり」の記号+背景強調を付ける
//          (色だけで区別しない。styles.css の .person-field--changed を参照)。
// - 条件4: 各項目の field_sources / 関係の source_ids をボタン化し、押すと onSelectSource(id) で出典表示へ渡す。

import {
  findPerson,
  findStatus,
  findAliasesForPerson,
  findSource,
  isDisplayNameVisible,
  computeStatusDiff,
  personStatusGapReason,
} from './state.js';
import { announce } from './live-region.js';

const FIELD_LABELS = {
  display_name: '表示名',
  affiliation_text: '所属',
  role: '役職',
  activity_description: '活動',
};

const FIELD_ORDER = ['display_name', 'affiliation_text', 'role', 'activity_description'];

/**
 * 出典IDの配列をボタン群として描画する(出典表示への到達経路)。
 * keyPrefix は再描画をまたいだフォーカス復元(focus.js)のための data-focus-key を組み立てる接頭辞。
 * 呼び出し元ごとに一意な文脈(フィールド名や関係IDなど)を渡す。
 */
function renderSourceRefs(parent, { sourceIds, data, onSelectSource, keyPrefix }) {
  if (!sourceIds || sourceIds.length === 0) return;
  const p = document.createElement('p');
  p.className = 'source-refs';

  const label = document.createElement('span');
  label.className = 'source-refs-label';
  label.textContent = '出典: ';
  p.appendChild(label);

  sourceIds.forEach((sid, i) => {
    const src = findSource(data, sid);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'source-ref-button';
    btn.setAttribute('data-focus-key', `source-ref-${keyPrefix}-${sid}-${i}`);
    btn.textContent = src ? src.title : `${sid}(見つかりません)`;
    btn.addEventListener('click', () => onSelectSource(sid));
    p.appendChild(btn);
    if (i < sourceIds.length - 1) p.appendChild(document.createTextNode(' '));
  });

  parent.appendChild(p);
}

function renderField(container, { field, status, changed, data, onSelectSource }) {
  // 値が無い項目は行ごと非表示にする(プレースホルダを出さない)。
  const rawValue = status[field];
  if (rawValue === null || rawValue === undefined || rawValue === '') return;

  const row = document.createElement('div');
  row.className = 'person-field';
  if (changed) row.classList.add('person-field--changed');

  const label = document.createElement('span');
  label.className = 'person-field-label';
  label.textContent = FIELD_LABELS[field];
  row.appendChild(label);


  const valueSpan = document.createElement('span');
  valueSpan.className = 'person-field-value';
  valueSpan.textContent = rawValue;
  row.appendChild(valueSpan);

  // 出典で裏づけた度合い(確認済み・推定・諸説あり)だけを記号+ラベルで添える。

  if (changed) {
    const tag = document.createElement('span');
    tag.className = 'person-field-changed-tag';
    tag.textContent = '● 変更あり';
    row.appendChild(tag);
  }

  container.appendChild(row);

  const srcIds = status.field_sources?.[field] ?? [];
  renderSourceRefs(row, { sourceIds: srcIds, data, onSelectSource, keyPrefix: `field-${field}` });

  // 値がある項目では、主な内容は値のほうなので根拠メモは畳んでおく。
  const note = status.field_notes?.[field];
  if (note) {
    const details = document.createElement('details');
    details.className = 'person-field-note';
    const summary = document.createElement('summary');
    summary.textContent = '根拠メモ';
    details.appendChild(summary);
    const p = document.createElement('p');
    p.textContent = note;
    details.appendChild(p);
    row.appendChild(details);
  }
}

/** 指定人物が指定年に関わる人物関係(relations.json)を、当該年に有効な期間のものだけ返す。 */
function relationsForPersonAtYear(data, personId, year) {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  return (data.relations || []).filter((r) => {
    if (r.person_a_id !== personId && r.person_b_id !== personId) return false;
    if (r.end_date && r.end_date < yearStart) return false;
    if (r.start_date && r.start_date > yearEnd) return false;
    return true;
  });
}

/**
 * その人物が関与した事件(events.json 側の person_ids に当該人物IDを含むもの)を返す。
 * events 側が正典で、people 側にイベント参照は持たない(実データを読んで確認済み)。
 */
function eventsForPerson(events, personId) {
  return (Array.isArray(events) ? events : []).filter((e) => (e?.person_ids || []).includes(personId));
}

/**
 * @param {HTMLElement} container
 * @param {{
 *   data: object,
 *   personId: string|null,
 *   year: string,
 *   previousStatus: object|null,
 *   onSelectSource: (sourceId:string)=>void,
 *   onSelectPerson: (personId:string)=>void,
 *   onSelectEvent?: (eventId:string)=>void,
 * }} params
 */
export function renderPersonDetail(
  container,
  { data, personId, year, previousStatus, onSelectSource, onSelectPerson, onSelectEvent },
) {
  container.innerHTML = '';

  const heading = document.createElement('h2');
  heading.className = 'section-heading';
  heading.textContent = '人物詳細';
  container.appendChild(heading);

  if (!personId) {
    const p = document.createElement('p');
    p.className = 'person-detail-empty';
    p.textContent = '人物一覧または検索から人物を選択してください。';
    container.appendChild(p);
    return;
  }

  const person = findPerson(data, personId);
  if (!person) {
    const p = document.createElement('p');
    p.className = 'person-detail-empty';
    p.textContent = `人物 ${personId} が見つかりません。`;
    container.appendChild(p);
    return;
  }

  const nameHeading = document.createElement('h3');
  nameHeading.className = 'person-detail-name';
  nameHeading.textContent = person.canonical_name;
  container.appendChild(nameHeading);

  if (person.reading) {
    const reading = document.createElement('p');
    reading.className = 'person-detail-reading';
    reading.textContent = person.reading;
    container.appendChild(reading);
  }

  const lifespan = document.createElement('p');
  lifespan.className = 'person-detail-lifespan';
  lifespan.textContent = `生没: ${person.birth_date || '不明'} 〜 ${person.death_date || '不明(または存命扱いのデータなし)'}`;
  container.appendChild(lifespan);

  // 人物の紹介文と「後に何をした人として知られるか」。
  // どちらも値が空なら欄自体を出さない(空欄を見せない = display_name と同じ扱い)。
  // later_known_for は幕末に没した人物には構造的に存在しないので、空でも欠落ではない。
  if (person.summary) {
    const summaryP = document.createElement('p');
    summaryP.className = 'person-detail-summary';
    summaryP.textContent = person.summary;
    container.appendChild(summaryP);
  }
  if (person.later_known_for) {
    const laterP = document.createElement('p');
    laterP.className = 'person-detail-later';
    laterP.textContent = `後の知られ方: ${person.later_known_for}`;
    container.appendChild(laterP);
  }

  // 生没年・紹介文・後の知られ方の根拠(人物そのものに紐づく出典)への導線。
  // 時点別の項目は renderField が field_sources を出すが、人物本体の項目にはその経路が無かった。
  // 出典の notes には「なぜこの粒度なのか」(例: 生年に諸説あるため年のみ)が書かれているので、
  // ここを塞がないと読者はその弱さに到達できない。勢力詳細と同じ形にそろえる。
  renderSourceRefs(container, {
    sourceIds: person.source_ids,
    data,
    onSelectSource,
    keyPrefix: `person-${personId}`,
  });

  const aliases = findAliasesForPerson(data, personId);
  if (aliases.length > 0) {
    const aliasP = document.createElement('p');
    aliasP.className = 'person-detail-aliases';
    aliasP.textContent = `別名: ${aliases.map((a) => (a.reading ? `${a.alias}(${a.reading})` : a.alias)).join('、')}`;
    container.appendChild(aliasP);
  }

  const status = findStatus(data, personId, year);
  const fieldsWrap = document.createElement('div');
  fieldsWrap.className = 'person-fields';

  if (!status) {
    // 生前/死後で状態がそもそも無い場合は事実として明示する(state.js の personStatusGapReason が正典)。
    // それ以外(この時点の状態が登録されていないだけ)は何も表示しない。
    const gap = personStatusGapReason(person, year);
    if (gap.kind === 'not-yet-born' || gap.kind === 'after-death') {
      const notice = document.createElement('p');
      notice.setAttribute('role', 'note');
      notice.className = 'data-gap-notice data-gap-notice--not-yet';
      notice.textContent =
        gap.kind === 'not-yet-born'
          ? `${person.canonical_name}は${year}年時点ではまだ生まれていません(生年: ${gap.boundaryDate})。`
          : `${person.canonical_name}は${year}年時点で既に没しています(没年: ${gap.boundaryDate})。`;
      fieldsWrap.appendChild(notice);
    }
  } else {
    const diff = previousStatus ? computeStatusDiff(previousStatus, status) : null;
    const changedFields = new Set(diff ? diff.fields : []);

    // 「変わった」と「無くなった」は伝える意味が違うので別の文にする。
    // ただし読み上げ(announce)は最後に1回だけにまとめる——live region は textContent を
    // 置き換える仕組みなので、2回呼ぶと先の文が支援技術に届かないまま消える。
    const spoken = [];

    if (diff && diff.fields.length > 0) {
      const summary = document.createElement('p');
      summary.className = 'diff-summary';
      summary.setAttribute('role', 'status');
      // aria-live はこの要素自体には付けない(container.innerHTML='' で毎回作り直され読み上げられない)。
      // 読み上げは常設の #a11y-live(live-region.js の announce())に一本化する。
      summary.textContent = `${diff.fromYear}年→${diff.toYear}年で ${diff.fields
        .map((f) => FIELD_LABELS[f])
        .join('、')} が変わりました。`;
      fieldsWrap.appendChild(summary);
      spoken.push(summary.textContent);
    }

    // 「調べた上でその状態が存在しないことが確定した」項目は、変わったのではなく無くなったので
    // 別の文で伝える(state.js の computeStatusDiff が lost として返す。実例 = 役職の罷免・官位の剥奪)。
    if (diff && diff.lost.length > 0) {
      const lostSummary = document.createElement('p');
      // 見た目は「変わりました」と同じにしている(色や飾りで区別せず、文そのもので区別する)。
      // 修飾クラスは走査・テストから2つの文を区別するための手がかりとして付けている。
      lostSummary.className = 'diff-summary diff-summary--lost';
      lostSummary.setAttribute('role', 'status');
      const labels = diff.lost.map((f) => FIELD_LABELS[f]).join('、');
      // 直前に「変わりました」の文が出ているときは、年の前置きを繰り返さない。
      lostSummary.textContent = spoken.length > 0
        ? `${labels} が無くなりました。`
        : `${diff.fromYear}年→${diff.toYear}年で ${labels} が無くなりました。`;
      fieldsWrap.appendChild(lostSummary);
      spoken.push(lostSummary.textContent);

      // 「無くなった」も所属・役職についての主張なので、その根拠へ辿れるようにする
      // (出典は項目単位で紐づける、という設計に従う)。
      // 値が null だと項目の欄自体が出ないので、renderField 経由では出典に到達できない。
      const lostSourceIds = [...new Set(diff.lost.flatMap((f) => status.field_sources?.[f] ?? []))];
      renderSourceRefs(fieldsWrap, {
        sourceIds: lostSourceIds,
        data,
        onSelectSource,
        keyPrefix: `lost-${personId}-${diff.toYear}`,
      });

      // なぜ無くなったのかを添える。値が無い項目は欄そのものが出ないため、
      // 通常の経路(renderField)では根拠メモが読者に届かない。
      //
      // ここでは畳まずに素の段落として出す。値がある項目と違って、この年に画面へ出るのは
      // 「無くなりました」の一文だけになり、**なぜ無くなったのかがその場の主な内容**になるため。
      // 複数の項目が同じ理由で無くなることがあるので、同じ文は1回だけ出す。
      const seenNotes = new Set();
      for (const field of diff.lost) {
        const note = status.field_notes?.[field];
        if (!note || seenNotes.has(note)) continue;
        seenNotes.add(note);
        const reason = document.createElement('p');
        reason.className = 'person-field-note person-field-note--lost';
        reason.textContent = note;
        fieldsWrap.appendChild(reason);
      }
    }

    if (spoken.length > 0) announce(spoken.join(' '));

    for (const field of FIELD_ORDER) {
      // 時点別の表示名は、裏づけのある人物・時点にだけ出す(それ以外は欄自体を出さない)。
      // 判定は state.js の isDisplayNameVisible が正典で、人物一覧(people-view.js)・検索(search.js)・
      // 差分計算(computeStatusDiff)も同じ関数で揃えている。
      if (field === 'display_name' && !isDisplayNameVisible(status)) continue;
      renderField(fieldsWrap, {
        field,
        status,
        changed: changedFields.has(field),
        data,
        onSelectSource,
      });
    }
  }
  container.appendChild(fieldsWrap);

  // 当該年に有効な人物関係を、出典まで到達できる形で一覧表示する(相関図の詳細表示はT4担当。
  // ここではテキストとして確実に出典へ辿れる経路を用意する)。
  const related = relationsForPersonAtYear(data, personId, year);
  if (related.length > 0) {
    const relHeading = document.createElement('h4');
    relHeading.className = 'person-detail-subheading';
    relHeading.textContent = `${year}年時点の人物関係`;
    container.appendChild(relHeading);

    const ul = document.createElement('ul');
    ul.className = 'relation-list';
    for (const r of related) {
      const otherId = r.person_a_id === personId ? r.person_b_id : r.person_a_id;
      const other = findPerson(data, otherId);

      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'relation-list-person-button';
      btn.setAttribute('data-focus-key', `relation-person-${r.id}`);
      btn.textContent = other ? other.canonical_name : otherId;
      btn.addEventListener('click', () => onSelectPerson(otherId));

      const label = document.createElement('span');
      label.className = 'relation-list-label';
      label.textContent = ` — ${r.label}`;

      li.append(btn, label);
      renderSourceRefs(li, { sourceIds: r.source_ids, data, onSelectSource, keyPrefix: `relation-${r.id}` });
      ul.appendChild(li);
    }
    container.appendChild(ul);
  }

  // 関連事件(相互移動 = 事件→人物の復路)。events.json 側の person_ids が正典
  // (people 側にイベント参照は持たない)。結びついた事件が1件も無い人物では、
  // 見出しごと出さない(空の節を残すと未完成に見えるため)。
  const relatedEvents = eventsForPerson(data.events, personId);
  if (relatedEvents.length > 0) {
    const eventsHeading = document.createElement('h4');
    eventsHeading.className = 'person-detail-subheading';
    eventsHeading.textContent = '関連事件';
    container.appendChild(eventsHeading);

    const eventsUl = document.createElement('ul');
    eventsUl.className = 'relation-list';
    for (const event of relatedEvents) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'relation-list-person-button';
      btn.setAttribute('data-focus-key', `person-event-${personId}-${event.id}`);
      btn.setAttribute('aria-label', `事件 ${event.name} へ移動`);
      btn.textContent = event.name;
      btn.addEventListener('click', () => onSelectEvent(event.id));
      li.appendChild(btn);

      if (event.era_label) {
        const era = document.createElement('span');
        era.className = 'relation-list-label';
        era.textContent = ` (${event.era_label})`;
        li.appendChild(era);
      }

      renderSourceRefs(li, {
        sourceIds: event.source_ids,
        data,
        onSelectSource,
        keyPrefix: `person-event-${event.id}`,
      });
      eventsUl.appendChild(li);
    }
    container.appendChild(eventsUl);
  }
}
