// relation-graph.js — 人物相関図モジュール(仕様§4.6)。
// D4(相関図担当)が単独で所有するファイル。index.html / styles.css / その他 src/*.js には触れない。
// 配信JSは外部依存ゼロ: SVGは document.createElementNS で自前生成する(ライブラリ不使用)。
// 色だけで関係の種類・状態を区別しない(線種+ラベル文字+選択状態のaria属性を併用。仕様§7.2)。

import { announce } from './live-region.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 仕様§4.6「関係線の種類」の並びに対応する16種 → 日本語ラベル。 */
const RELATION_TYPE_LABELS = {
  master_servant: '主従',
  superior_subordinate: '上司・部下',
  appointment: '登用',
  colleague: '同僚',
  mentorship: '師弟',
  comrade: '同志',
  political_cooperation: '政治協力',
  military_cooperation: '軍事協力',
  alliance: '同盟',
  conflict: '対立',
  surveillance: '監視',
  mediation: '仲介',
  kinship: '親族',
  organization_membership: '所属組織',
  punishment: '処分・弾圧',
  temporary_cooperation: '一時的協力',
};

/** 線種の区別に使う2分類。対立性の高い関係は破線にする(色だけに頼らないための併用)。 */
const TENSE_RELATION_TYPES = new Set(['conflict', 'surveillance', 'punishment']);

/**
 * relation_type(snake_case) を日本語ラベルへ変換する。未知の値はそのまま返す(捏造しない)。
 * null/undefined は、二者間の関係の種類まで特定できる資料に到達していないことを示す正当な状態
 * (schema 上も null を許容。event-graph.js の eventRelationTypeLabel と同型)
 * なので、種類が無い関係では種類欄を空にする(推測で補わない)。
 */
export function relationTypeLabel(relationType) {
  if (relationType === null || relationType === undefined) return '';
  return RELATION_TYPE_LABELS[relationType] ?? String(relationType);
}

/**
 * 日付文字列(YYYY / YYYY-MM / YYYY-MM-DD)またはYYYY数値から年(number)を取り出す。
 * 解釈できなければ null を返す(推測で補わない)。
 */
function extractYear(value) {
  if (value === null || value === undefined || value === '') return null;
  const str = String(value);
  const m = str.match(/^(\d{4})/);
  if (!m) return null;
  return Number(m[1]);
}

/**
 * 当該年(asOfYear)に有効な関係だけを返す純関数。
 * start_date <= asOfYear <= end_date(end_date が null なら現在まで有効)を年単位で判定する。
 * @param {object[]} relations data/relations.json の配列
 * @param {string|number} asOfYear 例: "1867" または 1867
 * @returns {object[]}
 */
export function relationsAtTime(relations, asOfYear) {
  if (!Array.isArray(relations)) return [];
  const year = extractYear(asOfYear);
  if (year === null) return [];
  return relations.filter((relation) => {
    const startYear = extractYear(relation?.start_date);
    const endYear = relation?.end_date == null ? null : extractYear(relation.end_date);
    if (startYear !== null && year < startYear) return false;
    if (endYear !== null && year > endYear) return false;
    return true;
  });
}

/** 期間を「YYYY年〜YYYY年」のように整形する(終了日なしは「〜現在」)。 */
function formatPeriod(startDate, endDate) {
  const startYear = extractYear(startDate);
  const startLabel = startYear !== null ? `${startYear}年` : '不明';
  if (endDate === null || endDate === undefined) {
    return `${startLabel}〜(終了不明)`;
  }
  const endYear = extractYear(endDate);
  const endLabel = endYear !== null ? `${endYear}年` : '不明';
  return `${startLabel}〜${endLabel}`;
}

function personLabel(people, personId) {
  const person = people.find((p) => p.id === personId);
  return person ? person.canonical_name : personId;
}

/**
 * ラベル解決専用の人物リストを作る。people(=描画対象のノード集合。これは変えない)に加えて、
 * 任意で渡された extraPeopleForLabels(仲介者など、図には描かないが名前だけ解決したい人物)を合わせる。
 * 描画対象(ノード・線)は常に people のみを使う。ここで作るリストは personLabel の名前解決にのみ使う。
 */
function buildLabelPeople(people, extraPeopleForLabels) {
  if (!Array.isArray(extraPeopleForLabels) || extraPeopleForLabels.length === 0) return people;
  return [...people, ...extraPeopleForLabels];
}

