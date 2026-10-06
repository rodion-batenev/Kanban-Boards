import { applyOp, CARD_COLORS } from '../src/board';
import type { Board, Card, CardColor, Column, Op } from '../src/board';
import { tokenize } from '../src/links';
import type { HostMessage, WebviewMessage } from '../src/messages';

type BoardMessage = Exclude<HostMessage, { type: 'pickedLink' }>;

declare function acquireVsCodeApi(): { postMessage(msg: WebviewMessage): void };

type Edit =
  | { kind: 'boardTitle' }
  | { kind: 'column'; id: string }
  | { kind: 'card'; id: string }
  | { kind: 'addCard'; columnId: string }
  | { kind: 'addColumn' }
  | undefined;

type Drag = { kind: 'card' | 'column'; id: string };

const api = acquireVsCodeApi();
const root = document.getElementById('root') as HTMLElement;

let board: Board | undefined;
let error: string | undefined;
let edit: Edit;
let drag: Drag | undefined;
let deferred: BoardMessage | undefined;
let rendering = false;
/** True while the host's file picker has focus; suppresses blur-commit of the open card editor. */
let picking = false;
/** Color picked in the open card editor, applied on save; undefined if untouched, '' for "no color". */
let colorDraft: CardColor | '' | undefined;
let seq = 0;
let acked = 0;
let pickSeq = 0;
const pickRequests = new Map<number, (link: string | undefined) => void>();

window.addEventListener('message', (e: MessageEvent<HostMessage>) => {
  const msg = e.data;
  if (msg.type === 'pickedLink') {
    pickRequests.get(msg.reqId)?.(msg.link);
    pickRequests.delete(msg.reqId);
  } else if (drag) deferred = msg;
  else receive(msg);
});
window.addEventListener('drop', endDrag);
window.addEventListener('dragend', endDrag);

api.postMessage({ type: 'ready' });

function receive(msg: BoardMessage): void {
  if (msg.ack !== undefined) acked = Math.max(acked, msg.ack);
  // While our own ops are in flight the local optimistic state is newer than intermediate host snapshots.
  if (msg.type === 'board' && acked < seq) return;

  if (msg.type === 'board') {
    board = msg.board;
    error = undefined;
    if (!editTargetExists(board)) edit = undefined;
  } else {
    error = msg.error;
  }
  render();
}

function send(op: Op): void {
  if (board && op.type !== 'deleteColumn') {
    try {
      board = applyOp(board, op);
    } catch {
      // The host reports the error and re-syncs.
    }
  }
  api.postMessage({ type: 'op', op, seq: ++seq });
  render();
}

function startEdit(e: Edit): void {
  edit = e;
  colorDraft = undefined;
  render();
}

function endEdit(): void {
  edit = undefined;
  render();
}

function isEditing(e: NonNullable<Edit>): boolean {
  return JSON.stringify(edit) === JSON.stringify(e);
}

function editTargetExists(b: Board): boolean {
  const e = edit;
  if (!e) return true;
  switch (e.kind) {
    case 'column':
      return b.columns.some((c) => c.id === e.id);
    case 'addCard':
      return b.columns.some((c) => c.id === e.columnId);
    case 'card':
      return b.columns.some((c) => c.cards.some((k) => k.id === e.id));
    default:
      return true;
  }
}

// ---------------------------------------------------------------- rendering

function render(): void {
  rendering = true;
  try {
    const snapshot = captureFields();
    if (error !== undefined) root.replaceChildren(renderError(error));
    else if (board) root.replaceChildren(renderHeader(board), renderBoard(board));
    restoreFields(snapshot);
  } finally {
    rendering = false;
  }
}

function renderError(message: string): HTMLElement {
  return h(
    'div',
    { class: 'error' },
    h('h2', {}, 'Unable to display board'),
    h('pre', {}, message),
    h('button', { class: 'btn primary', onclick: () => api.postMessage({ type: 'openAsText' }) }, 'Open as Text'),
  );
}

