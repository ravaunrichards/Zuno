'use strict';
/**
 * PayPal payment state machine. Transitions are enforced server-side; a browser
 * redirect, button click, client callback or UNSIGNED webhook is never accepted
 * as proof of completion. Only a verified capture (status 'captured') credits
 * coins (see coins.creditCoinsFromCapture).
 */
const STATES = Object.freeze([
  'created', 'pending_approval', 'approved', 'captured', 'failed',
  'cancelled', 'refunded', 'partially_refunded', 'reversed',
]);

const TRANSITIONS = Object.freeze({
  created: ['pending_approval', 'cancelled', 'failed'],
  pending_approval: ['approved', 'cancelled', 'failed'],
  approved: ['captured', 'failed', 'cancelled'],
  captured: ['refunded', 'partially_refunded', 'reversed'],
  failed: [],
  cancelled: [],
  refunded: [],
  partially_refunded: ['refunded', 'reversed'],
  reversed: [],
});

function canTransition(from, to) {
  return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

function transition(from, to) {
  if (!STATES.includes(from)) throw new Error(`unknown from-state: ${from}`);
  if (!STATES.includes(to)) throw new Error(`unknown to-state: ${to}`);
  if (!canTransition(from, to)) {
    const err = new Error(`illegal transition ${from} -> ${to}`);
    err.code = 'ILLEGAL_TRANSITION';
    throw err;
  }
  return to;
}

function isTerminal(state) {
  return TRANSITIONS[state] && TRANSITIONS[state].length === 0;
}

module.exports = { STATES, TRANSITIONS, canTransition, transition, isTerminal };
