import * as vscode from 'vscode';
import { GitAccountViewProvider } from './GitAccountViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new GitAccountViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      GitAccountViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gitAccountSwitcher.refresh', () => {
      provider.refresh();
    })
  );
}

export function deactivate(): void {}
