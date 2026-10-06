import * as os from 'node:os';
import * as posixPath from 'node:path/posix';
import * as vscode from 'vscode';
import { applyOp, createBoard, parseBoard, serializeBoard } from './board';
import type { Board, Op } from './board';
import { formatLink, isExternal, parseTarget } from './links';
import type { HostMessage, WebviewMessage } from './messages';

export class KanbanEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'kanban.board';

  private readonly extensionUri: vscode.Uri;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
    };
    webview.html = this.getHtml(webview);

    const post = (ack?: number) => {
      const result = parseBoard(document.getText());
      const msg: HostMessage = result.ok
        ? { type: 'board', board: result.board, ack }
        : { type: 'error', error: result.error, ack };
      void webview.postMessage(msg);
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString() || e.contentChanges.length === 0) return;
      post();
      if (e.reason !== undefined && panel.active) void this.enqueue(document, () => this.save(document));
    });
    panel.onDidDispose(() => changeSub.dispose());

    webview.onDidReceiveMessage((msg: WebviewMessage) => {
      switch (msg.type) {
        case 'ready':
          post();
          break;
        case 'op':
          void this.enqueue(document, () => this.handleOp(document, msg.op))
            .catch((e: Error) => void vscode.window.showErrorMessage(`Kanban: ${e.message}`))
            .finally(() => post(msg.seq));
          break;
        case 'openAsText':
          void vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
          break;
        case 'openLink':
          void openLink(document, msg.target, msg.beside).catch(
            (e: Error) => void vscode.window.showErrorMessage(`Kanban: ${e.message}`),
          );
          break;
        case 'pickLink':
          void pickLink(document)
            .catch((e: Error) => {
              void vscode.window.showErrorMessage(`Kanban: ${e.message}`);
              return undefined;
            })
            .then((link) => webview.postMessage({ type: 'pickedLink', reqId: msg.reqId, link } satisfies HostMessage));
          break;
      }
    });

    if (document.getText().trim() === '') {
      await this.enqueue(document, () => this.write(document, createBoard(boardTitleFromUri(document.uri))));
    }
  }

  /** Serializes edits per document so each op sees the result of the previous one. */
  private enqueue<T>(document: vscode.TextDocument, task: () => Promise<T>): Promise<T> {
    const key = document.uri.toString();
    const next = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(task);
    this.queues.set(key, next);
    return next;
  }

  private async handleOp(document: vscode.TextDocument, op: Op): Promise<void> {
    const result = parseBoard(document.getText());
    if (!result.ok) throw new Error(result.error);
    const board = result.board;

    if (op.type === 'deleteColumn') {
      const col = board.columns.find((c) => c.id === op.columnId);
      if (col && col.cards.length > 0) {
        const answer = await vscode.window.showWarningMessage(
          `Delete column "${col.title}" and its ${col.cards.length} card(s)?`,
          { modal: true },
          'Delete',
        );
        if (answer !== 'Delete') return;
      }
    }

    await this.write(document, applyOp(board, op));
  }

  private async write(document: vscode.TextDocument, board: Board): Promise<void> {
    const text = serializeBoard(board);
    if (text === document.getText()) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('Failed to apply edit');
    await this.save(document);
  }

  private async save(document: vscode.TextDocument): Promise<void> {
    if (document.isDirty && !document.isClosed && !document.isUntitled && !(await document.save())) {
      throw new Error('Failed to save');
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', name));
    const nonce = getNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${asset('main.css')}" rel="stylesheet">
  <title>Kanban</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
  }
}

export function boardTitleFromUri(uri: vscode.Uri): string {
  const base = uri.path.split('/').pop() ?? 'Board';
  return base.replace(/\.knbn$/i, '') || 'Board';
}

