import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../examples/reading-log/store.js', import.meta.url), 'utf8');

function fixture() {
  const data = new Map();
  let failWrites = false;
  const window = { localStorage: {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (failWrites) throw new Error('synthetic storage failure');
      data.set(key, value);
    },
  } };
  vm.runInNewContext(source, { window });
  return { store: window.BookStore, fail: (value) => { failWrites = value; } };
}

test('failed add stores nothing and reports failure; retry succeeds', () => {
  const { store, fail } = fixture();
  fail(true);
  assert.equal(store.add({ title: 'New book' }), null);
  assert.equal(store.all().length, 0);
  fail(false);
  assert.equal(store.add({ title: 'New book' }).title, 'New book');
  assert.equal(store.all().length, 1);
});

test('failed update preserves original data and reports failure; retry succeeds', () => {
  const { store, fail } = fixture();
  const book = store.add({ title: 'Original', status: 'reading' });
  fail(true);
  assert.equal(store.update(book.id, { title: 'Changed', status: 'finished', finishedDate: '2026-11-01' }), null);
  assert.equal(store.get(book.id).title, 'Original');
  fail(false);
  assert.equal(store.update(book.id, { title: 'Changed', status: 'finished', finishedDate: '2026-11-01' }).title, 'Changed');
  assert.equal(store.get(book.id).finishedDate, '2026-11-01');
});

test('failed delete preserves the book and reports failure; retry succeeds', () => {
  const { store, fail } = fixture();
  const book = store.add({ title: 'Keep on failure' });
  fail(true);
  assert.equal(store.remove(book.id), false);
  assert.equal(store.get(book.id).title, 'Keep on failure');
  fail(false);
  assert.equal(store.remove(book.id), true);
  assert.equal(store.get(book.id), null);
});
