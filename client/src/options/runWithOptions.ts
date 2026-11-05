// SPDX-License-Identifier: GPL-3.0-or-later
import * as vscode from 'vscode';
import { complete, normalize, OptionIndex, tokenize, validate } from './commandLine';
import { getOptionIndex } from './optionDefs';
import { flagsFromBits, flagsToBits, withRunFlags } from './runFlags';

const FLAGS_KEY = 'gams.runFlags';

const HISTORY_KEY = 'gams.parameterHistory';
const MAX_HISTORY = 20;

interface Item extends vscode.QuickPickItem {
  action: 'run' | 'complete' | 'history' | 'toggle';
  flag?: 'gdx' | 'ref' | 'profile';
  insert?: { start: number; end: number; text: string };
  text?: string;
}

/**
 * "Run with ..." (Studio actionRunWithSelected, F10): ask for GAMS command line parameters in a
 * QuickPick with completion from optgams.def (names, synonyms, enum values) and validation
 * (OptionTokenizer::format). Resolves to the parameters (`key=value` list) or undefined when cancelled.
 */
export async function promptParameters(state: vscode.Memento, title: string): Promise<string[] | undefined> {
  const compile = /compile/i.test(title);
  // GDX / reference / profiling flags are toggle entries of the same QuickPick (remembered); Enter runs at once
  const flags = flagsFromBits(state.get<number>(FLAGS_KEY, 0));
  const runSel = { gdx: flags.gdx, ref: flags.ref, profile: compile ? false : flags.profile };
  const index: OptionIndex | undefined = await getOptionIndex('optgams.def');
  const history = state.get<string[]>(HISTORY_KEY, []);
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = title;
  qp.placeholder = 'GAMS parameters, e.g. lo=3 reslim=60 --myflag=1 (Enter runs, pick a suggestion to complete or a flag to toggle)';
  qp.matchOnDescription = false;
  qp.matchOnDetail = false;
  qp.value = history[0] ?? '';
  if (!index) qp.title = `${title} (option definitions unavailable: no validation or completion)`;

  const refresh = () => {
    const text = qp.value;
    const items: Item[] = [];
    const issues = index ? validate(tokenize(text), index) : [];
    const errors = issues.filter((i) => i.severity === 'error');
    const first: Item = {
      action: 'run',
      label: `$(play) Run${text.trim() ? ` with: ${text.trim()}` : ''}`,
      detail: issues.length ? issues.map((i) => i.message).join('  |  ') : undefined,
      description: errors.length ? `${errors.length} problem(s)` : undefined,
      alwaysShow: true,
    };
    items.push(first);
    const toggles: [('gdx' | 'ref' | 'profile'), string][] = [
      ['gdx', 'Create GDX (GDX=default)'],
      ['ref', 'Create reference file (RF=default)'],
      ...(compile ? [] : [['profile', 'Profiling (Profile=300)'] as ['profile', string]]),
    ];
    for (const [flag, label] of toggles) {
      items.push({
        action: 'toggle',
        flag,
        label: `$(${runSel[flag] ? 'check' : 'circle-large-outline'}) ${label}`,
        description: 'select to toggle',
        alwaysShow: true,
      });
    }
    if (index) {
      const comps = complete(text, index).slice(0, 60);
      for (const c of comps) {
        items.push({
          action: 'complete',
          label: c.label,
          description: c.detail,
          detail: c.documentation.split('\n')[0],
          iconPath: new vscode.ThemeIcon(c.deprecated ? 'warning' : 'symbol-property'),
          alwaysShow: true,
          insert: { start: c.start, end: c.end, text: c.insert },
        });
      }
    }
    if (text.trim() === '') {
      for (const h of history) items.push({ action: 'history', label: h, description: 'history', alwaysShow: true, text: h });
    }
    qp.items = items;
    qp.activeItems = [first];
  };
  qp.onDidChangeValue(refresh);
  refresh();

  return new Promise<string[] | undefined>((resolve) => {
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0] ?? qp.activeItems[0];
      if (sel?.action === 'toggle' && sel.flag) {
        runSel[sel.flag] = !runSel[sel.flag];
        refresh();
        return;
      }
      if (sel?.action === 'complete' && sel.insert) {
        const v = qp.value;
        qp.value = v.substring(0, sel.insert.start) + sel.insert.text + v.substring(sel.insert.end);
        return; // onDidChangeValue refreshes the suggestions
      }
      if (sel?.action === 'history' && sel.text !== undefined) {
        qp.value = sel.text;
        return;
      }
      const text = qp.value.trim();
      const params = normalize(tokenize(text));
      if (text) {
        void state.update(HISTORY_KEY, [text, ...history.filter((h) => h !== text)].slice(0, MAX_HISTORY));
      }
      void state.update(FLAGS_KEY, flagsToBits(compile ? { ...runSel, profile: flags.profile } : runSel));
      resolve(withRunFlags(params, runSel, compile));
      qp.dispose();
    });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
}
