// search.js — 人物検索(仕様§4.2)。aliases.json を使い、通称・幼名・変名・号からも本人に到達できる。
// 例: 「桂小五郎」で検索して木戸孝允に到達できる。

import { findStatus, isDisplayNameVisible } from './state.js';
import { announce } from './live-region.js';

/** 検索対象のインデックスを構築する(canonical_name / reading / aliases.json の alias / reading)。 */
export function buildSearchIndex(data) {
  const index = [];
  for (const person of data.people) {
    index.push({ personId: person.id, text: person.canonical_name, matchType: 'canonical_name' });
    if (person.reading) {
      index.push({ personId: person.id, text: person.reading, matchType: 'reading' });
    }
  }
  for (const alias of data.aliases) {
    index.push({ personId: alias.person_id, text: alias.alias, matchType: 'alias', aliasType: alias.alias_type });
    if (alias.reading) {
      index.push({ personId: alias.person_id, text: alias.reading, matchType: 'alias_reading', aliasType: alias.alias_type });
    }
  }
  return index;
}

/** 部分一致(includes)で検索し、人物ごとに一致したインデックスエントリをまとめて返す。 */
export function searchPeople(query, index, data) {
  const q = (query || '').trim();
  if (!q) return [];
  const matches = new Map();
  for (const entry of index) {
    if (entry.text && entry.text.includes(q)) {
      if (!matches.has(entry.personId)) {
        const person = data.people.find((p) => p.id === entry.personId);
        if (!person) continue;
        matches.set(entry.personId, { person, matchedOn: [] });
      }
      matches.get(entry.personId).matchedOn.push(entry);
    }
  }
  return [...matches.values()];
}

/**
 * @param {HTMLElement} container
 * @param {{data: object, index: object[], query: string, year: string, onQueryChange: (q:string)=>void, onSelect: (personId:string)=>void}} params
 */
export function renderSearch(container, { data, index, query, year, onQueryChange, onSelect }) {
  container.innerHTML = '';

  const heading = document.createElement('h2');
  heading.className = 'section-heading';
  heading.textContent = '人物検索';
  container.appendChild(heading);

  const form = document.createElement('form');
  form.className = 'search-form';
  form.setAttribute('role', 'search');
  form.addEventListener('submit', (e) => e.preventDefault());

  const label = document.createElement('label');
  label.setAttribute('for', 'person-search-input');
  label.className = 'search-label';
  label.textContent = '本名・通称・幼名・変名・号などで検索';

  const input = document.createElement('input');
  input.type = 'search';
  input.id = 'person-search-input';
  input.setAttribute('data-focus-key', 'person-search-input');
  input.value = query || '';
  input.placeholder = '例: 桂小五郎';
  input.autocomplete = 'off';
  input.addEventListener('input', () => onQueryChange(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const results = searchPeople(input.value, index, data);
      if (results.length > 0) onSelect(results[0].person.id);
    }
  });

  form.append(label, input);
  container.appendChild(form);

  const resultsRegion = document.createElement('div');
  resultsRegion.className = 'search-results';
  // aria-live はこのコンテナ自体には付けない(container.innerHTML='' で毎回作り直されるため読み上げられない)。
  // 読み上げは常設の #a11y-live(live-region.js の announce())に一本化する。

  const q = (query || '').trim();
  if (q) {
    const results = searchPeople(q, index, data);
    if (results.length === 0) {
      const p = document.createElement('p');
      p.className = 'search-empty';
      p.textContent = `「${q}」に一致する人物は見つかりませんでした。`;
      resultsRegion.appendChild(p);
      announce(p.textContent);
    } else {
      const summary = document.createElement('p');
      summary.className = 'search-summary';
      summary.textContent = `${results.length}件一致`;
      resultsRegion.appendChild(summary);
      announce(summary.textContent);

      const ul = document.createElement('ul');
      ul.className = 'search-result-list';
      for (const { person, matchedOn } of results) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'search-result-button';
        btn.setAttribute('data-focus-key', `search-result-${person.id}`);

        const status = findStatus(data, person.id, year);
        const currentName = status && isDisplayNameVisible(status) ? status.display_name : null;
        const aliasMatch = matchedOn.find((m) => m.matchType !== 'canonical_name');

        let text = person.canonical_name;
        if (currentName && currentName !== person.canonical_name) {
          text += `(${year}年時点: ${currentName})`;
        }
        if (aliasMatch) {
          text += ` — 検索一致: ${aliasMatch.text}`;
        }
        btn.textContent = text;
        btn.addEventListener('click', () => onSelect(person.id));
        li.appendChild(btn);
        ul.appendChild(li);
      }
      resultsRegion.appendChild(ul);
    }
  } else {
    // 検索語が空(未入力・クリア後)。前回の「n件一致」等の通知を常設領域に残さない。
    announce('');
  }
  container.appendChild(resultsRegion);
}
