#!/usr/bin/env node
// Generates client/src/theme/studioThemes.ts from the values in GAMS Studio's src/theme.cpp
// (Theme::initDefault). Usage: node scripts/gen-studio-themes.js > client/src/theme/studioThemes.ts
// Implements Qt 6 QColor::lighter/darker (HSV value scaling; lighter spills overflow into saturation).
'use strict';

function toHsv([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h /= 6; if (h < 0) h += 1;
  }
  return [h, mx === 0 ? 0 : d / mx, mx];
}
function fromHsv([h, s, v]) {
  const i = Math.floor(h * 6) % 6, f = h * 6 - Math.floor(h * 6);
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
  return [r, g, b].map((x) => Math.round(x * 255));
}
// QColor::lighter(factor): v *= factor/100; if v > 1 then s -= v-1 (>= 0), v = 1.
const lighter = (c, f = 150) => {
  let [h, s, v] = toHsv(c); v *= f / 100;
  if (v > 1) { s = Math.max(0, s - (v - 1)); v = 1; }
  return fromHsv([h, s, v]);
};
// QColor::darker(factor): v = v*100/factor.
const darker = (c, f = 200) => { const [h, s, v] = toHsv(c); return fromHsv([h, s, v * 100 / f]); };
const hex = (c) => '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('');

// Qt::GlobalColor
const darkBlue = [0, 0, 128], darkMagenta = [128, 0, 128], darkGreen = [0, 128, 0];
// Constants from theme.cpp
const gams_orange = [243, 150, 25];
const dark_unobstrusive = [125, 125, 125], dark_id = [153, 240, 255], dark_assignment = [144, 226, 149];
const distinct = { orange: [230, 159, 0], bluishgreen: [0, 158, 115], blue: [0, 114, 178], red: [213, 94, 0], purple: [204, 121, 167], gray: [65, 74, 84] };
const drac = { comment: [98, 114, 164], cyan: [139, 233, 253], green: [80, 250, 123], orange: [255, 184, 108], pink: [255, 121, 198], purple: [189, 147, 249], red: [255, 85, 85], yellow: [241, 250, 140], foreground: [248, 248, 242] };
const sol = { base00: [101, 123, 131], yellow: [181, 137, 0], orange: [203, 75, 22], red: [220, 50, 47], magenta: [211, 54, 130], violet: [108, 113, 196], blue: [38, 139, 210], cyan: [42, 161, 152], green: [133, 153, 0] };

const N = '', B = 'b', I = 'i';
const S = (c, f = N) => ({ c, f });
const STUDIO_SLOTS = ['dco', 'dcoBody', 'comment', 'title', 'embedded', 'assignLabel', 'assignValue', 'keyword', 'declaration', 'identifier', 'description', 'tableHeader'];
// EXTENSION (MPSGE blocks, not in Studio): no slot of their own, they copy the style of a Studio slot.
// MPSGE section keywords ($PROD:, ...) look like Studio's declaration keywords, field labels (Q:, I:, ...) like its keywords.
const MPSGE_SLOTS = { mpsgeSection: 'declaration', mpsgeField: 'keyword' };
const SLOTS = [...STUDIO_SLOTS, ...Object.keys(MPSGE_SLOTS)];


