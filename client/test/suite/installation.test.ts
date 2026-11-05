// SPDX-License-Identifier: GPL-3.0-or-later
import * as assert from 'assert';
import * as vscode from 'vscode';
import { activate } from './helpers';

suite('GAMS installation picker', () => {
  suiteSetup(activate);

  test('gams.selectInstallation is registered', async () => {
    const cmds = await vscode.commands.getCommands(true);
    assert.ok(cmds.includes('gams.selectInstallation'));
  });

  test('status shows the version of GAMS_SYSDIR', async function () {
    if (!process.env.GAMS_SYSDIR) {
      console.log('SKIP installation status: GAMS_SYSDIR not set');
      return this.skip();
    }
    const st = await vscode.commands.executeCommand<{ text: string; notFound: boolean; dir?: string }>('gams._installationStatus');
    assert.strictEqual(st.notFound, false);
    assert.match(st.text, /^GAMS \d+\.\d+/);
  });
});