async function openLink(document: vscode.TextDocument, target: string, beside: boolean): Promise<void> {
  if (isExternal(target)) {
    await vscode.env.openExternal(vscode.Uri.parse(target));
    return;
  }
  const { path, line, column } = parseTarget(target);
  const found = await resolvePath(document, path);
  if (!found) {
    void vscode.window.showWarningMessage(`Kanban: file not found: ${path}`);
    return;
  }
  if (found.type & vscode.FileType.Directory) {
    await vscode.commands.executeCommand('revealInExplorer', found.uri);
    return;
  }
  const pos = line ? new vscode.Position(line - 1, (column ?? 1) - 1) : undefined;
  const options: vscode.TextDocumentShowOptions = {
    viewColumn: beside ? vscode.ViewColumn.Beside : undefined,
    selection: pos && new vscode.Range(pos, pos),
  };
  await vscode.commands.executeCommand('vscode.open', found.uri, options);
}

/** Relative paths resolve against the board's folder first, then the workspace root. */
async function resolvePath(
  document: vscode.TextDocument,
  raw: string,
): Promise<{ uri: vscode.Uri; type: vscode.FileType } | undefined> {
  const path = safeDecode(raw);
  const boardDir = vscode.Uri.joinPath(document.uri, '..');
  const root = (vscode.workspace.getWorkspaceFolder(document.uri) ?? vscode.workspace.workspaceFolders?.[0])?.uri;

  const candidates: vscode.Uri[] = [];
  if (/^file:/i.test(path)) candidates.push(vscode.Uri.parse(path));
  else if (path.startsWith('~/')) candidates.push(vscode.Uri.file(posixPath.join(os.homedir(), path.slice(2))));
  else if (/^[a-zA-Z]:[\\/]/.test(path)) candidates.push(vscode.Uri.file(path));
  else if (path.startsWith('/')) {
    candidates.push(document.uri.with({ path }));
    if (root) candidates.push(vscode.Uri.joinPath(root, path));
  } else {
    candidates.push(vscode.Uri.joinPath(boardDir, path));
    if (root) candidates.push(vscode.Uri.joinPath(root, path));
  }

  for (const uri of candidates) {
    try {
      return { uri, type: (await vscode.workspace.fs.stat(uri)).type };
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

async function pickLink(document: vscode.TextDocument): Promise<string | undefined> {
  const boardDir = vscode.Uri.joinPath(document.uri, '..');
  const browse: vscode.QuickPickItem = { label: '$(folder-opened) Browse...', alwaysShow: true };

  const items = (async (): Promise<(vscode.QuickPickItem & { uri?: vscode.Uri })[]> => {
    const files = await vscode.workspace.findFiles('**/*', excludeGlob(), 20000);
    const fileItems = files
      .filter((uri) => uri.toString() !== document.uri.toString())
      .map((uri) => ({ label: posixPath.basename(uri.path), description: vscode.workspace.asRelativePath(uri), uri }))
      .sort((a, b) => a.description.localeCompare(b.description));
    return [browse, ...fileItems];
  })();

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'File to link',
    matchOnDescription: true,
  });
  if (!picked) return undefined;

  const uri =
    picked.uri ??
    (await vscode.window.showOpenDialog({ defaultUri: boardDir, canSelectMany: false, openLabel: 'Link' }))?.[0];
  if (!uri) return undefined;
  return formatLink(posixPath.basename(uri.path), linkTarget(boardDir, uri));
}

function linkTarget(fromDir: vscode.Uri, to: vscode.Uri): string {
  if (fromDir.scheme !== to.scheme || fromDir.authority !== to.authority) return to.toString(true);
  return posixPath.relative(fromDir.path, to.path) || posixPath.basename(to.path);
}

/** `findFiles` with an explicit exclude drops `files.exclude`, so merge it with `search.exclude`. */
function excludeGlob(): string | undefined {
  const patterns = ['files', 'search'].flatMap((section) =>
    Object.entries(vscode.workspace.getConfiguration(section).get<Record<string, unknown>>('exclude') ?? {})
      .filter(([, enabled]) => enabled === true)
      .map(([glob]) => glob),
  );
  return patterns.length ? `{${[...new Set(patterns)].join(',')}}` : undefined;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
