import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPhone, parsePhone, samePhone, toE164 } from '../src/lib/phone.ts';

test('the same number typed five ways normalises to one string', () => {
  // This is the whole reason the module exists: an inbound SMS from VoIP.ms
  // arrives as +16475551234 and has to find the client who typed the rest.
  const forms = [
    '+16475551234', '16475551234', '6475551234',
    '(647) 555-1234', '647-555-1234', '647.555.1234', ' 647 555 1234 ',
  ];
  for (const f of forms) {
    assert.equal(toE164(f), '+16475551234', `failed for ${JSON.stringify(f)}`);
  }
});

test('an extension is not part of the number', () => {
  // Without this, "416-555-1234 ext 220" becomes a 13-digit number and is
  // rejected — or worse, silently truncated into somebody else's line.
  assert.equal(toE164('416-555-1234 ext 220'), '+14165551234');
  assert.equal(toE164('416-555-1234 x220'), '+14165551234');
  assert.equal(toE164('416-555-1234 extension 220'), '+14165551234');
  assert.equal(toE164('416-555-1234 #220'), '+14165551234');
  // And an extension-looking suffix must not eat a real digit group.
  assert.equal(toE164('1-416-555-1234'), '+14165551234');
});

test('NANP validity is more than counting ten digits', () => {
  assert.equal(parsePhone('0475551234').ok, false, 'area code may not start 0');
  assert.equal(parsePhone('1475551234').ok, false, 'area code may not start 1');
  assert.equal(parsePhone('6470551234').ok, false, 'exchange may not start 0');
  assert.equal(parsePhone('6471551234').ok, false, 'exchange may not start 1');
  assert.equal(parsePhone('9115551234').ok, false, 'N11 is a service code');
  assert.equal(parsePhone('4115551234').ok, false, 'N11 is a service code');
  assert.equal(parsePhone('6475551234').ok, true);
});

test('a rejection says what was wrong with it', () => {
  const short = parsePhone('555-1234');
  assert.equal(short.ok, false);
  assert.match(short.reason!, /expected 10 digits/);
  assert.match(parsePhone('').reason!, /empty/);
  assert.match(parsePhone('not a phone').reason!, /no digits/);
  assert.match(parsePhone('0475551234').reason!, /area code/);
});

test('country code 1 is stripped, other lengths are refused', () => {
  assert.equal(toE164('1 647 555 1234'), '+16475551234');
  assert.equal(toE164('2 647 555 1234'), null, '11 digits not starting with 1');
  assert.equal(toE164('+44 20 7946 0958'), null, 'not North American');
});

test('formatPhone is for people and falls back rather than blanking the field', () => {
  assert.equal(formatPhone('6475551234'), '(647) 555-1234');
  assert.equal(formatPhone('+16475551234'), '(647) 555-1234');
  // A number we cannot parse is still shown — losing what the client gave us
  // is worse than showing it unformatted.
  assert.equal(formatPhone('call the office'), 'call the office');
  assert.equal(formatPhone(null), '');
});

test('samePhone compares numbers, not strings', () => {
  assert.equal(samePhone('(647) 555-1234', '+16475551234'), true);
  assert.equal(samePhone('6475551234', '6475551235'), false);
  assert.equal(samePhone(null, null), false, 'two unknowns are not a match');
  assert.equal(samePhone('garbage', 'garbage'), false, 'two unparseable strings are not a match');
});
