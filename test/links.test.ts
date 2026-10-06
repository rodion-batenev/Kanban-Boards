import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLink, isExternal, parseTarget, tokenize } from '../src/links.ts';

test('tokenize markdown links and bare urls', () => {
  assert.deepEqual(tokenize('see [spec](docs/spec.md) and https://example.com/a?b=1.'), [
    { text: 'see ' },
    { text: 'spec', target: 'docs/spec.md' },
    { text: ' and ' },
    { text: 'https://example.com/a?b=1', target: 'https://example.com/a?b=1' },
    { text: '.' },
  ]);
  assert.deepEqual(tokenize('[a b](<my file (1).md>)'), [{ text: 'a b', target: 'my file (1).md' }]);
  assert.deepEqual(tokenize('no links [here]'), [{ text: 'no links [here]' }]);
});

test('formatLink round-trips through tokenize', () => {
  for (const target of ['src/a.ts', 'my file (1).md', '../x.ts:12']) {
    assert.deepEqual(tokenize(formatLink('x', target)), [{ text: 'x', target }]);
  }
});

test('parseTarget line suffixes', () => {
  assert.deepEqual(parseTarget('src/a.ts'), { path: 'src/a.ts', line: undefined, column: undefined });
  assert.deepEqual(parseTarget('src/a.ts:12'), { path: 'src/a.ts', line: 12, column: undefined });
  assert.deepEqual(parseTarget('src/a.ts:12:5'), { path: 'src/a.ts', line: 12, column: 5 });
  assert.deepEqual(parseTarget('src/a.ts#L7-L9'), { path: 'src/a.ts', line: 7, column: undefined });
  assert.equal(parseTarget('C:\\x\\a.ts').path, 'C:\\x\\a.ts');
});

test('isExternal', () => {
  assert.ok(isExternal('https://x.dev'));
  assert.ok(isExternal('mailto:a@b.c'));
  assert.ok(!isExternal('file:///tmp/a'));
  assert.ok(!isExternal('C:\\a.ts'));
  assert.ok(!isExternal('src/a.ts'));
});