const light = {
  dco: S(darker(darkMagenta, 120)), dcoBody: S(lighter(darkBlue, 170), I), comment: S([120, 120, 120], I),
  title: S(lighter(darkBlue, 140), B), keyword: S(lighter(darkBlue, 140), B), declaration: S(lighter(darkBlue, 140), B),
  identifier: S([0, 0, 0]), description: S(lighter(darkBlue, 170)), assignLabel: S(darker(darkGreen, 110)),
  assignValue: S([0, 80, 120]), tableHeader: S(darker(darkGreen, 140), B), embedded: S([200, 70, 0]),
};
// "Dark" copies Light, then overrides (embedded is NOT overridden => Light's; Syntax_assignValue is inserted twice,
// the last insert dark_assignment.lighter() wins).
const dark = { ...light,
  title: S(gams_orange, B), dco: S([200, 60, 90]), dcoBody: S(gams_orange, I), comment: S(dark_unobstrusive, I),
  keyword: S(gams_orange, B), declaration: S(gams_orange, B), identifier: S(dark_id), description: S(dark_unobstrusive),
  assignLabel: S(dark_assignment), assignValue: S(lighter(dark_assignment)), tableHeader: S(dark_assignment, B),
};
const distinctLight = {
  dco: S(distinct.red, B), dcoBody: S(distinct.blue, I), comment: S(distinct.gray, I), title: S(distinct.blue, B),
  keyword: S(distinct.red, B), declaration: S(distinct.red, B), identifier: S(distinct.blue), description: S(distinct.gray),
  assignLabel: S(distinct.bluishgreen), assignValue: S(distinct.purple), tableHeader: S(distinct.bluishgreen, B), embedded: S(distinct.orange),
};
const dracula = {
  dco: S(drac.red), dcoBody: S(drac.yellow, I), comment: S(drac.comment, I), title: S(drac.yellow, B), keyword: S(drac.pink, B),
  declaration: S(drac.cyan, B), identifier: S(drac.foreground), description: S(drac.comment), assignLabel: S(drac.purple),
  assignValue: S(lighter(drac.purple)), tableHeader: S(drac.green), embedded: S(drac.orange),
};
const solarizedLight = {
  dco: S(sol.red, B), dcoBody: S(sol.violet, I), comment: S(sol.base00, I), title: S(sol.yellow, B), keyword: S(sol.violet, B),
  declaration: S(sol.magenta, B), identifier: S(sol.green), description: S(sol.blue), assignLabel: S(sol.yellow),
  assignValue: S(sol.cyan), tableHeader: S(sol.yellow), embedded: S(sol.orange),
};
// "Solarized - dark" copies the Solarized light theme and sets no Syntax_* colors of its own.
const solarizedDark = { ...solarizedLight };

for (const t of [light, dark, distinctLight, dracula, solarizedLight, solarizedDark]) for (const [k, from] of Object.entries(MPSGE_SLOTS)) t[k] = t[from];

const THEMES = [
  ['light', 'Light', false, light], ['dark', 'Dark', true, dark], ['distinct-light', 'Distinct - light', false, distinctLight],
  ['dracula-dark', 'Dracula - dark', true, dracula], ['solarized-light', 'Solarized - light', false, solarizedLight],
  ['solarized-dark', 'Solarized - dark', true, solarizedDark],
];

let o = `// GENERATED by scripts/gen-studio-themes.js - do not edit by hand.
// Source: GAMS Studio src/theme.cpp, Theme::initDefault() (GPL-3.0; https://github.com/GAMS-dev/studio).
// Per theme: the Syntax_* foreground colour and font flag (fBold/fItalic) of the slots that the language server
// emits as semantic token types (see docs/dev/sources.md). Qt colour math (QColor::lighter/darker on
// Qt::GlobalColor values) is precomputed. Replicated Studio quirks: "Dark" and "Distinct - light" copy "Light",
// "Dracula - dark" copies "Dark", "Solarized - dark" copies "Solarized - light" and sets no Syntax_* colours itself;
// "Dark" does not override Syntax_embedded (inherits Light's 200,70,0) and its Syntax_assignValue is
// inserted twice (the last, dark_assignment.lighter(), wins). Neutral/formula slots emit no token and are omitted.
// EXTENSION: the MPSGE token types (gamsMpsgeSection, gamsMpsgeField) are not Studio slots; they reuse the style of
// Studio's "Declaration Keyword" (section keywords such as $PROD:) and "Keyword" (field labels such as Q:) slots.

export type StudioSlot = ${SLOTS.map((s) => `'${s}'`).join(' | ')};
export interface StudioStyle { foreground: string; bold: boolean; italic: boolean }
export interface StudioTheme { id: string; name: string; dark: boolean; slots: Record<StudioSlot, StudioStyle> }

/** Semantic token type per Studio slot (Theme::Syntax_<slot>). */
export const SLOT_TOKEN_TYPES: Record<StudioSlot, string> = {
${SLOTS.map((s) => `  ${s}: 'gams${s[0].toUpperCase()}${s.slice(1)}',`).join('\n')}
};

export const STUDIO_THEMES: readonly StudioTheme[] = [
`;
for (const [id, name, dk, t] of THEMES) {
  o += `  {\n    id: '${id}',\n    name: '${name}',\n    dark: ${dk},\n    slots: {\n`;
  for (const s of SLOTS) o += `      ${s}: { foreground: '${hex(t[s].c)}', bold: ${t[s].f === B}, italic: ${t[s].f === I} },\n`;
  o += `    },\n  },\n`;
}
o += `];\n\nexport const DEFAULT_LIGHT_THEME = 'light';\nexport const DEFAULT_DARK_THEME = 'dark';\n`;
process.stdout.write(o);