function renderHeader(b: Board): HTMLElement {
  if (isEditing({ kind: 'boardTitle' })) {
    return h(
      'div',
      { class: 'header' },
      textField({
        key: 'board-title',
        value: b.title,
        className: 'board-title-input',
        placeholder: 'Board title',
        submitOnEnter: true,
        onCommit: (v) => {
          edit = undefined;
          if (v !== b.title) send({ type: 'renameBoard', title: v });
          else render();
        },
        onCancel: endEdit,
      }),
    );
  }
  return h(
    'div',
    { class: 'header' },
    h(
      'h1',
      {
        class: b.title ? 'board-title' : 'board-title placeholder',
        title: 'Click to rename',
        onclick: () => startEdit({ kind: 'boardTitle' }),
      },
      b.title || 'Untitled board',
    ),
  );
}

function renderBoard(b: Board): HTMLElement {
  const el = h('div', { class: 'board' }, ...b.columns.map(renderColumn), renderAddColumn());

  el.addEventListener('dragover', (e) => {
    if (drag?.kind !== 'column') return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    showColumnDrop(el, columnDropIndex(el, e.clientX));
  });
  el.addEventListener('drop', (e) => {
    if (drag?.kind !== 'column') return;
    e.preventDefault();
    const { id } = drag;
    const toIndex = columnDropIndex(el, e.clientX);
    endDrag();
    send({ type: 'moveColumn', columnId: id, toIndex });
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget as Node | null)) clearIndicators();
  });
  return el;
}

function renderColumn(column: Column): HTMLElement {
  const editingTitle = isEditing({ kind: 'column', id: column.id });

  const header = h(
    'div',
    { class: 'column-header', draggable: editingTitle ? undefined : 'true' },
    editingTitle
      ? textField({
          key: `column-title:${column.id}`,
          value: column.title,
          placeholder: 'Column title',
          submitOnEnter: true,
          onCommit: (v) => {
            edit = undefined;
            if (v && v !== column.title) send({ type: 'renameColumn', columnId: column.id, title: v });
            else render();
          },
          onCancel: endEdit,
        })
      : h(
          'span',
          {
            class: 'column-title',
            title: 'Double-click to rename',
            ondblclick: () => startEdit({ kind: 'column', id: column.id }),
          },
          column.title,
        ),
    iconButton('trash', 'Delete column', () => send({ type: 'deleteColumn', columnId: column.id }), 'column-delete'),
    h('span', { class: 'count' }, String(column.cards.length)),
    iconButton('add', 'Add card', () => startEdit({ kind: 'addCard', columnId: column.id })),
  );

  const el = h(
    'div',
    { class: 'column', 'data-id': column.id },
    header,
    renderAddCard(column),
    h('div', { class: 'cards' }, ...column.cards.map(renderCard)),
  );

  header.addEventListener('dragstart', (e) => {
    drag = { kind: 'column', id: column.id };
    const dt = e.dataTransfer!;
    dt.effectAllowed = 'move';
    dt.setData('text/plain', column.title);
    const r = el.getBoundingClientRect();
    dt.setDragImage(el, e.clientX - r.left, e.clientY - r.top);
    requestAnimationFrame(() => el.classList.add('dragging'));
  });
  header.addEventListener('dragend', endDrag);

  el.addEventListener('dragover', (e) => {
    if (drag?.kind !== 'card') return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer!.dropEffect = 'move';
    showCardDrop(el, cardDropIndex(el, e.clientY));
  });
  el.addEventListener('drop', (e) => {
    if (drag?.kind !== 'card') return;
    e.preventDefault();
    e.stopPropagation();
    const { id } = drag;
    const toIndex = cardDropIndex(el, e.clientY);
    endDrag();
    send({ type: 'moveCard', cardId: id, toColumnId: column.id, toIndex });
  });

  return el;
}

function renderAddCard(column: Column): HTMLElement | undefined {
  if (!isEditing({ kind: 'addCard', columnId: column.id })) return undefined;

  const add = (field: HTMLInputElement | HTMLTextAreaElement, keepOpen: boolean) => {
    const title = field.value.trim();
    if (!keepOpen) edit = undefined;
    if (title) {
      field.value = '';
      send({ type: 'addCard', columnId: column.id, title, toIndex: 0 });
    } else {
      edit = undefined;
      render();
    }
  };

  const field = textField({
    key: `add-card:${column.id}`,
    value: '',
    multiline: true,
    placeholder: 'Card title',
    submitOnEnter: true,
    onCommit: () => add(field, true),
    onBlur: () => add(field, false),
    onCancel: endEdit,
  });

  return h(
    'div',
    { class: 'add-card' },
    field,
    h(
      'div',
      { class: 'edit-actions' },
      h('button', { class: 'btn primary', onmousedown: preventBlur, onclick: () => add(field, true) }, 'Add'),
      h('button', { class: 'btn secondary', onmousedown: preventBlur, onclick: endEdit }, 'Cancel'),
    ),
  );
}

