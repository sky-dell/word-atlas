import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import test from 'node:test';
import { answerOptions, chapterText, collection, exerciseKey, fetchContent, isBook, isChapter, isConfusable, isParaphrase, isReadingArticle, isReadingItem, localAsset, markedText, paraphraseLevels, readPosition, readRecords, readerPreferences, recordExercise, savePosition } from './reader';
import type { ParaphraseItem } from './reader';

const read = (file: string) => JSON.parse(readFileSync(new URL(`../../public/${file}`, import.meta.url), 'utf8'));

test('downloaded public content is complete and conforms to the live contracts', () => {
  const readings = read('atlas/extras/readings/index.json');
  assert.ok(collection('items', isReadingItem)(readings));
  assert.equal(readings.items.length, 732);
  for (const item of readings.items) {
    const article = read(`atlas/extras/readings/${item.id}.json`);
    assert.ok(isReadingArticle(article), item.id);
    assert.equal(article.id, item.id);
    assert.equal(article.paras.length, article.zh.length);
    assert.ok(article.q.length > 0);
  }
  const books = read('books/index.json');
  assert.ok(collection('books', isBook)(books));
  assert.equal(books.books.length, 1);
  assert.equal(books.books[0].chapters.length, 27);
  let recordings = 0;
  for (const b of books.books) for (const c of b.chapters) {
    const chapter = read(`books/${b.id}/ch-${c.n}.json`);
    assert.ok(isChapter(chapter), `${b.id}/${c.n}`);
    assert.equal(chapter.book, b.id);
    assert.equal(chapter.n, c.n);
    for (const p of chapter.paras) for (const key of ['audio', 'audioZh'] as const) if (p[key]) {
      assert.ok(statSync(new URL(`../../public/${p[key]}`, import.meta.url)).size > 100, p[key]);
      recordings++;
    }
  }
  assert.equal(recordings, 1478);
  const para = read('atlas/extras/paraphrase.json'), confuse = read('atlas/extras/confusables.json');
  assert.ok(collection('items', isParaphrase)(para));
  assert.ok(collection('groups', isConfusable)(confuse));
  assert.equal(para.items.length, 3185);
  assert.equal(confuse.groups.length, 226);
  assert.equal(readdirSync(new URL('../../public/atlas/extras/readings/', import.meta.url)).filter(f => f.endsWith('.json')).length, 733);
});

test('reading markup preserves punctuation, casing, unicode, and safe plain text', () => {
  assert.deepEqual(markedText('“A [[book|Books]],” [[read|read]]! <script>'), [
    { text: '“A ' }, { id: 'book', text: 'Books' }, { text: ',” ' }, { id: 'read', text: 'read' }, { text: '! <script>' },
  ]);
  assert.deepEqual(markedText('[[broken]]'), [{ text: '[[broken]]' }]);
  const en = '“Books,” she said.';
  const pieces = chapterText(en, [[1, 6, 'book', 2], [12, 16, 'say', 0]]);
  assert.equal(pieces.map(p => p.text).join(''), en);
  assert.deepEqual(pieces[1], { text: 'Books', id: 'book', level: 2 });
});

test('chapter offsets cannot overlap or exceed the original text', () => {
  const chapter = read('books/the-little-prince/ch-1.json');
  chapter.paras[0].words = [[0, 4, 'test', 0], [2, 6, 'overlap', 0]];
  assert.equal(isChapter(chapter), false);
  chapter.paras[0].words = [[0, 99999, 'overflow', 0]];
  assert.equal(isChapter(chapter), false);
  assert.equal(isReadingArticle({ ...read('atlas/extras/readings/r0001.json'), q: [{ s: 'x', a: 'UNKNOWN', why: 'y' }] }), false);
});

test('levels retain every real question once and never mix difficulty bands', () => {
  const items: ParaphraseItem[] = read('atlas/extras/paraphrase.json').items;
  const levels = paraphraseLevels(items);
  assert.equal(levels.flatMap(l => l.items).length, items.length);
  assert.deepEqual(new Set(levels.flatMap(l => l.items)), new Set(items));
  assert.ok(levels.every((l, i) => l.n === i + 1 && l.items.length <= 8 && l.items.every(q => q.cefr === l.cefr)));
  assert.throws(() => paraphraseLevels(items, 0));
  for (const item of items) {
    const options = answerOptions(item);
    assert.equal(options.filter(o => o === item.ans).length, 1);
    assert.equal(new Set(options).size, options.length);
    assert.deepEqual(answerOptions(item), options);
  }
});

test('all reading and drill paths stay under the local deployment BASE_URL', async () => {
  assert.equal(localAsset('atlas/extras/readings/r0001.json', '/words/'), '/words/atlas/extras/readings/r0001.json');
  assert.equal(localAsset('books/index.json', '/preview'), '/preview/books/index.json');
  assert.throws(() => localAsset('books/../secrets.json'));
  assert.throws(() => localAsset('https://0xlei.tech/words/books/index.json'));
  const original = globalThis.fetch;
  let requested = '';
  globalThis.fetch = async input => { requested = String(input); return new Response(JSON.stringify(read('atlas/extras/readings/r0001.json'))); };
  try {
    assert.equal((await fetchContent('atlas/extras/readings/r0001.json', isReadingArticle)).id, 'r0001');
    assert.equal(requested, '/atlas/extras/readings/r0001.json');
    globalThis.fetch = async () => new Response('<html>fallback</html>', { status: 404 });
    await assert.rejects(fetchContent('books/index.json', collection('books', isBook)));
    globalThis.fetch = async () => new Response('{"items":[]}');
    await assert.rejects(fetchContent('books/index.json', collection('books', isBook)), /数据不完整/);
  } finally { globalThis.fetch = original; }
});

test('independent exercise history retains best score and isolates datasets', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  try {
    recordExercise('open', 'para:2-1', 8, 10);
    recordExercise('open', 'para:2-1', 4, 10);
    const record = readRecords('open')['para:2-1'];
    assert.equal(record.attempts, 2); assert.equal(record.best, .8); assert.equal(record.correct, 4);
    assert.deepEqual(readRecords('private'), {});
    assert.deepEqual([...values.keys()], [exerciseKey('open')]);
    assert.throws(() => recordExercise('open', 'invalid', 2, 1));
    values.set(exerciseKey('open'), '{"corrupt":{"total":1}}');
    assert.deepEqual(readRecords('open'), {});
    values.set('word-atlas:reader:v1', '{"size":999,"bilingual":true}');
    assert.deepEqual(readerPreferences(), { size: 28, bilingual: true, highlight: true, language: 'en', speed: 1 });
    savePosition({ kind: 'books', id: 'the-little-prince', chapter: 4, paragraph: 8 });
    assert.deepEqual(readPosition(), { kind: 'books', id: 'the-little-prince', chapter: 4, paragraph: 8 });
    values.set('word-atlas:reader-position:v1', '{"kind":"books","id":"x","paragraph":-1}');
    assert.equal(readPosition(), null);
    values.set('word-atlas:reader:v1', 'broken json');
    assert.equal(readerPreferences().size, 20);
  } finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});
