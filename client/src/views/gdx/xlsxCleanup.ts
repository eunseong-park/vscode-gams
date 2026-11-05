// SPDX-License-Identifier: GPL-3.0-or-later
// Failure handling of the streaming xlsx writers: a failed export must release the file handle (Windows keeps the
// file locked otherwise) and must not leave a partial, corrupt .xlsx behind.
import * as fs from 'fs';
import * as ExcelJS from 'exceljs';

export async function writeXlsxSafely<T>(file: string, run: (wb: ExcelJS.stream.xlsx.WorkbookWriter) => Promise<T>): Promise<T> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useStyles: true, useSharedStrings: false });
  let ok = false;
  try {
    const r = await run(wb);
    ok = true;
    return r;
  } finally {
    if (!ok) await abortWorkbook(wb, file);
  }
}

async function abortWorkbook(wb: ExcelJS.stream.xlsx.WorkbookWriter, file: string): Promise<void> {
  const w = wb as unknown as { zip?: { abort?: () => void }; stream?: fs.WriteStream };
  try { w.zip?.abort?.(); } catch { /* already finished */ }
  const stream = w.stream;
  if (stream && !stream.destroyed) {
    await new Promise<void>((resolve) => {
      stream.once('close', () => resolve());
      stream.destroy();
    });
  }
  await fs.promises.rm(file, { force: true }).catch(() => undefined);
}
