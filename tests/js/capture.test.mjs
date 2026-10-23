// Quick capture parsing, due dates, Today.md lines and sections, and reading emails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, withState } from './load_app.mjs';

const app = loadApp();
const today = app.fmt(new Date()), dow = new Date().getDay();
withState(app, { projects: [{ id: 'a', network: '4001234', activity: '0010', name: 'Bridge rehab – design', budget: '' },
  { id: 'b', network: '4005678', activity: '0020', name: 'Runway lighting', budget: '' }] });

test('due dates', () => {
  assert.equal(app.parseDue('today'), today);
  assert.equal(app.parseDue('tomorrow'), app.addDays(today, 1));
  assert.equal(app.parseDue('fri'), app.addDays(today, (5 - dow + 7) % 7 || 7));  // the next Friday, never today
  assert.equal(app.parseDue('+3d'), app.addDays(today, 3));
  assert.equal(app.parseDue('2w'), app.addDays(today, 14));
  assert.equal(app.parseDue('2026-11-02'), '2026-11-02');
  assert.equal(app.parseDue('soonish'), '');
});

test('capture kinds, project tags and due dates', () => {
  let c = app.parseCapture('Call county about the culvert #bridge');
  assert.deepEqual([c.kind, c.project.id, c.clean], ['note', 'a', 'Call county about the culvert']);
  c = app.parseCapture('[] send drainage memo due:2026-10-30 #runway');
  assert.deepEqual([c.kind, c.due, c.project.id, c.clean], ['todo', '2026-10-30', 'b', 'send drainage memo']);
  c = app.parseCapture('@task Review 60% plans due:2026-11-02 #4001234');
  assert.deepEqual([c.kind, c.due, c.project.id], ['task', '2026-11-02', 'a']);   // tags can match the network number
  c = app.parseCapture('@reply Bob Smith – budget question');
  assert.deepEqual([c.kind, c.from, c.subject], ['reply', 'Bob Smith', 'budget question']);
  c = app.parseCapture('@reply Maria: site visit');
  assert.deepEqual([c.from, c.subject], ['Maria', 'site visit']);
  assert.equal(app.parseCapture('@reply check the invoice').from, '');
});

test('lines written to Today.md', () => {
  assert.equal(app.captureLine(app.parseCapture('[] send memo due:2026-11-02')), '- [ ] send memo 📅 2026-11-02');
  assert.equal(app.captureLine(app.parseCapture('@reply Bob – budget due:2026-11-02'), ' · in Follow-ups'), '- [ ] Reply to Bob: budget 📅 2026-11-02 · in Follow-ups');
  assert.match(app.captureLine(app.parseCapture('a thought')), /^- \d\d:\d\d a thought$/);
});

test('Today.md: file name and one heading per day', () => {
  assert.equal(app.captureFile(), 'Today.md');
  assert.equal(app.dayHeading(new Date(2026, 9, 23)), 'Friday, October 23, 2026');
  const note = '# Today\n\n## Saturday, October 24, 2026\n- b\n\n## Friday, October 23, 2026\n- a\n- [ ] c\n';
  assert.equal(app.sectionOf(note, 'Friday, October 23, 2026').trim(), '- a\n- [ ] c');
  assert.equal(app.sectionOf(note, 'Saturday, October 24, 2026').trim(), '- b');
});

test('reading a .eml: multipart, quoted-printable and encoded headers', () => {
  const eml = ['From: =?UTF-8?Q?Jos=C3=A9_Mu=C3=B1oz?= <jose@county.gov>', 'Subject: =?UTF-8?B?RHJhaW5hZ2UgbWVtbyDigJMgZHVlIGRhdGU=?=',
    'Date: Thu, 22 Oct 2026 15:14:00 -0400', 'Content-Type: multipart/alternative; boundary="b1"', '', '--b1',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: quoted-printable', '',
    'Can you send the memo by Friday? =E2=80=93 Jos=C3=A9', '--b1', 'Content-Type: text/html', '', '<p>Hi</p>', '--b1--', ''].join('\r\n');
  const e = app.parseEml(new TextDecoder('latin1').decode(new TextEncoder().encode(eml)));
  assert.deepEqual([e.from, e.subject, e.received, e.body], ['José Muñoz <jose@county.gov>', 'Drainage memo – due date', '2026-10-22', 'Can you send the memo by Friday? – José']);
});

test('reading a base64 .eml', () => {
  const eml = ['From: bob@x.com', 'Subject: Budget', 'Date: Fri, 23 Oct 2026 08:00:00 +0000', 'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64', '', Buffer.from('Need the numbers.\nThanks').toString('base64')].join('\n');
  const e = app.parseEml(eml);
  assert.deepEqual([e.from, e.body], ['bob@x.com', 'Need the numbers.\nThanks']);
});

test('reading an email pasted from Outlook', () => {
  const p = app.parsePastedEmail('From: Maria Lopez <maria@agency.gov>\nSent: Thursday, October 22, 2026 3:14 PM\nTo: Me\nSubject: RE: Site visit\n\nCan we move it to Tuesday?\n\nMaria');
  assert.deepEqual([p.from, p.subject, p.received, p.body], ['Maria Lopez <maria@agency.gov>', 'RE: Site visit', '2026-10-22', 'Can we move it to Tuesday?\n\nMaria']);
  assert.equal(app.parsePastedEmail('just text').body, 'just text');
});
