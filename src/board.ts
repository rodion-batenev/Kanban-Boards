export const CARD_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type CardColor = (typeof CARD_COLORS)[number];

export interface Card {
  id: string;
  title: string;
  description?: string;
  color?: CardColor;
}

export interface Column {
  id: string;
  title: string;
  cards: Card[];
}

export interface Board {
  version: 1;
  title: string;
  columns: Column[];
}

export type Op =
  | { type: 'renameBoard'; title: string }
  | { type: 'addColumn'; title: string }
  | { type: 'renameColumn'; columnId: string; title: string }
  | { type: 'deleteColumn'; columnId: string }
  | { type: 'moveColumn'; columnId: string; toIndex: number }
  /** toIndex defaults to the end of the column. */
  | { type: 'addCard'; columnId: string; title: string; toIndex?: number }
  /** Empty description/color clears the field. */
  | { type: 'updateCard'; cardId: string; title?: string; description?: string; color?: CardColor | '' }
  | { type: 'deleteCard'; cardId: string }
  | { type: 'moveCard'; cardId: string; toColumnId: string; toIndex: number };

export type ParseResult = { ok: true; board: Board } | { ok: false; error: string };

export function createBoard(title = 'Board'): Board {
  const board: Board = { version: 1, title, columns: [] };
  for (const name of ['Todo', 'In Progress', 'Done']) {
    board.columns.push({ id: newId(board, 'c'), title: name, cards: [] });
  }
  return board;
}

export function serializeBoard(board: Board): string {
  return JSON.stringify(board, null, 2) + '\n';
}

/** Validates structure; unknown extra fields are kept so round-trips don't lose data. */
export function parseBoard(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }

  const fail = (path: string, msg: string): ParseResult => ({ ok: false, error: `${path}: ${msg}` });

  if (!isObject(data)) return fail('$', 'expected an object');
  if (data.version !== 1) return fail('$.version', 'expected 1');
  if (typeof data.title !== 'string') return fail('$.title', 'expected a string');
  if (!Array.isArray(data.columns)) return fail('$.columns', 'expected an array');

  const ids = new Set<string>();
  const checkId = (path: string, id: unknown): ParseResult | undefined => {
    if (typeof id !== 'string' || id === '') return fail(path, 'expected a non-empty string');
    if (ids.has(id)) return fail(path, `duplicate id "${id}"`);
    ids.add(id);
    return undefined;
  };

  for (const [ci, col] of data.columns.entries()) {
    const cp = `$.columns[${ci}]`;
    if (!isObject(col)) return fail(cp, 'expected an object');
    const idErr = checkId(`${cp}.id`, col.id);
    if (idErr) return idErr;
    if (typeof col.title !== 'string') return fail(`${cp}.title`, 'expected a string');
    if (!Array.isArray(col.cards)) return fail(`${cp}.cards`, 'expected an array');

    for (const [ki, card] of col.cards.entries()) {
      const kp = `${cp}.cards[${ki}]`;
      if (!isObject(card)) return fail(kp, 'expected an object');
      const cardIdErr = checkId(`${kp}.id`, card.id);
      if (cardIdErr) return cardIdErr;
      if (typeof card.title !== 'string') return fail(`${kp}.title`, 'expected a string');
      if (card.description !== undefined && typeof card.description !== 'string') {
        return fail(`${kp}.description`, 'expected a string');
      }
      if (card.color !== undefined && !isCardColor(card.color)) {
        return fail(`${kp}.color`, `expected one of ${CARD_COLORS.join(', ')}`);
      }
    }
  }

  return { ok: true, board: data as unknown as Board };
}

/** Pure reducer: returns a new board, throws on invalid ops. */
export function applyOp(input: Board, op: Op): Board {
  const board = structuredClone(input);

  switch (op.type) {
    case 'renameBoard':
      board.title = op.title.trim();
      break;

    case 'addColumn':
      board.columns.push({ id: newId(board, 'c'), title: requireTitle(op.title), cards: [] });
      break;

    case 'renameColumn':
      findColumn(board, op.columnId).title = requireTitle(op.title);
      break;

    case 'deleteColumn':
      board.columns.splice(columnIndex(board, op.columnId), 1);
      break;

    case 'moveColumn': {
      const [col] = board.columns.splice(columnIndex(board, op.columnId), 1);
      board.columns.splice(clamp(op.toIndex, 0, board.columns.length), 0, col);
      break;
    }

    case 'addCard': {
      const cards = findColumn(board, op.columnId).cards;
      const card = { id: newId(board, 'k'), title: requireTitle(op.title) };
      cards.splice(clamp(op.toIndex ?? cards.length, 0, cards.length), 0, card);
      break;
    }

    case 'updateCard': {
      const { card } = findCard(board, op.cardId);
      if (op.title !== undefined) card.title = requireTitle(op.title);
      if (op.description !== undefined) {
        const description = op.description.trim();
        if (description) card.description = description;
        else delete card.description;
      }
      if (op.color !== undefined) {
        if (op.color === '') delete card.color;
        else if (isCardColor(op.color)) card.color = op.color;
        else throw new Error(`Unknown color: ${op.color}`);
      }
      break;
    }

    case 'deleteCard': {
      const { column, index } = findCard(board, op.cardId);
      column.cards.splice(index, 1);
      break;
    }

    case 'moveCard': {
      const target = findColumn(board, op.toColumnId);
      const { column, index } = findCard(board, op.cardId);
      const [card] = column.cards.splice(index, 1);
      target.cards.splice(clamp(op.toIndex, 0, target.cards.length), 0, card);
      break;
    }

    default:
      throw new Error(`Unknown op: ${(op as { type: string }).type}`);
  }

  return board;
}

export function newId(board: Board, prefix: 'c' | 'k'): string {
  const used = new Set<string>();
  for (const col of board.columns) {
    used.add(col.id);
    for (const card of col.cards) used.add(card.id);
  }
  let id: string;
  do {
    id = `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
  } while (used.has(id));
  return id;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isCardColor(v: unknown): v is CardColor {
  return (CARD_COLORS as readonly unknown[]).includes(v);
}

function requireTitle(title: string): string {
  const t = title.trim();
  if (!t) throw new Error('Title must not be empty');
  return t;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function columnIndex(board: Board, id: string): number {
  const i = board.columns.findIndex((c) => c.id === id);
  if (i < 0) throw new Error(`Column not found: ${id}`);
  return i;
}

function findColumn(board: Board, id: string): Column {
  return board.columns[columnIndex(board, id)];
}

function findCard(board: Board, id: string): { column: Column; card: Card; index: number } {
  for (const column of board.columns) {
    const index = column.cards.findIndex((c) => c.id === id);
    if (index >= 0) return { column, card: column.cards[index], index };
  }
  throw new Error(`Card not found: ${id}`);
}
