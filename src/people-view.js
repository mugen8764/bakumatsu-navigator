// people-view.js — 人物一覧(仕様§4.3)。カード形式で選択時点の状態を要約表示する。

import { findStatus, isDisplayNameVisible, personStatusGapReason } from './state.js';

/**
 * @param {HTMLElement} container
 * @param {{data: object, year: string, selectedPersonId: string|null, onSelect: (personId:string)=>void}} params
 */
export function renderPeopleList(container, { data, year, selectedPersonId, onSelect }) {
  container.innerHTML = '';

  const heading = document.createElement('h2');
  heading.className = 'section-heading';
  heading.textContent = '人物一覧';
  container.appendChild(heading);

  const ul = document.createElement('ul');
  ul.className = 'people-list';

  for (const person of data.people) {
    const status = findStatus(data, person.id, year);
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'person-card';
    btn.setAttribute('data-focus-key', `person-card-${person.id}`);
    if (person.id === selectedPersonId) {
      btn.classList.add('person-card--selected');
      btn.setAttribute('aria-current', 'true');
    }

    const name = document.createElement('span');
    name.className = 'person-card-name';
    name.textContent = person.canonical_name;
    btn.appendChild(name);

    if (!status) {
      // 生前・死後で状態がそもそも無い場合だけ、その事実を一言添える
      // (state.js の personStatusGapReason が正典)。
      // それ以外(この時点の状態が登録されていないだけ)は注記を出さず、名前だけを並べる。
      const gap = personStatusGapReason(person, year);
      if (gap.kind === 'not-yet-born' || gap.kind === 'after-death') {
        const notice = document.createElement('span');
        notice.className = 'person-card-notice person-card-notice--not-yet';
        notice.textContent =
          gap.kind === 'not-yet-born'
            ? `${year}年時点はまだ生まれていません`
            : `${year}年時点は既に没しています`;
        btn.appendChild(notice);
      }
    } else {
      if (isDisplayNameVisible(status)) {
        const dn = document.createElement('span');
        dn.className = 'person-card-displayname';
        dn.textContent = `(${year}年: ${status.display_name})`;
        btn.appendChild(dn);
      }
      // 所属・役職・活動が1つも無い時点では、副題そのものを出さない(名前だけを並べる)。
      const parts = [status.affiliation_text, status.role || status.activity_description].filter(Boolean);
      if (parts.length > 0) {
        const meta = document.createElement('span');
        meta.className = 'person-card-meta';
        meta.textContent = parts.join(' / ');
        btn.appendChild(meta);
      }
    }

    btn.addEventListener('click', () => onSelect(person.id));
    li.appendChild(btn);
    ul.appendChild(li);
  }

  container.appendChild(ul);
}
