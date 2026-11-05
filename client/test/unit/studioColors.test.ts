// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { mergeSemantic, mergeTextMate, resolveTheme, semanticRules, SLOT_SCOPES, textMateRules } from '../../src/theme/studioColors';
import { SLOT_TOKEN_TYPES, STUDIO_THEMES } from '../../src/theme/studioThemes';

const dark = resolveTheme('dark', true)!;
const light = resolveTheme('light', false)!;
const OURS = Object.values(SLOT_TOKEN_TYPES);

describe('studio themes table', () => {
  it('matches Studio values (spot checks from theme.cpp)', () => {
    const t = (id: string) => STUDIO_THEMES.find((x) => x.id === id)!;
    assert.deepStrictEqual(STUDIO_THEMES.map((x) => [x.id, x.dark]), [['light', false], ['dark', true], ['distinct-light', false], ['dracula-dark', true], ['solarized-light', false], ['solarized-dark', true]]);
    assert.deepStrictEqual(t('dark').slots.comment, { foreground: '#7d7d7d', bold: false, italic: true });
    assert.strictEqual(t('dark').slots.embedded.foreground, '#c84600'); // inherited from Light
    assert.strictEqual(t('dark').slots.keyword.foreground, '#f39619');
    assert.strictEqual(t('light').slots.keyword.foreground, '#0000b3'); // darkBlue.lighter(140)
    assert.strictEqual(t('light').slots.description.foreground, '#0000da'); // darkBlue.lighter(170)
    assert.deepStrictEqual(t('solarized-dark').slots, t('solarized-light').slots);
  });
  it('MPSGE token types (extension) copy the declaration / keyword slots of every theme', () => {
    for (const t of STUDIO_THEMES) {
      assert.deepStrictEqual(t.slots.mpsgeSection, t.slots.declaration, t.id);
      assert.deepStrictEqual(t.slots.mpsgeField, t.slots.keyword, t.id);
    }
    assert.strictEqual(SLOT_TOKEN_TYPES.mpsgeSection, 'gamsMpsgeSection');
    assert.strictEqual(SLOT_TOKEN_TYPES.mpsgeField, 'gamsMpsgeField');
  });
  it('scopes agree with package.json semanticTokenScopes', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'));
    const scopes = pkg.contributes.semanticTokenScopes[0].scopes as Record<string, string[]>;
    for (const [slot, type] of Object.entries(SLOT_TOKEN_TYPES)) assert.deepStrictEqual(scopes[type], SLOT_SCOPES[slot as keyof typeof SLOT_SCOPES]);
    const types = pkg.contributes.semanticTokenTypes.map((x: { id: string }) => x.id).sort();
    assert.deepStrictEqual([...OURS].sort(), types);
  });
  it('scopes are those of the TextMate grammar (Studio colors apply before the server starts)', () => {
    const grammar = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../syntaxes/gams.tmLanguage.json'), 'utf8'));
    const names = new Set<string>();
    const walk = (j: unknown): void => {
      if (Array.isArray(j)) j.forEach(walk);
      else if (j && typeof j === 'object') for (const [k, v] of Object.entries(j)) (k === 'name' || k === 'contentName') && typeof v === 'string' ? names.add(v) : walk(v);
    };
    walk(grammar);
    const all = Object.values(SLOT_SCOPES).flat();
    // fallback scopes for ordinary themes that the grammar does not produce
    const fallback = ['support.function.embedded.gams', 'comment.block.documentation.gams', 'variable.other.enummember.table-header.gams'];
    for (const s of all) if (!fallback.includes(s)) assert.ok(names.has(s), s);
    // every comment scope of the grammar gets a Studio color
    for (const n of names) if (n.startsWith('comment.')) assert.ok(all.includes(n), n);
    assert.ok(SLOT_SCOPES.comment.includes('comment.line.asterisk.gams') && SLOT_SCOPES.comment.includes('comment.block.gams'));
  });
});

describe('resolveTheme', () => {
  it('off / auto / id', () => {
    assert.strictEqual(resolveTheme('off', true), undefined);
    assert.strictEqual(resolveTheme('auto', true)!.id, 'light');
    assert.strictEqual(resolveTheme('auto', false)!.id, 'dark');
    assert.strictEqual(resolveTheme('dracula-dark', true)!.id, 'dracula-dark');
    assert.strictEqual(resolveTheme('bogus', true), undefined);
  });
});

