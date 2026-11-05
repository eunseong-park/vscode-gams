// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Link handling of the help panel (pure, no vscode imports). The docs run in a sandboxed iframe without
 * allow-popups and with a CSP that blocks foreign hosts, so a click on an external link would do nothing or blank
 * the frame. The docs server injects `classifyLink` into every page; the extension validates what comes back.
 */
import * as path from 'path';

export type LinkAction = 'default' | 'external' | 'self' | 'block';

/**
 * Decide what a click on a link does. Self-contained (its source is injected into the served pages): no references
 * to anything outside the function.
 * `href` is the resolved absolute URL, `origin` the page origin, `target` the link's target attribute,
 * `download` whether it has a download attribute.
 */
export function classifyLink(href: string, origin: string, target: string, download: boolean): LinkAction {
  let u: URL;
  try { u = new URL(href); } catch { return 'default'; }
  if (u.protocol === 'mailto:') return 'external';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.protocol === 'javascript:' ? 'default' : 'block';
  const exts = ['pdf', 'xlsx', 'xls', 'xlsm', 'zip', 'gz', 'tgz', '7z', 'gdx', 'gms', 'inc', 'db', 'accdb', 'csv', 'dat', 'opt'];
  if (u.origin !== origin) return 'external';
  const m = /\.([A-Za-z0-9]+)$/.exec(u.pathname);
  if (download || (m && exts.indexOf(m[1].toLowerCase()) >= 0)) return 'external';
  // popups are sandboxed away: open "new window" links in the frame itself
  const t = (target || '').toLowerCase();
  if (t !== '' && t !== '_self') return 'self';
  return 'default';
}

/** Click interceptor appended to every served HTML page. */
export const LINK_INTERCEPT_SOURCE = `<script>(function(){var cl=${classifyLink.toString()};`
  + `document.addEventListener('click',function(e){if(e.defaultPrevented||e.button!==0)return;`
  + `var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;`
  + `var h=a.getAttribute('href')||'';if(h===''||h.charAt(0)==='#')return;`
  + `var act=cl(a.href,location.origin,a.getAttribute('target')||'',a.hasAttribute('download'));`
  + `if(act==='default')return;e.preventDefault();`
  + `if(act==='self')location.href=a.href;`
  + `else if(act==='external')parent.postMessage({gamsOpenExternal:a.href},'*');`
  + `},true);})();</script>`;

/** Whether `url` may be passed to the extension for opening: http(s) or mailto only. */
export function isOpenableUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 4096) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:';
  } catch { return false; }
}

/**
 * Local file behind a docs-server URL (`<base><area>/...`, base = `http://host:port/<token>/`), or undefined when `url`
 * is not served from this server or leaves the docs / `<lib>_ml/libhtml` areas.
 */
export function docFileOfUrl(bases: string[], url: string, docsDir: string): string | undefined {
  const base = bases.find((b) => url.startsWith(b));
  if (!base) return undefined;
  let rel: string;
  try { rel = decodeURIComponent(new URL(url).pathname.substring(new URL(base).pathname.length)); } catch { return undefined; }
  if (rel.includes('\0')) return undefined;
  const parts = rel.split('/');
  const sysRoot = path.dirname(docsDir);
  let area: string;
  let rest: string[];
  if (parts[0] === 'docs') { area = docsDir; rest = parts.slice(1); }
  else if (/^[a-z0-9]+_ml$/i.test(parts[0] ?? '') && parts[1] === 'libhtml') { area = path.join(sysRoot, parts[0], 'libhtml'); rest = parts.slice(2); }
  else return undefined;
  // resolve the area too: a docs dir written with '/' on Windows would never prefix-match the resolved file
  const root = path.resolve(area);
  const file = path.resolve(root, ...rest);
  return file.startsWith(root + path.sep) ? file : undefined;
}
