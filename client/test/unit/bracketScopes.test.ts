// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// The nesting colors come from the language server (bracketColors.ts); VS Code's own colorizer is off for [gams].
// These scopes still matter for other VS Code bracket features (e.g. bracket matching in other tools) that skip comment/string tokens.
describe('TextMate grammar: brackets ignored by the colorizer', () => {
  const g = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../syntaxes/gams.tmLanguage.json'), 'utf8')) as { repository: Record<string, { name?: string; patterns?: Array<{ name?: string }> }> };
  it('comment rules use comment.* scopes', () => {
    for (const k of ['comment-line', 'comment-block', 'eol-comment']) assert.ok(g.repository[k].name?.startsWith('comment.'), k);
  });
  it('string rules use string.* scopes', () => {
    for (const p of g.repository['strings'].patterns!) assert.ok(p.name?.startsWith('string.'), String(p.name));
  });
});
