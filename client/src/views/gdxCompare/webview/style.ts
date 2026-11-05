// SPDX-License-Identifier: GPL-3.0-or-later
// Extra styles of the compare webview (on top of the shared GDX viewer stylesheet).
import { cssColor } from '../model';

export const COMPARE_CSS = `
.cf-added{background:${cssColor('added')}}
.cf-removed{background:${cssColor('removed')}}
.cf-changed{background:${cssColor('changed')}}
.body .row:hover>div.cf-added,.body .row:hover>div.cf-removed,.body .row:hover>div.cf-changed{filter:brightness(1.15)}
.mark{text-align:center;font-weight:700;padding:0}
.badge{display:inline-block;padding:0 6px;border-radius:3px;line-height:16px}
.st-different{background:${cssColor('changed')}}
.st-onlyA{background:${cssColor('removed')}}
.st-onlyB{background:${cssColor('added')}}
.st-equal,.st-unknown,.st-pending{color:var(--vscode-descriptionForeground)}
.cmpgrids{flex:1 1 auto;display:flex;min-height:0}
.cmpside{flex:1 1 0;min-width:0;display:flex;flex-direction:column;min-height:0}
.cmpside+.cmpside{border-left:2px solid var(--bd)}
.sidetitle{flex:0 0 22px;height:22px;display:flex;align-items:center;gap:6px;padding:0 8px;box-sizing:border-box;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:600;border-bottom:1px solid var(--bd);background:var(--vscode-editorWidget-background)}
.sidebody{flex:1 1 auto;display:flex;flex-direction:column;min-height:0;position:relative}
.cmpside.noscroll .scroller{scrollbar-width:none}
.cmpside.noscroll .scroller::-webkit-scrollbar{display:none}
.missing{color:var(--vscode-disabledForeground,var(--vscode-descriptionForeground))}
.chip2{display:inline-flex;align-items:center;padding:0 6px;border-radius:3px;line-height:16px;white-space:nowrap}
.legend2{display:inline-flex;gap:8px;align-items:center}
.optgrid{display:grid;grid-template-columns:auto 1fr;gap:6px 8px;padding:6px 12px;align-items:center}
.optgrid input[type=text]{width:90px}
.symfilter{flex:1 1 60px}
`;
