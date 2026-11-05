// SPDX-License-Identifier: GPL-3.0-or-later
// Tests that need a real GAMS installation read its system directory from $GAMS_SYSDIR only.
import * as fs from 'fs';

/** `$GAMS_SYSDIR` if it is an existing directory (and holds `needs`, when given), else undefined with a SKIP note. */
export function testSysdir(test: string, needs?: string): string | undefined {
  const dir = process.env.GAMS_SYSDIR;
  if (dir && fs.existsSync(needs ? `${dir}/${needs}` : dir)) return dir;
  console.log(`SKIP ${test}: GAMS system directory not found (set GAMS_SYSDIR)`);
  return undefined;
}
