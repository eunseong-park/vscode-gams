// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from 'fs';
import * as path from 'path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true });
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js'))) {
    mocha.addFile(path.resolve(__dirname, f));
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} tests failed.`)) : resolve()));
  });
}
