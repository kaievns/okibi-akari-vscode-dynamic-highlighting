import * as vscode from 'vscode';
import { Decorator } from './decorator';

let decorator: Decorator | undefined;

export function activate(context: vscode.ExtensionContext): void {
  decorator = new Decorator();
  context.subscriptions.push(decorator);

  context.subscriptions.push(
    vscode.commands.registerCommand('okibiDynamic.toggle', async () => {
      const cfg = vscode.workspace.getConfiguration('okibiDynamic');
      const now = cfg.get('enabled', true);
      await cfg.update('enabled', !now, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(
        `Okibi dynamic highlighting ${!now ? 'on' : 'off'}`,
        1500,
      );
    }),
  );
}

export function deactivate(): void {
  decorator?.dispose();
  decorator = undefined;
}
