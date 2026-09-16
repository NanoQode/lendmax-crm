import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeFormats, DOCUMENT_FORMATS, fileMatchesFormats, PURPOSES, purposeKey, SUGGESTED,
} from '../src/domain/required-documents.ts';
import { checkUpload } from '../src/domain/uploads.ts';

test('every format a document can ask for is one the uploader accepts', () => {
  for (const f of DOCUMENT_FORMATS) {
    for (const ext of f.extensions) {
      const result = checkUpload(`statement${ext}`, f.mime, 1000);
      assert.equal(result.ok, true, `${f.key}: ${ext} as ${f.mime} is refused by storage`);
    }
  }
});

test('the four purposes are the portal’s four', () => {
  assert.deepEqual(PURPOSES.map((p) => p.portal), ['Purchase', 'Renew', 'Refinance', 'Home Equity Line']);
});

test('a purpose is recognised however it arrives, and an unknown one is not guessed', () => {
  assert.equal(purposeKey('Home Equity Line'), 'home_equity_line');
  assert.equal(purposeKey('home_equity_line'), 'home_equity_line');
  assert.equal(purposeKey(' purchase '), 'purchase');
  assert.equal(purposeKey('Construction'), null);
  assert.equal(purposeKey(null), null);
});

test('a file matches the formats asked for, by extension, case-insensitively', () => {
  assert.equal(fileMatchesFormats('PayStub.PDF', ['pdf']), true);
  assert.equal(fileMatchesFormats('scan.jpeg', ['jpg']), false, 'jpg and jpeg are ticked separately');
  assert.equal(fileMatchesFormats('scan.tif', ['tiff']), true);
  assert.equal(fileMatchesFormats('letter.docx', ['pdf', 'png']), false);
});

test('formats read as a sentence', () => {
  assert.equal(describeFormats(['pdf']), 'PDF');
  assert.equal(describeFormats(['pdf', 'jpg', 'png']), 'PDF, JPG or PNG');
});

test('every suggestion is usable: formats known, names unique per purpose', () => {
  const known = new Set(DOCUMENT_FORMATS.map((f) => f.key));
  for (const [purpose, list] of Object.entries(SUGGESTED)) {
    const names = list.map((s) => s.name.toLowerCase());
    assert.equal(new Set(names).size, names.length, `${purpose} has a duplicate`);
    for (const s of list) {
      assert.ok(s.formats.length > 0 && s.formats.every((f) => known.has(f)), `${purpose}: ${s.name}`);
    }
  }
});
