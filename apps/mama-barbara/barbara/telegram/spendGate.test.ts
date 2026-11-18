// Run with: node --test spendGate.test.ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createSpendGate,
  GROUP_MEMBER_COOLDOWN_MS,
  implicitGroupPolicy,
} from './spendGate.ts'

test('implicit groups are owner-only: a non-owner member must be allowed explicitly', () => {
  const policy = implicitGroupPolicy(['412587349', '628194073'], undefined)
  assert.equal(policy.requireMention, true)
  assert.deepEqual(policy.allowFrom, ['412587349', '628194073'])
  // Pre-fix behavior was allowFrom: [] — with the gate's
  // `allowFrom.length > 0` check, an empty array means *every* member passes.
  assert.ok(policy.allowFrom.length > 0)
})

test('implicit group policy honors groupRequireMention: false', () => {
  const policy = implicitGroupPolicy(['1'], false)
  assert.equal(policy.requireMention, false)
  assert.deepEqual(policy.allowFrom, ['1'])
})

test('owners and allowlisted senders are never cooldown-limited', () => {
  const gate = createSpendGate(60_000)
  const t0 = 1_000_000
  assert.equal(gate.allow('1', 'owner', t0), true)
  assert.equal(gate.allow('1', 'owner', t0 + 1), true)
  assert.equal(gate.allow('2', 'allowed', t0), true)
  assert.equal(gate.allow('2', 'allowed', t0 + 1), true)
})

test('a group member is cooldown-limited per sender (mention storm cannot drain the box)', () => {
  const gate = createSpendGate(60_000)
  const t0 = 1_000_000
  assert.equal(gate.allow('31', 'group member', t0), true)
  // A second mention one second later is dropped.
  assert.equal(gate.allow('31', 'group member', t0 + 1_000), false)
  // After the full cooldown the member's next mention is delivered again.
  assert.equal(gate.allow('31', 'group member', t0 + 60_000), true)
  // The gate is per sender: a second member is unaffected.
  assert.equal(gate.allow('32', 'group member', t0 + 1_000), true)
})

test('retryAfterMs reports the cooldown remainder', () => {
  const gate = createSpendGate(60_000)
  const t0 = 1_000_000
  gate.allow('31', 'group member', t0)
  assert.equal(gate.retryAfterMs('31', t0 + 10_000), 50_000)
  assert.equal(gate.retryAfterMs('31', t0 + 90_000), 0)
  assert.equal(gate.retryAfterMs('unknown', t0), 0)
})

test('default cooldown constant is the documented 60s', () => {
  assert.equal(GROUP_MEMBER_COOLDOWN_MS, 60_000)
})
