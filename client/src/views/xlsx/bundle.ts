// SPDX-License-Identifier: GPL-3.0-or-later
// Entry of the lazily loaded Excel bundle (dist/xlsx.js, built by esbuild.js): everything that needs
// exceljs lives behind this module so the main extension bundle stays small and exceljs is only loaded
// when an Excel export runs.
export { exportCompareXlsx } from '../gdxCompare/exportXlsx';
export { exportGdxXlsx } from '../gdx/exportXlsx';
