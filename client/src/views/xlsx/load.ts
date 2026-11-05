// SPDX-License-Identifier: GPL-3.0-or-later
import * as path from 'path';

export type XlsxModule = typeof import('./bundle');

/** Load the Excel bundle that sits next to the extension bundle (`dist/xlsx.js`). */
export function loadXlsx(): XlsxModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(path.join(__dirname, 'xlsx.js')) as XlsxModule;
}
