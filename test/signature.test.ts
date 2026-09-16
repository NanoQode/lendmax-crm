import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSignature, STANDARD_SIGNATURE, textToHtml } from '../src/domain/signature.ts';

const priya = {
  name: 'Priya Sandhu', title: 'Mortgage Agent Level 2', licence_number: 'M23001234',
  licence_province: 'ON', mobile_phone: '+16475550110', email: 'priya@lendmax.ca',
  organization_name: 'Lendmax', booking_url: 'https://cal.example.com/priya',
};

test('the standard signature is built from the profile, and skips what is missing', () => {
  const { text, problems } = renderSignature(STANDARD_SIGNATURE, priya);
  assert.deepEqual(problems, []);
  assert.equal(text, [
    'Priya Sandhu', 'Mortgage Agent Level 2', 'Lendmax', 'Licence M23001234 (ON)',
    'Mobile (647) 555-0110', 'priya@lendmax.ca', 'Book a time with me: https://cal.example.com/priya',
  ].join('\n'), 'no "Direct" or "Office" line — there is no number for them');
});

test('a phone from the profile is a tap-to-call link; typed links are linked', () => {
  const { html } = renderSignature('Call {mobile}\nwww: https://lendmax.ca/rates\n{email}', priya);
  assert.match(html, /href="tel:\+16475550110"/);
  assert.match(html, /href="https:\/\/lendmax\.ca\/rates"/);
  assert.match(html, /href="mailto:priya@lendmax\.ca"/);
});

test('bold is the only formatting, and it is stripped from the text part', () => {
  const { html, text } = renderSignature('**{name}** | {title}', priya);
  assert.match(html, /<strong>Priya Sandhu<\/strong>/);
  assert.equal(text, 'Priya Sandhu | Mortgage Agent Level 2');
});

test('whatever a person types is escaped — a signature cannot inject markup', () => {
  const { html } = renderSignature('<img src=x onerror=alert(1)> "quoted" & co', priya);
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &quot;quoted&quot; &amp; co/);
});

test('profile values are escaped too', () => {
  const { html } = renderSignature('{title}', { ...priya, title: '<b>Boss</b>' });
  assert.equal(html.includes('<b>'), false);
});

test('an unknown field is named, with the list of real ones', () => {
  const { problems } = renderSignature('{name}\n{fax}', priya);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /\{fax\} is not a field/);
  assert.match(problems[0]!, /\{booking_link\}/);
});

test('blank lines are spacing, never doubled or trailing', () => {
  const { text } = renderSignature('{name}\n\n\n\n{title}\n\n', priya);
  assert.equal(text, 'Priya Sandhu\n\nMortgage Agent Level 2');
});

test('too long is refused rather than truncated', () => {
  assert.equal(renderSignature('x'.repeat(1001), priya).problems.length, 1);
  assert.equal(renderSignature(Array.from({ length: 16 }, (_, i) => `line ${i}`).join('\n'), priya).problems.length, 1);
});

test('a text body becomes safe HTML paragraphs', () => {
  assert.equal(textToHtml('Hi <Sam>,\n\nSee https://x.ca\nThanks'),
    '<p style="margin:0 0 12px">Hi &lt;Sam&gt;,</p>'
    + '<p style="margin:0 0 12px">See <a href="https://x.ca">https://x.ca</a><br>Thanks</p>');
});