/** ノード座標を計算する。centerId が people 内に見つかればその人物を中心に、見つからなければ全員を円周上に並べる。 */
function layoutNodes(people, centerId, { width, height }) {
  const cx = width / 2;
  const cy = height / 2;
  const positions = new Map();
  const centerIndex = people.findIndex((p) => p.id === centerId);

  if (centerIndex === -1) {
    const radius = Math.min(width, height) / 2 - 48;
    const n = Math.max(people.length, 1);
    people.forEach((p, i) => {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2;
      positions.set(p.id, {
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
        isCenter: false,
      });
    });
    return positions;
  }

  positions.set(people[centerIndex].id, { x: cx, y: cy, isCenter: true });
  const others = people.filter((p) => p.id !== centerId);
  const radius = Math.min(width, height) / 2 - 48;
  const n = Math.max(others.length, 1);
  others.forEach((p, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    positions.set(p.id, {
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
      isCenter: false,
    });
  });
  return positions;
}

/** 同じ二者間に複数の関係がある場合に線を分離するためのグルーピングキー。 */
function pairKey(aId, bId) {
  return [aId, bId].sort().join('::');
}

function createSvgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
  return el;
}

/**
 * 相関図(SVG)+ テキスト代替の表 + 選択中の関係の詳細を container に描画する。
 * 純関数ではない(DOMを書き換える)。renderRelationGraph 自体は node:test の対象外(DOM依存のため)。
 *
 * @param {HTMLElement} container 中身を空にして描画してよい
 * @param {{centerPersonId: string|null, asOf: string, people: {id: string, canonical_name: string}[],
 *          relations: object[], selectedRelationId: string|null,
 *          mediatorPeople?: {id: string, canonical_name: string}[]}} model
 *   mediatorPeople は任意(契約外の追加。渡されなくても従来どおり動く)。relation.mediator_person_ids が
 *   people(=描画対象のノード)に含まれない人物を指す場合に、名前解決だけに使う参照用リスト。
 *   ここに入れても図にノードや線は増えない(孤立ノードを作らないため)。
 * @param {{onSelectRelation: (relationId: string) => void, onSelectPerson: (personId: string) => void}} handlers
 */