function renderCard(card: Card): HTMLElement {
  if (isEditing({ kind: 'card', id: card.id })) return renderCardEditor(card);

  const el = h(
    'div',
    {
      class: 'card',
      'data-id': card.id,
      'data-color': card.color,
      draggable: 'true',
      tabindex: '0',
      onclick: () => startEdit({ kind: 'card', id: card.id }),
      onkeydown: (e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) {
          e.preventDefault();
          startEdit({ kind: 'card', id: card.id });
        }
      },
    },
    h('div', { class: 'card-title' }, ...richText(card.title)),
    card.description ? h('div', { class: 'card-desc' }, ...richText(card.description)) : undefined,
    iconButton('trash', 'Delete card', () => send({ type: 'deleteCard', cardId: card.id }), 'card-delete'),
  );

  el.addEventListener('dragstart', (e) => {
    drag = { kind: 'card', id: card.id };
    const dt = e.dataTransfer!;
    dt.effectAllowed = 'move';
    dt.setData('text/plain', card.title);
    requestAnimationFrame(() => el.classList.add('dragging'));
    e.stopPropagation();
  });
  el.addEventListener('dragend', endDrag);
  return el;
}

function renderCardEditor(card: Card): HTMLElement {
  const color = colorDraft ?? card.color ?? '';
  const commit = () => {
    if (!isEditing({ kind: 'card', id: card.id })) return;
    edit = undefined;
    const t = title.value.trim();
    const d = description.value.trim();
    const c = colorDraft ?? card.color ?? '';
    if (t && (t !== card.title || d !== (card.description ?? '') || c !== (card.color ?? ''))) {
      send({ type: 'updateCard', cardId: card.id, title: t, description: d, color: c });
    } else {
      render();
    }
  };

  // Field blur is a no-op: the card commits once, on focusout.
  const title = textField({
    key: `card-title:${card.id}`,
    value: card.title,
    multiline: true,
    placeholder: 'Title',
    submitOnEnter: true,
    onCommit: commit,
    onBlur: noop,
    onCancel: endEdit,
  });
  const description = textField({
    key: `card-desc:${card.id}`,
    value: card.description ?? '',
    multiline: true,
    autofocus: false,
    className: 'desc',
    placeholder: 'Description',
    onCommit: commit,
    onBlur: noop,
    onCancel: endEdit,
  });

  const el = h(
    'div',
    { class: 'card editing', 'data-id': card.id, 'data-color': color || undefined },
    title,
    description,
    renderColorPicker(color, (c) => {
      colorDraft = c;
      if (c) el.dataset.color = c;
      else delete el.dataset.color;
    }),
    h(
      'div',
      { class: 'edit-actions' },
      h('button', { class: 'btn primary', onmousedown: preventBlur, onclick: commit }, 'Save'),
      h('button', { class: 'btn secondary', onmousedown: preventBlur, onclick: endEdit }, 'Cancel'),
      h('span', { class: 'spacer' }),
      iconButton('link', 'Insert link to file', () => void insertLink(document.activeElement === title ? title : description)),
      iconButton('trash', 'Delete card', () => {
        edit = undefined;
        send({ type: 'deleteCard', cardId: card.id });
      }),
    ),
  );

  el.addEventListener('focusout', (e) => {
    if (!rendering && !picking && !el.contains(e.relatedTarget as Node | null)) commit();
  });
  return el;
}

