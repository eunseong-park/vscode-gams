// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { GAMS_LANGS, gamsSelector, isGamsFile, isGamsLang, isGamsSource } from '../../src/languages';

const ROOT = path.join(__dirname, '../../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
type Lang = { id: string; aliases?: string[]; extensions?: string[]; configuration?: string; icon?: { light: string; dark: string } };
const langs = pkg.contributes.languages as Lang[];
const lang = (id: string): Lang => {
  const l = langs.find((x) => x.id === id);
  assert.ok(l, id);
  return l!;
};

/** Every `when` clause of package.json (keybindings and menus) with the command it belongs to. */
function whenClauses(): Array<{ command: string; when: string }> {
  const out: Array<{ command: string; when: string }> = [];
  for (const k of pkg.contributes.keybindings) if (k.when) out.push({ command: k.command, when: k.when });
  for (const items of Object.values(pkg.contributes.menus) as Array<Array<{ command: string; when?: string }>>) {
    for (const m of items) if (m.when) out.push({ command: m.command, when: m.when });
  }
  return out;
}

/** The regular expressions of `editorLangId =~ /.../` / `resourceLangId =~ /.../` in a when clause. */
function langRegexes(when: string): RegExp[] {
  return [...when.matchAll(/(?:editor|resource)LangId =~ \/((?:[^/\\]|\\.)+)\/(\w*)/g)].map((m) => new RegExp(m[1], m[2]));
}

describe('GAMS language ids', () => {
  it('helpers accept gams and gams-inc only', () => {
    assert.deepStrictEqual([...GAMS_LANGS], ['gams', 'gams-inc']);
    for (const id of ['gams', 'gams-inc']) assert.ok(isGamsLang(id), id);
    for (const id of ['gams-opt', 'gams-lst', 'gams-gdx', 'gams-ref', 'gams-lxi', 'gams-gsp', 'plaintext', undefined]) assert.ok(!isGamsLang(id), String(id));
    assert.ok(isGamsSource({ languageId: 'gams-inc' }));
    assert.ok(!isGamsSource(undefined));
    assert.ok(isGamsFile({ languageId: 'gams-inc', uri: { scheme: 'file' } }));
    assert.ok(!isGamsFile({ languageId: 'gams-inc', uri: { scheme: 'untitled' } }));
    assert.deepStrictEqual(gamsSelector('file'), [{ scheme: 'file', language: 'gams' }, { scheme: 'file', language: 'gams-inc' }]);
  });

  it('registers every file type with its extensions and own icon', () => {
    const want: Array<[string, string[], string]> = [
      ['gams', ['.gms', '.dmp'], 'gms'],
      ['gams-inc', ['.inc'], 'inc'],
      ['gams-lst', ['.lst'], 'lst'],
      ['gams-gdx', ['.gdx'], 'gdx'],
      ['gams-ref', ['.ref'], 'ref'],
      ['gams-lxi', ['.lxi'], 'lxi'],
      ['gams-gsp', ['.gsp'], 'gsp'],
    ];
    for (const [id, exts, icon] of want) {
      const l = lang(id);
      assert.deepStrictEqual(l.extensions, exts, id);
      assert.deepStrictEqual(l.icon, { light: `./images/icons/${icon}.svg`, dark: `./images/icons/${icon}.svg` }, id);
    }
    assert.ok(lang('gams-opt').extensions!.includes('.opt'));
    assert.strictEqual(lang('gams-opt').icon!.light, './images/icons/opt.svg');
    // no extension is claimed by two languages
    const all = langs.flatMap((l) => l.extensions ?? []);
    assert.strictEqual(new Set(all).size, all.length, all.join(' '));
    for (const l of langs) if (l.icon) for (const f of [l.icon.light, l.icon.dark]) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
    assert.strictEqual(pkg.icon, 'images/icon.png');
    assert.ok(fs.existsSync(path.join(ROOT, pkg.icon)));
    for (const old of ['images/letter-g.png', 'images/letter-gams.png']) assert.ok(!fs.existsSync(path.join(ROOT, old)), old);
  });

  it('gams-inc gets the same contributions as gams', () => {
    assert.strictEqual(lang('gams-inc').configuration, lang('gams').configuration);
    const c = pkg.contributes;
    const grammar = (id: string) => c.grammars.find((g: { language: string }) => g.language === id);
    assert.deepStrictEqual({ ...grammar('gams-inc'), language: 'gams' }, grammar('gams'));
    const sem = (id: string) => c.semanticTokenScopes.find((s: { language: string }) => s.language === id)?.scopes;
    assert.deepStrictEqual(sem('gams-inc'), sem('gams'));
    assert.deepStrictEqual(c.configurationDefaults['[gams-inc]'], c.configurationDefaults['[gams]']);
    assert.ok(c.breakpoints.some((b: { language: string }) => b.language === 'gams-inc'));
    assert.ok(c.debuggers.find((d: { type: string }) => d.type === 'gams').languages.includes('gams-inc'));
    for (const id of GAMS_LANGS) assert.ok(pkg.activationEvents.includes(`onLanguage:${id}`), id);
  });

  it('when clauses treat gams-inc like gams', () => {
    const clauses = whenClauses();
    for (const { command, when } of clauses) {
      assert.ok(!/LangId == gams\b/.test(when), `${command}: ${when}`);
      for (const re of langRegexes(when)) {
        if (re.test('gams')) assert.ok(re.test('gams-inc'), `${command}: ${when}`);
        // icon-only languages get no GAMS source commands
        for (const id of ['gams-gdx', 'gams-ref', 'gams-lxi', 'gams-gsp']) assert.ok(!re.test(id), `${command} for ${id}: ${when}`);
      }
    }
    const runKeys = clauses.filter((c) => c.command === 'gams.run');
    assert.ok(runKeys.length >= 3);
    for (const c of runKeys) assert.ok(langRegexes(c.when).some((re) => re.test('gams-inc')), c.when);
  });
});