export function renderRelationGraph(container, model, handlers) {
  if (!container) return;
  const {
    centerPersonId = null,
    asOf = '',
    people = [],
    relations = [],
    selectedRelationId = null,
    mediatorPeople = [],
  } = model || {};
  const onSelectRelation = typeof handlers?.onSelectRelation === 'function' ? handlers.onSelectRelation : () => {};
  const onSelectPerson = typeof handlers?.onSelectPerson === 'function' ? handlers.onSelectPerson : () => {};
  // 名前解決専用(描画対象のノード集合=peopleIds には影響させない。孤立ノードを増やさないため)。
  const labelPeople = buildLabelPeople(people, mediatorPeople);

  container.innerHTML = '';
  container.classList.add('relation-graph');

  const peopleIds = new Set(people.map((p) => p.id));
  // 図に描くのは両端の人物が model.people に含まれる関係のみ(表もこれと一致させ、視覚とテキスト代替を揃える)。
  const edgeRelations = relations.filter((r) => peopleIds.has(r.person_a_id) && peopleIds.has(r.person_b_id));

  if (people.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'relation-graph-empty';
    empty.textContent = `${asOf ? asOf + '年時点: ' : ''}相関図に表示できる人物がありません。`;
    container.appendChild(empty);
    return;
  }

  const width = 440;
  const height = 440;
  const positions = layoutNodes(people, centerPersonId, { width, height });

  const svg = createSvgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'relation-graph-svg',
    role: 'img',
    'aria-label': `${asOf ? asOf + '年時点の' : ''}人物相関図。${people.length}名、関係${edgeRelations.length}件。`,
  });

  // ---- 関係線(edge) ----
  const edgesLayer = createSvgEl('g', { class: 'relation-graph-edges' });
  const pairGroups = new Map();
  for (const relation of edgeRelations) {
    const key = pairKey(relation.person_a_id, relation.person_b_id);
    if (!pairGroups.has(key)) pairGroups.set(key, []);
    pairGroups.get(key).push(relation);
  }

  for (const group of pairGroups.values()) {
    group.forEach((relation, idx) => {
      const a = positions.get(relation.person_a_id);
      const b = positions.get(relation.person_b_id);
      if (!a || !b) return;

      const isSelected = relation.id === selectedRelationId;
      const isTense = TENSE_RELATION_TYPES.has(relation.relation_type);
      const offset = (idx - (group.length - 1) / 2) * 18;

      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      // 線分に垂直な方向へ制御点をずらし、同じ二者間の複数関係を視覚的に分離する。
      const nx = -dy / len;
      const ny = dx / len;
      const ctrlX = mx + nx * offset;
      const ctrlY = my + ny * offset;

      const edgeGroup = createSvgEl('g', {
        class: `relation-graph-edge${isSelected ? ' relation-graph-edge-selected' : ''}`,
        tabindex: '0',
        role: 'button',
        'aria-pressed': String(isSelected),
        'aria-label': `${personLabel(labelPeople, relation.person_a_id)}と${personLabel(labelPeople, relation.person_b_id)}の関係: ${relationTypeLabel(relation.relation_type)}(${formatPeriod(relation.start_date, relation.end_date)})。${relation.label || ''}`,
        'data-focus-key': `relation-edge-${relation.id}`,
      });

      const path = createSvgEl('path', {
        d: offset === 0 ? `M ${a.x} ${a.y} L ${b.x} ${b.y}` : `M ${a.x} ${a.y} Q ${ctrlX} ${ctrlY} ${b.x} ${b.y}`,
        class: `relation-graph-edge-line${isTense ? ' relation-graph-edge-line-tense' : ''}`,
        fill: 'none',
      });
      edgeGroup.appendChild(path);

      // 種類ラベル(色だけに頼らず、常に文字で関係の種類を示す)。
      const labelBg = createSvgEl('rect', {
        class: 'relation-graph-edge-label-bg',
        x: ctrlX - 22,
        y: ctrlY - 9,
        width: 44,
        height: 16,
        rx: 4,
      });
      const labelText = createSvgEl('text', {
        x: ctrlX,
        y: ctrlY + 3,
        class: 'relation-graph-edge-label',
        'text-anchor': 'middle',
      });
      labelText.textContent = relationTypeLabel(relation.relation_type);
      edgeGroup.append(labelBg, labelText);

      const activate = () => onSelectRelation(relation.id);
      edgeGroup.addEventListener('click', activate);
      edgeGroup.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      });

      edgesLayer.appendChild(edgeGroup);
    });
  }
  svg.appendChild(edgesLayer);

  // ---- 人物ノード ----
  const nodesLayer = createSvgEl('g', { class: 'relation-graph-nodes' });
  for (const person of people) {
    const pos = positions.get(person.id);
    if (!pos) continue;
    const r = pos.isCenter ? 34 : 28;

    const nodeGroup = createSvgEl('g', {
      class: `relation-graph-node${pos.isCenter ? ' relation-graph-node-center' : ''}`,
      tabindex: '0',
      role: 'button',
      'aria-label': `${person.canonical_name}${pos.isCenter ? '(中心人物)' : ''}を選択`,
      transform: `translate(${pos.x}, ${pos.y})`,
      'data-focus-key': `relation-node-${person.id}`,
    });

    const circle = createSvgEl('circle', { r, class: 'relation-graph-node-circle' });
    const text = createSvgEl('text', {
      class: 'relation-graph-node-label',
      'text-anchor': 'middle',
      y: 4,
    });
    text.textContent = person.canonical_name;

    nodeGroup.append(circle, text);

    const activate = () => onSelectPerson(person.id);
    nodeGroup.addEventListener('click', activate);
    nodeGroup.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });

    nodesLayer.appendChild(nodeGroup);
  }
  svg.appendChild(nodesLayer);

  container.appendChild(svg);

  // ---- テキスト代替の表(仕様§7.2。SVGの直後に置く) ----
  const table = document.createElement('table');
  table.className = 'relation-graph-table';

  const caption = document.createElement('caption');
  caption.className = 'rg-visually-hidden';
  caption.textContent = `相関図のテキスト代替(${asOf ? asOf + '年時点' : ''})`;
  table.appendChild(caption);

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['人物A', '関係', '人物B', '期間']) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (edgeRelations.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = 'この時点で表示できる関係はありません。';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    for (const relation of edgeRelations) {
      const tr = document.createElement('tr');
      tr.className = relation.id === selectedRelationId ? 'relation-graph-table-row-selected' : '';

      const tdA = document.createElement('td');
      tdA.textContent = personLabel(labelPeople, relation.person_a_id);

      const tdType = document.createElement('td');
      tdType.textContent = relationTypeLabel(relation.relation_type);

      const tdB = document.createElement('td');
      tdB.textContent = personLabel(labelPeople, relation.person_b_id);

      const tdPeriod = document.createElement('td');
      tdPeriod.textContent = formatPeriod(relation.start_date, relation.end_date);

      tr.append(tdA, tdType, tdB, tdPeriod);
      tbody.appendChild(tr);
    }
  }
  table.appendChild(tbody);
  container.appendChild(table);

  // ---- 選択中の関係の詳細(種類・期間・出典) ----
  const selectedRelation = edgeRelations.find((r) => r.id === selectedRelationId) || null;
  if (selectedRelation) {
    const detail = document.createElement('div');
    detail.className = 'relation-graph-detail';
    detail.setAttribute('role', 'region');
    // aria-live はこの要素自体には付けない(container.innerHTML='' で毎回作り直され読み上げられない
    // = 既知の不具合)。読み上げは常設の #a11y-live(live-region.js の announce())に一本化する。
    detail.setAttribute(
      'aria-label',
      `${personLabel(labelPeople, selectedRelation.person_a_id)}と${personLabel(labelPeople, selectedRelation.person_b_id)}の関係の詳細`,
    );

    const heading = document.createElement('p');
    heading.className = 'relation-graph-detail-heading';
    heading.textContent = `${personLabel(labelPeople, selectedRelation.person_a_id)} ⇄ ${personLabel(labelPeople, selectedRelation.person_b_id)}`;
    detail.appendChild(heading);

    const dl = document.createElement('dl');

    const addRow = (term, value) => {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      dl.append(dt, dd);
    };

    addRow('種類', relationTypeLabel(selectedRelation.relation_type));
    addRow('期間', formatPeriod(selectedRelation.start_date, selectedRelation.end_date));
    if (selectedRelation.label) addRow('概要', selectedRelation.label);
    if (selectedRelation.description) addRow('説明', selectedRelation.description);

    if (Array.isArray(selectedRelation.mediator_person_ids) && selectedRelation.mediator_person_ids.length > 0) {
      addRow('仲介者', selectedRelation.mediator_person_ids.map((id) => personLabel(labelPeople, id)).join('、'));
    }

    detail.appendChild(dl);

    // 出典が無い関係では見出しごと出さない。
    if (Array.isArray(selectedRelation.source_ids) && selectedRelation.source_ids.length > 0) {
      const sourcesHeading = document.createElement('p');
      sourcesHeading.className = 'relation-graph-detail-sources-heading';
      sourcesHeading.textContent = '出典';
      detail.appendChild(sourcesHeading);

      const sourceList = document.createElement('ul');
      sourceList.className = 'relation-graph-detail-sources';
      for (const sourceId of selectedRelation.source_ids) {
        // 出典は ID のままでは読者に意味が無いので、書誌情報(題名)へ解決してから出す。
        // 解決できない出典は出さない(内部の ID を画面に出さないため)。
        const source = (model?.sources || []).find((s) => s && s.id === sourceId) || null;
        if (!source) continue;
        const li = document.createElement('li');
        if (typeof handlers?.onSelectSource === 'function') {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'relation-graph-detail-source-button';
          button.setAttribute('data-focus-key', `relation-source-${selectedRelation.id}-${sourceId}`);
          button.textContent = source.title;
          button.setAttribute('aria-label', `出典「${source.title}」の書誌情報を表示`);
          button.addEventListener('click', () => handlers.onSelectSource(sourceId));
          li.appendChild(button);
        } else {
          li.textContent = source.title;
        }
        if (source.publisher) {
          const pub = document.createElement('span');
          pub.className = 'relation-graph-detail-source-publisher';
          pub.textContent = ` — ${source.publisher}`;
          li.appendChild(pub);
        }
        sourceList.appendChild(li);
      }
      detail.appendChild(sourceList);
    }

    container.appendChild(detail);
    announce(
      `${personLabel(labelPeople, selectedRelation.person_a_id)}と${personLabel(labelPeople, selectedRelation.person_b_id)}の関係: ${relationTypeLabel(selectedRelation.relation_type)}(${formatPeriod(selectedRelation.start_date, selectedRelation.end_date)})`,
    );
  }
}
