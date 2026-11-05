// SPDX-License-Identifier: GPL-3.0-or-later
// Single-line symbol info under the toolbar (Studio: laSymbolName / laSymbolText). Everything is
// ellipsized instead of wrapped; the tooltip carries the full text. Domain set names link to the
// set symbols of the file (extension feature).
import { typeAsString } from '../model';
import { domainTargets } from '../nav';
import { el } from './dom';
import { hooks, S } from './state';

export class InfoLine {
  readonly el = el('div', 'infoline');

  update(): void {
    const e = this.el;
    e.textContent = '';
    const s = S.selected;
    if (!s) {
      e.title = '';
      return;
    }
    const type = typeAsString(s);
    const targets = domainTargets(s, S.symbols);
    const full = `${s.name}${s.dim ? `(${s.domain.join(',')})` : ''}, ${type}, ${s.dim} dimension${s.dim === 1 ? '' : 's'}, ${s.records.toLocaleString()} records${s.text ? ` - ${s.text}` : ''}`;
    e.title = full;
    e.append(el('b', 'nm', s.name), el('span', 'dim', `${type} · ${s.dim}-dim · ${s.records.toLocaleString()} records`));
    if (s.dim > 0) {
      const dom = el('span', 'domains');
      dom.append(el('span', 'dim', 'domain'));
      s.domain.forEach((d, i) => {
        const t = targets[i];
        if (t) {
          const a = el('button', 'dlink', d);
          a.type = 'button';
          a.title = `Go to set ${t.name} (Alt+Left returns)`;
          a.onclick = () => hooks.selectSymbol(t, true);
          dom.append(a);
        } else {
          const sp = el('span', 'dtxt', d);
          sp.title = d === '*' ? 'Relaxed domain (universe)' : `${d} is not a set in this file`;
          dom.append(sp);
        }
      });
      e.append(dom);
    }
    if (s.text) {
      const t = el('span', 'desc', s.text);
      t.title = s.text;
      e.append(t);
    }
  }
}
