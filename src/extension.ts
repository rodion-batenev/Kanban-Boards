import * as vscode from 'vscode';
import { createBoard, serializeBoard } from './board';
import { KanbanEditorProvider, boardTitleFromUri } from './kanbanEditor';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(KanbanEditorProvider.viewType, new KanbanEditorProvider(context.extensionUri), {
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('kanban.newBoard', newBoard),
    vscode.commands.registerCommand('kanban.openAsText', (uri?: vscode.Uri) => reopen(uri, 'default')),
    vscode.commands.registerCommand('kanban.openAsBoard', (uri?: vscode.Uri) => reopen(uri, KanbanEditorProvider.viewType)),
  );
}

export function deactivate(): void {}

async function newBoard(folder?: vscode.Uri): Promise<void> {
  let target: vscode.Uri | undefined;

  if (folder instanceof vscode.Uri) {
    const name = await vscode.window.showInputBox({
      prompt: 'Board file name',
      value: 'board',
      validateInput: (v) => (v.trim() ? undefined : 'Name must not be empty'),
    });
    if (!name) return;
    target = vscode.Uri.joinPath(folder, withExtension(name.trim()));
  } else {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    target = await vscode.window.showSaveDialog({
      defaultUri: root ? vscode.Uri.joinPath(root, 'board.knbn') : undefined,
      filters: { 'Kanban board': ['knbn'] },
      saveLabel: 'Create Board',
    });
    if (!target) return;
    target = target.with({ path: withExtension(target.path) });
  }

  if (await exists(target)) {
    const answer = await vscode.window.showWarningMessage(`${target.fsPath} already exists. Overwrite?`, { modal: true }, 'Overwrite');
    if (answer !== 'Overwrite') return;
  }

  const content = serializeBoard(createBoard(boardTitleFromUri(target)));
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));
  await vscode.commands.executeCommand('vscode.openWith', target, KanbanEditorProvider.viewType);
}

async function reopen(uri: vscode.Uri | undefined, viewType: string): Promise<void> {
  const target = uri ?? activeTabUri();
  if (target) await vscode.commands.executeCommand('vscode.openWith', target, viewType);
}

function activeTabUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) return input.uri;
  return undefined;
}

function withExtension(path: string): string {
  if (/\.knbn$/i.test(path)) return path;
  return path + '.knbn';
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
