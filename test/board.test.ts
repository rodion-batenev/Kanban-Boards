import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, createBoard, parseBoard, serializeBoard } from '../src/board.ts';
import type { Board } from '../src/board.ts';

function sample(): Board {
  return {
    version: 1,
    title: 'T',
    columns: [
      { id: 'a', title: 'A', cards: [{ id: 'k1', title: 'one' }, { id: 'k2', title: 'two' }] },
      { id: 'b', title: 'B', cards: [{ id: 'k3', title: 'three' }] },
      { id: 'c', title: 'C', cards: [] },
    ],
  };
}

const cardIds = (b: Board, col: number) => b.columns[col].cards.map((c) => c.id);

test('parseBoard accepts valid board and keeps unknown fields', () => {
  const r = parseBoard(JSON.stringify({ ...sample(), extra: 42 }));
  assert.ok(r.ok);
  assert.equal((r.board as unknown as { extra: number }).extra, 42);
});

test('parseBoard reports invalid JSON', () => {
  const r = parseBoard('{');
  assert.ok(!r.ok);
  assert.match(r.error, /Invalid JSON/);
});

test('parseBoard reports structural errors with path', () => {
  const b = sample() as unknown as { columns: { cards: unknown[] }[] };
  b.columns[1].cards[0] = { id: 'k3' };
  const r = parseBoard(JSON.stringify(b));
  assert.ok(!r.ok);
  assert.equal(r.error, '$.columns[1].cards[0].title: expected a string');
});

test('parseBoard rejects duplicate ids', () => {
  const b = sample();
  b.columns[2].id = 'k1';
  const r = parseBoard(JSON.stringify(b));
  assert.ok(!r.ok);
  assert.match(r.error, /duplicate id "k1"/);
});

test('createBoard round-trips', () => {
  const r = parseBoard(serializeBoard(createBoard('X')));
  assert.ok(r.ok);
  assert.deepEqual(r.board.columns.map((c) => c.title), ['Todo', 'In Progress', 'Done']);
});

test('applyOp does not mutate input', () => {
  const b = sample();
  const before = JSON.stringify(b);
  applyOp(b, { type: 'deleteColumn', columnId: 'a' });
  assert.equal(JSON.stringify(b), before);
});

test('column ops', () => {
  let b = applyOp(sample(), { type: 'addColumn', title: '  D  ' });
  assert.equal(b.columns[3].title, 'D');
  assert.match(b.columns[3].id, /^c_/);

  b = applyOp(b, { type: 'renameColumn', columnId: 'a', title: 'AA' });
  assert.equal(b.columns[0].title, 'AA');

  b = applyOp(b, { type: 'moveColumn', columnId: 'a', toIndex: 2 });
  assert.deepEqual(b.columns.map((c) => c.id).slice(0, 3), ['b', 'c', 'a']);

  b = applyOp(b, { type: 'deleteColumn', columnId: 'c' });
  assert.deepEqual(b.columns.map((c) => c.id).slice(0, 2), ['b', 'a']);

  assert.throws(() => applyOp(b, { type: 'renameColumn', columnId: 'a', title: ' ' }), /empty/);
  assert.throws(() => applyOp(b, { type: 'deleteColumn', columnId: 'nope' }), /not found/);
});

test('card ops', () => {
  let b = applyOp(sample(), { type: 'addCard', columnId: 'c', title: 'new' });
  assert.equal(b.columns[2].cards[0].title, 'new');

  b = applyOp(b, { type: 'updateCard', cardId: 'k1', title: 'uno', description: ' desc ' });
  assert.deepEqual(b.columns[0].cards[0], { id: 'k1', title: 'uno', description: 'desc' });

  b = applyOp(b, { type: 'updateCard', cardId: 'k1', description: '' });
  assert.equal('description' in b.columns[0].cards[0], false);

  b = applyOp(b, { type: 'deleteCard', cardId: 'k2' });
  assert.deepEqual(cardIds(b, 0), ['k1']);

  b = applyOp(b, { type: 'addCard', columnId: 'a', title: 'top', toIndex: 0 });
  assert.equal(b.columns[0].cards[0].title, 'top');
});

test('card color', () => {
  let b = applyOp(sample(), { type: 'updateCard', cardId: 'k1', color: 'red' });
  assert.equal(b.columns[0].cards[0].color, 'red');

  b = applyOp(b, { type: 'updateCard', cardId: 'k1', title: 'uno' });
  assert.equal(b.columns[0].cards[0].color, 'red');

  b = applyOp(b, { type: 'updateCard', cardId: 'k1', color: '' });
  assert.equal('color' in b.columns[0].cards[0], false);

  assert.throws(() => applyOp(b, { type: 'updateCard', cardId: 'k1', color: 'pink' as 'red' }), /Unknown color/);

  const bad = sample() as unknown as { columns: { cards: Record<string, unknown>[] }[] };
  bad.columns[0].cards[1].color = 'pink';
  const r = parseBoard(JSON.stringify(bad));
  assert.ok(!r.ok);
  assert.match(r.error, /^\$\.columns\[0\]\.cards\[1\]\.color: expected one of red,/);
});

test('moveCard within and across columns', () => {
  let b = applyOp(sample(), { type: 'moveCard', cardId: 'k1', toColumnId: 'a', toIndex: 1 });
  assert.deepEqual(cardIds(b, 0), ['k2', 'k1']);

  b = applyOp(b, { type: 'moveCard', cardId: 'k3', toColumnId: 'a', toIndex: 0 });
  assert.deepEqual(cardIds(b, 0), ['k3', 'k2', 'k1']);
  assert.deepEqual(cardIds(b, 1), []);

  b = applyOp(b, { type: 'moveCard', cardId: 'k2', toColumnId: 'c', toIndex: 99 });
  assert.deepEqual(cardIds(b, 2), ['k2']);
});
