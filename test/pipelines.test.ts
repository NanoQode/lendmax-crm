import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  entryStageOf, pipelineProblems, slugKey, STARTER_STAGES, suggestTarget, uniqueKey,
} from '../src/domain/pipelines.ts';

test('a key is made from a name: lower case, underscores, accents dropped', () => {
  assert.equal(slugKey('Private Lending — Alberta'), 'private_lending_alberta');
  assert.equal(slugKey('Prêt  hypothécaire!'), 'pret_hypothecaire');
  assert.equal(slugKey('***'), 'stage');
});

test('a taken key gets a number, never a collision', () => {
  assert.equal(uniqueKey('renewals_new', new Set()), 'renewals_new');
  assert.equal(uniqueKey('renewals_new', new Set(['renewals_new', 'renewals_new_2'])), 'renewals_new_3');
});

test('an active pipeline needs somewhere to start, to win and to lose', () => {
  assert.deepEqual(pipelineProblems(STARTER_STAGES.map((s) => ({ ...s, active: true }))), []);
  const noWon = pipelineProblems([
    { label: 'New', category: 'open', active: true },
    { label: 'Funded', category: 'won', active: false },
    { label: 'Lost', category: 'lost', active: true },
  ], 'Renewals');
  assert.equal(noWon.length, 1);
  assert.match(noWon[0]!, /Renewals needs at least one active “Won” stage/);
  assert.equal(pipelineProblems([]).length, 3);
});

test('a new file lands on the first active in-progress stage, by position', () => {
  const stages = [
    { key: 'b', category: 'open' as const, active: true, position: 2 },
    { key: 'a', category: 'open' as const, active: false, position: 1 },
    { key: 'w', category: 'won' as const, active: true, position: 0 },
  ];
  assert.equal(entryStageOf(stages)?.key, 'b');
  assert.equal(entryStageOf([{ key: 'w', category: 'won' as const, active: true, position: 1 }]), null);
});

test('files on a stage going away are offered the best match', () => {
  const target = [
    { key: 't_new', label: 'New', category: 'open' as const, active: true, position: 1 },
    { key: 't_app', label: 'Application', category: 'open' as const, active: true, position: 2 },
    { key: 't_won', label: 'Closed', category: 'won' as const, active: true, position: 3 },
    { key: 't_old', label: 'Funded', category: 'won' as const, active: false, position: 4 },
  ];
  assert.equal(suggestTarget({ label: 'application', category: 'open' }, target)?.key, 't_app', 'same name');
  assert.equal(suggestTarget({ label: 'Funded', category: 'won' }, target)?.key, 't_won', 'same meaning, active');
  assert.equal(suggestTarget({ label: 'Nurture', category: 'parked' }, target)?.key, 't_new', 'else where files start');
});
