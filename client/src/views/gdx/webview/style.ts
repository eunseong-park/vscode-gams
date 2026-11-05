// SPDX-License-Identifier: GPL-3.0-or-later
// Stylesheet of the GDX viewer webview (inlined with a CSP nonce; VS Code theme variables only, so it
// follows light / dark / high-contrast themes).
export const CSS = `
:root{--rowh:22px;--bd:var(--vscode-panel-border,var(--vscode-widget-border,rgba(128,128,128,.35)))}
[hidden]{display:none!important}
html,body{height:100%;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);overflow:hidden}
body.resizing,body.resizing *{cursor:col-resize!important;user-select:none!important}
#app{display:flex;flex-direction:column;height:100vh}
.split-root{flex:1 1 auto;display:flex;min-height:0;min-width:0}
.split-root.horiz{flex-direction:row}
.split-root.vert{flex-direction:column}
.pane{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;box-sizing:border-box}
.panebody{flex:1 1 auto;display:flex;flex-direction:column;min-height:0;position:relative}
.datapane{flex:1 1 0}
.splitter{flex:0 0 5px;box-sizing:border-box;touch-action:none;outline:none}
.horiz>.splitter{cursor:col-resize;background:linear-gradient(to right,transparent 2px,var(--bd) 2px,var(--bd) 3px,transparent 3px)}
.vert>.splitter{cursor:row-resize;background:linear-gradient(to bottom,transparent 2px,var(--bd) 2px,var(--bd) 3px,transparent 3px)}
.splitter:hover,.splitter.drag,.splitter:focus-visible{background:var(--vscode-sash-hoverBorder,var(--vscode-focusBorder))}
.horiz>.splitter:hover,.horiz>.splitter.drag{background:linear-gradient(to right,transparent 1px,var(--vscode-sash-hoverBorder,var(--vscode-focusBorder)) 1px,var(--vscode-sash-hoverBorder,var(--vscode-focusBorder)) 4px,transparent 4px)}
/* toolbars: one fixed-height row, never wrapping */
.toolbar{display:flex;flex-wrap:nowrap;align-items:center;gap:2px;flex:0 0 30px;height:30px;padding:0 6px;box-sizing:border-box;overflow:hidden;border-bottom:1px solid var(--bd);white-space:nowrap}
.toolbar.sym{gap:6px}
.toolbar .title{font-weight:600;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.toolbar .grow,.grow{flex:1 1 auto}
.ovf{display:none!important}
.vsep{flex:0 0 1px;align-self:stretch;margin:6px 3px;background:var(--bd)}
button.tb{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;height:24px;min-width:24px;padding:0 5px;box-sizing:border-box;justify-content:center;color:var(--vscode-foreground);background:transparent;border:1px solid transparent;border-radius:4px;cursor:pointer;font:inherit}
button.tb:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.2));border-color:var(--vscode-contrastBorder,transparent)}
button.tb.on{background:var(--vscode-toolbar-activeBackground,rgba(128,128,128,.3));border-color:var(--vscode-contrastActiveBorder,transparent)}
button.tb:disabled{opacity:.45;cursor:default}
button.tb:focus-visible,.splitter:focus-visible,.dlink:focus-visible,button.tg:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.ico{stroke:currentColor;fill:none;stroke-width:1.3;stroke-linecap:round;stroke-linejoin:round;flex:0 0 auto}
@media (max-width:620px){button.tb .tl{display:none}}
/* inputs */
input,select,button{font:inherit}
input,select{color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-contrastBorder,transparent));padding:2px 4px;box-sizing:border-box;min-width:0}
input:focus,select:focus{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
input::placeholder{color:var(--vscode-input-placeholderForeground)}
input[type=checkbox]{padding:0}
.toolbar.sym input{flex:1 1 60px;height:22px}
button:not(.tb):not(.tg):not(.dlink):not(.mi){color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:1px solid var(--vscode-contrastBorder,transparent);padding:2px 8px;cursor:pointer}
button:not(.tb):not(.tg):not(.dlink):not(.mi):hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground)}
button:disabled{opacity:.5;cursor:default}
label{display:inline-flex;gap:4px;align-items:center}
/* symbol info + search */
.infoline{display:flex;flex-wrap:nowrap;align-items:center;gap:10px;flex:0 0 24px;height:24px;padding:0 8px;box-sizing:border-box;overflow:hidden;white-space:nowrap;border-bottom:1px solid var(--bd)}
.infoline>*{flex:0 0 auto}
.infoline .nm{font-weight:600}
.infoline .dim{color:var(--vscode-descriptionForeground)}
.infoline .domains{display:inline-flex;gap:6px;align-items:center}
.infoline .desc{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis}
.dlink{background:none;border:none;padding:0;color:var(--vscode-textLink-foreground);cursor:pointer;text-decoration:none}
.dlink:hover{color:var(--vscode-textLink-activeForeground);text-decoration:underline}
.searchbar{display:flex;flex-wrap:nowrap;align-items:center;gap:4px;flex:0 0 30px;height:30px;padding:0 8px;box-sizing:border-box;overflow:hidden;border-bottom:1px solid var(--bd)}
.searchbar input{flex:0 1 260px;min-width:80px;height:22px}
.searchbar .status{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button.tg{height:22px;min-width:24px;padding:0 4px;background:transparent;color:var(--vscode-foreground);border:1px solid transparent;border-radius:3px;cursor:pointer;font-family:var(--vscode-editor-font-family,monospace);font-size:.9em}
button.tg:hover{background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.2))}
button.tg.on{background:var(--vscode-inputOption-activeBackground,rgba(128,128,128,.35));border-color:var(--vscode-inputOption-activeBorder,var(--vscode-contrastActiveBorder,transparent));color:var(--vscode-inputOption-activeForeground,inherit)}
.status{color:var(--vscode-descriptionForeground)}
.optbar{display:flex;flex-wrap:nowrap;align-items:center;gap:8px;flex:0 0 30px;height:30px;padding:0 8px;box-sizing:border-box;overflow:hidden;white-space:nowrap;border-bottom:1px solid var(--bd)}
.optbar>*{flex:0 0 auto}
.notices{flex:0 0 auto;display:flex;flex-direction:column}
.notice{display:flex;align-items:center;gap:6px;height:22px;padding:0 8px;box-sizing:border-box;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;background:var(--vscode-inputValidation-infoBackground);border-bottom:1px solid var(--vscode-inputValidation-infoBorder,var(--bd))}
.notice.warn{background:var(--vscode-inputValidation-warningBackground);border-bottom-color:var(--vscode-inputValidation-warningBorder,var(--bd))}
.notice span{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis}
.notice button{flex:0 0 auto;background:none;border:none;color:inherit;cursor:pointer;padding:0 4px}
.statusbar{flex:0 0 22px;height:22px;display:flex;align-items:center;gap:12px;padding:0 8px;box-sizing:border-box;overflow:hidden;white-space:nowrap;border-top:1px solid var(--bd);color:var(--vscode-descriptionForeground)}
.statusbar .l{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis}
.statusbar .r{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.viewbody{flex:1 1 auto;display:flex;flex-direction:column;min-height:0;position:relative}
.msg{padding:8px;color:var(--vscode-descriptionForeground)}
.err{color:var(--vscode-errorForeground)}
/* list grid */
.scroller{flex:1 1 auto;overflow:auto;position:relative;min-height:0;outline:none}
.hdr{position:sticky;top:0;z-index:2;background:var(--vscode-editor-background)}
.row{display:grid;height:var(--rowh);line-height:var(--rowh);box-sizing:border-box}
.row>div{padding:0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-right:1px solid var(--vscode-editorGroup-border,var(--vscode-contrastBorder,transparent));min-width:0;box-sizing:border-box}
.row.h>div{position:relative;font-weight:600;cursor:pointer;user-select:none;background:var(--vscode-keybindingTable-headerBackground,var(--vscode-editorWidget-background));border-bottom:1px solid var(--bd)}
.num{text-align:right;font-variant-numeric:tabular-nums}
.body{position:relative}
.body .row{position:absolute;left:0}
.body .row>div{user-select:none}
.body .row:hover>div:not(.selcell){background:var(--vscode-list-hoverBackground)}
.special{color:var(--vscode-descriptionForeground)}
.rz{position:absolute;right:-3px;top:0;bottom:0;width:7px;cursor:col-resize;z-index:3}
.rz:hover,.rz.drag{background:var(--vscode-sash-hoverBorder,var(--vscode-focusBorder));opacity:.7}
.fbtn{display:inline-flex;vertical-align:middle;margin-left:4px;cursor:pointer;opacity:.55}
.fbtn .ico{width:12px;height:12px}
.fbtn.active .ico{fill:currentColor}
.fbtn:hover,.fbtn.active{opacity:1;color:var(--vscode-textLink-foreground)}
.selcell{background:var(--vscode-editor-selectionBackground)!important}
.scroller:focus-within .selcell,.tblscroll:focus-within .selcell{background:var(--vscode-list-activeSelectionBackground)!important;color:var(--vscode-list-activeSelectionForeground)}
.activecell{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.match{background:var(--vscode-editor-findMatchHighlightBackground)!important;outline:1px solid var(--vscode-editor-findMatchHighlightBorder,transparent);outline-offset:-1px}
.match.cur{background:var(--vscode-editor-findMatchBackground)!important;outline:1px solid var(--vscode-editor-findMatchBorder,var(--vscode-focusBorder))}
/* pivot (table view) */
.pivotbar{gap:12px}
.zone{display:flex;gap:6px;align-items:center;min-height:22px;padding:0 6px;border:1px dashed var(--bd)}
.zone.over{background:var(--vscode-list-hoverBackground)}
.zonelbl{color:var(--vscode-descriptionForeground)}
.chips{display:inline-flex;gap:4px}
.chip{display:inline-flex;align-items:center;padding:0 6px;cursor:grab;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:3px}
.tblwrap{position:relative;flex:1 1 auto;min-height:0;overflow:hidden}
.tblwrap>div{position:absolute;box-sizing:border-box}
.tblcorner,.tblclip{overflow:hidden;background:var(--vscode-keybindingTable-headerBackground,var(--vscode-editorWidget-background))}
.tblscroll{overflow:auto;outline:none}
.tbllayer,.tblcells,.tblsizer{position:relative}
.tbllayer{width:1px;height:1px}
.tblh,.tblc{position:absolute;height:var(--rowh);line-height:var(--rowh);box-sizing:border-box;padding:0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-right:1px solid var(--vscode-editorGroup-border,var(--vscode-contrastBorder,transparent));border-bottom:1px solid var(--vscode-editorGroup-border,var(--vscode-contrastBorder,transparent))}
.tblh{font-weight:600;background:var(--vscode-keybindingTable-headerBackground,var(--vscode-editorWidget-background))}
.tblc{user-select:none}
/* popups and menus */
.popup{position:fixed;z-index:20;width:320px;max-height:370px;display:flex;flex-direction:column;gap:6px;padding:8px;box-sizing:border-box;background:var(--vscode-editorWidget-background);color:var(--vscode-editorWidget-foreground,var(--vscode-foreground));border:1px solid var(--vscode-focusBorder);box-shadow:0 2px 8px var(--vscode-widget-shadow)}
.ptitle{font-weight:600}
.prow{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.plist{flex:1 1 auto;overflow:auto;min-height:80px;max-height:180px;border:1px solid var(--vscode-input-border,var(--bd))}
.plabel{display:flex;padding:0 4px;white-space:nowrap}
.menu{position:fixed;z-index:100;min-width:200px;max-width:min(420px,96vw);padding:4px 0;box-sizing:border-box;background:var(--vscode-menu-background,var(--vscode-editorWidget-background));color:var(--vscode-menu-foreground,var(--vscode-foreground));border:1px solid var(--vscode-menu-border,var(--vscode-widget-border,var(--bd)));border-radius:5px;box-shadow:0 2px 8px var(--vscode-widget-shadow);outline:none}
.mi{display:flex;align-items:center;gap:6px;padding:3px 12px 3px 6px;cursor:pointer;white-space:nowrap;outline:none}
.mi:hover,.mi:focus{background:var(--vscode-menu-selectionBackground,var(--vscode-list-hoverBackground));color:var(--vscode-menu-selectionForeground,inherit)}
.mi.disabled{opacity:.5;cursor:default}
.mchk{flex:0 0 14px;text-align:center}
.mlbl{flex:1 1 auto}
.msc{flex:0 0 auto;color:var(--vscode-descriptionForeground);padding-left:18px}
.msep{height:1px;margin:4px 0;background:var(--vscode-menu-separatorBackground,var(--bd))}
.mnote{padding:4px 12px;max-width:260px;white-space:normal;color:var(--vscode-descriptionForeground)}
.prefs{display:flex;flex-direction:column;gap:6px;padding:6px 12px}
.prow2{display:flex;align-items:center;gap:8px}
.plabel2{flex:0 0 64px}
.prefs input[type=number]{width:70px}
/* chart */
.chartwrap{position:relative;flex:1 1 auto;display:flex;flex-direction:column;min-height:0}
.chartplot{flex:1 1 auto;min-height:0;overflow:hidden}
.chartplot svg{display:block}
.legend{display:flex;flex-wrap:wrap;gap:4px 12px;max-height:56px;overflow:auto;padding:2px 8px;flex:0 0 auto}
.legend .lg{display:inline-flex;align-items:center;gap:4px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;flex:0 0 auto}
.charttip{position:absolute;z-index:5;pointer-events:none;padding:4px 8px;background:var(--vscode-editorHoverWidget-background);color:var(--vscode-editorHoverWidget-foreground,var(--vscode-foreground));border:1px solid var(--vscode-editorHoverWidget-border,var(--bd));box-shadow:0 2px 8px var(--vscode-widget-shadow)}
.charttip .tt{font-weight:600;margin-bottom:2px}
.charttip .tr{display:flex;align-items:center;gap:4px;white-space:nowrap}
/* export dialog */
.dlgback{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35)}
.dlg{display:flex;flex-direction:column;gap:8px;width:min(640px,94vw);max-height:90vh;padding:12px;box-sizing:border-box;background:var(--vscode-editorWidget-background);color:var(--vscode-editorWidget-foreground,var(--vscode-foreground));border:1px solid var(--vscode-focusBorder);box-shadow:0 2px 12px var(--vscode-widget-shadow)}
.dlgtitle{font-weight:600}
.dlgbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.dlgbar>input{flex:1 1 140px}
.dlgbar.end{justify-content:flex-end}
.dlglist{flex:1 1 auto;min-height:120px;max-height:240px;overflow:auto;border:1px solid var(--vscode-input-border,var(--bd))}
.dlgrow{display:flex;gap:8px;padding:1px 6px;align-items:center}
.dlgrow:hover{background:var(--vscode-list-hoverBackground)}
.dlgrow .dn{font-weight:600;flex:0 0 auto}
.dlgrow .dt{color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dlggrid{display:grid;grid-template-columns:auto 1fr auto;gap:6px 8px;align-items:center}
button.primary{background:var(--vscode-button-background)!important;color:var(--vscode-button-foreground)!important}
`;