describe('mergeSemantic', () => {
  const user = { enabled: true, rules: { comment: { foreground: '#111111' } }, '[Monokai]': { rules: { gamsComment: '#222222' } } };
  it('adds only gams rules and preserves everything else', () => {
    const r = mergeSemantic(user, dark);
    assert.ok(r.changed);
    const v = r.value as typeof user & { rules: Record<string, unknown> };
    assert.deepStrictEqual(v['[Monokai]'], user['[Monokai]']);
    assert.strictEqual(v.enabled, true);
    assert.deepStrictEqual(v.rules['comment'], { foreground: '#111111' });
    assert.deepStrictEqual(Object.keys(v.rules).filter((k) => k.startsWith('gams')).sort(), [...OURS].sort());
    assert.deepStrictEqual(v.rules['gamsComment'], semanticRules(dark)['gamsComment']);
    assert.deepStrictEqual(user.rules, { comment: { foreground: '#111111' } }); // input not mutated
  });
  it('is idempotent', () => {
    const once = mergeSemantic(user, dark).value;
    assert.strictEqual(mergeSemantic(once, dark).changed, false);
    assert.strictEqual(mergeSemantic(once, light).changed, true);
  });
  it('creates the object from undefined', () => {
    assert.ok(mergeSemantic(undefined, light).changed);
  });
  it('off removes only our keys', () => {
    const on = mergeSemantic(user, dark).value;
    const off = mergeSemantic(on, undefined);
    assert.ok(off.changed);
    assert.deepStrictEqual(off.value, user);
  });
  it('off leaves untouched when nothing of ours exists', () => {
    assert.strictEqual(mergeSemantic(user, undefined).changed, false);
    assert.strictEqual(mergeSemantic(undefined, undefined).changed, false);
    assert.strictEqual(mergeSemantic({}, undefined).changed, false);
  });
  it('off removes the whole setting when only ours was there', () => {
    const on = mergeSemantic(undefined, dark).value;
    const off = mergeSemantic(on, undefined);
    assert.ok(off.changed);
    assert.strictEqual(off.value, undefined);
  });
  it('keeps user-customized non-gams rules when theme-scoped gams keys exist only in blocks', () => {
    const v = { '[X]': { rules: { gamsComment: '#fff' } } };
    assert.strictEqual(mergeSemantic(v, undefined).changed, false);
  });
});

describe('mergeTextMate', () => {
  const user = { comments: '#999', textMateRules: [{ scope: 'comment', settings: { foreground: '#123456' } }] };
  it('appends our rules, preserves user rules, idempotent', () => {
    const r = mergeTextMate(user, dark);
    assert.ok(r.changed);
    const v = r.value as { comments: string; textMateRules: { scope: string }[] };
    assert.strictEqual(v.comments, '#999');
    assert.deepStrictEqual(v.textMateRules[0], user.textMateRules[0]);
    assert.strictEqual(v.textMateRules.length, 1 + textMateRules(dark).length);
    assert.strictEqual(mergeTextMate(v, dark).changed, false);
  });
  it('switching theme replaces ours only', () => {
    const a = mergeTextMate(user, dark).value;
    const b = mergeTextMate(a, light).value as { textMateRules: unknown[] };
    assert.strictEqual(b.textMateRules.length, 1 + OURS.length);
  });
  it('off removes only ours / no-op when none', () => {
    const on = mergeTextMate(user, dark).value;
    assert.deepStrictEqual(mergeTextMate(on, undefined).value, user);
    assert.strictEqual(mergeTextMate(user, undefined).changed, false);
    assert.strictEqual(mergeTextMate(mergeTextMate(undefined, dark).value, undefined).value, undefined);
  });
  it('font style', () => {
    const r = textMateRules(dark).find((x) => x.scope.includes('keyword.other.reserved.gams'))!;
    assert.deepStrictEqual(r.settings, { foreground: '#f39619', fontStyle: 'bold' });
  });
});