/** Updates selection in place rather than re-rendering, so keyboard focus stays on the swatch. */
function renderColorPicker(current: CardColor | '', onPick: (c: CardColor | '') => void): HTMLElement {
  const options: (CardColor | '')[] = ['', ...CARD_COLORS];
  const swatches = options.map((c) => {
    const label = c ? c[0].toUpperCase() + c.slice(1) : 'No color';
    return h(
      'button',
      {
        class: 'swatch',
        'data-color': c || undefined,
        title: label,
        'aria-label': label,
        'aria-pressed': String(c === current),
        onmousedown: preventBlur,
        onclick: (e) => {
          e.stopPropagation();
          for (const s of swatches) s.setAttribute('aria-pressed', String(s === e.currentTarget));
          onPick(c);
        },
      },
      c ? undefined : codicon('circle-slash'),
    );
  });
  return h('div', { class: 'color-picker', role: 'group', 'aria-label': 'Color' }, ...swatches);
}

/** Asks the host for a file link and inserts it at the field's selection; the field may be re-rendered meanwhile. */
async function insertLink(field: HTMLInputElement | HTMLTextAreaElement): Promise<void> {
  const key = field.dataset.key!;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  const reqId = ++pickSeq;
  picking = true;
  const link = await new Promise<string | undefined>((resolve) => {
    pickRequests.set(reqId, resolve);
    api.postMessage({ type: 'pickLink', reqId });
  });
  picking = false;

  const target = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-key="${CSS.escape(key)}"]`);
  if (!target) return;
  if (link) target.setRangeText(link, start, end, 'end');
  target.focus();
}

function richText(text: string): (Node | string)[] {
  return tokenize(text).map(({ text: label, target }) => {
    if (target === undefined) return label;
    return h(
      'a',
      {
        class: 'link',
        href: '#',
        title: target,
        draggable: 'false',
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          api.postMessage({ type: 'openLink', target, beside: e.metaKey || e.ctrlKey });
        },
      },
      label,
    );
  });
}

function renderAddColumn(): HTMLElement {
  if (!isEditing({ kind: 'addColumn' })) {
    return h(
      'div',
      { class: 'column column-new' },
      h('button', { class: 'add-btn', onclick: () => startEdit({ kind: 'addColumn' }) }, codicon('add'), 'Add column'),
    );
  }

  const add = (keepOpen: boolean) => {
    const title = field.value.trim();
    if (!keepOpen || !title) edit = undefined;
    if (title) {
      field.value = '';
      send({ type: 'addColumn', title });
    } else {
      render();
    }
  };

  const field = textField({
    key: 'add-column',
    value: '',
    placeholder: 'Column title',
    submitOnEnter: true,
    onCommit: () => add(true),
    onBlur: () => add(false),
    onCancel: endEdit,
  });

  return h(
    'div',
    { class: 'column column-new editing' },
    field,
    h(
      'div',
      { class: 'edit-actions' },
      h('button', { class: 'btn primary', onmousedown: preventBlur, onclick: () => add(true) }, 'Add'),
      h('button', { class: 'btn secondary', onmousedown: preventBlur, onclick: endEdit }, 'Cancel'),
    ),
  );
}

// ---------------------------------------------------------------- drag & drop

function cardDropIndex(columnEl: HTMLElement, y: number): number {
  const cards = siblings(columnEl, '.cards > .card');
  const i = cards.findIndex((c) => {
    const r = c.getBoundingClientRect();
    return y < r.top + r.height / 2;
  });
  return i < 0 ? cards.length : i;
}

function columnDropIndex(boardEl: HTMLElement, x: number): number {
  const cols = siblings(boardEl, ':scope > .column[data-id]');
  const i = cols.findIndex((c) => {
    const r = c.getBoundingClientRect();
    return x < r.left + r.width / 2;
  });
  return i < 0 ? cols.length : i;
}

/** Matching elements excluding the one being dragged, so indices match post-removal positions. */
function siblings(parent: HTMLElement, selector: string): HTMLElement[] {
  return [...parent.querySelectorAll<HTMLElement>(selector)].filter((el) => el.dataset.id !== drag?.id);
}

function showCardDrop(columnEl: HTMLElement, index: number): void {
  clearIndicators();
  const cards = siblings(columnEl, '.cards > .card');
  if (cards.length === 0) columnEl.classList.add('drop-into');
  else if (index < cards.length) cards[index].classList.add('drop-before');
  else cards[cards.length - 1].classList.add('drop-after');
}

function showColumnDrop(boardEl: HTMLElement, index: number): void {
  clearIndicators();
  const cols = siblings(boardEl, ':scope > .column[data-id]');
  if (cols.length === 0) return;
  if (index < cols.length) cols[index].classList.add('drop-before');
  else cols[cols.length - 1].classList.add('drop-after');
}

function clearIndicators(): void {
  root.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((el) => {
    el.classList.remove('drop-before', 'drop-after', 'drop-into');
  });
}

function endDrag(): void {
  if (!drag) return;
  drag = undefined;
  clearIndicators();
  root.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  if (deferred) {
    const msg = deferred;
    deferred = undefined;
    receive(msg);
  }
}

// ---------------------------------------------------------------- inputs

interface FieldOptions {
  key: string;
  value: string;
  placeholder?: string;
  className?: string;
  multiline?: boolean;
  /** Enter commits; otherwise Enter inserts a newline and Cmd/Ctrl+Enter commits. */
  submitOnEnter?: boolean;
  autofocus?: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
  /** Defaults to onCommit. */
  onBlur?: (value: string) => void;
}

function textField(o: FieldOptions): HTMLInputElement | HTMLTextAreaElement {
  const el = o.multiline ? h('textarea', { rows: '1' }) : h('input', { type: 'text' });
  el.className = ['field', o.className].filter(Boolean).join(' ');
  el.value = o.value;
  el.dataset.key = o.key;
  if (o.placeholder) el.placeholder = o.placeholder;
  if (o.autofocus !== false) el.dataset.autofocus = '';

  el.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.isComposing) return;
    if (ke.key === 'Escape') {
      ke.preventDefault();
      o.onCancel();
    } else if (ke.key === 'Enter' && (ke.metaKey || ke.ctrlKey || (o.submitOnEnter && !ke.shiftKey))) {
      ke.preventDefault();
      o.onCommit(el.value.trim());
    }
  });
  el.addEventListener('blur', () => {
    if (!rendering) (o.onBlur ?? o.onCommit)(el.value.trim());
  });
  return el;
}

interface FieldSnapshot {
  values: Map<string, string>;
  focus?: { key: string; start: number | null; end: number | null };
}

function captureFields(): FieldSnapshot {
  const values = new Map<string, string>();
  for (const el of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-key]')) {
    values.set(el.dataset.key!, el.value);
  }
  const active = document.activeElement as HTMLInputElement | null;
  const key = active?.dataset?.key;
  return { values, focus: key ? { key, start: active.selectionStart, end: active.selectionEnd } : undefined };
}

function restoreFields(s: FieldSnapshot): void {
  for (const el of root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-key]')) {
    const v = s.values.get(el.dataset.key!);
    if (v !== undefined) el.value = v;
  }
  const focused = s.focus && root.querySelector<HTMLInputElement>(`[data-key="${CSS.escape(s.focus.key)}"]`);
  if (focused && s.focus) {
    focused.focus();
    focused.setSelectionRange(s.focus.start, s.focus.end);
    return;
  }
  const auto = root.querySelector<HTMLInputElement>('[data-autofocus]');
  if (auto && !s.values.has(auto.dataset.key!)) {
    auto.focus();
    auto.select();
  }
}

/** Keeps the field focused when clicking its action buttons, so blur-commit doesn't race the click. */
function preventBlur(e: MouseEvent): void {
  e.preventDefault();
}

function noop(): void {}

// ---------------------------------------------------------------- dom helpers

type Handlers = { [E in keyof HTMLElementEventMap as `on${E}`]?: (ev: HTMLElementEventMap[E]) => void };
type Attrs = Handlers & { [attr: string]: unknown };
type Child = Node | string | undefined;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== undefined) el.append(c);
  return el;
}

function codicon(name: string): HTMLElement {
  return h('span', { class: `codicon codicon-${name}`, 'aria-hidden': 'true' });
}

function iconButton(icon: string, title: string, onClick: () => void, extraClass = ''): HTMLButtonElement {
  return h(
    'button',
    {
      class: `icon-btn ${extraClass}`.trim(),
      title,
      'aria-label': title,
      draggable: 'false',
      onmousedown: preventBlur,
      onclick: (e) => {
        e.stopPropagation();
        onClick();
      },
    },
    codicon(icon),
  );
}
