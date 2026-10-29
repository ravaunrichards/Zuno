'use strict';
/**
 * LIVE guest-request / co-host workflow (server-authoritative state machine).
 * Max 8 concurrent participants (1 host + up to 7 guests) unless an explicitly
 * documented configuration overrides it. The host moderates; the server issues
 * LiveKit tokens only after acceptance.
 */
const MAX_PARTICIPANTS = 8;
const REQUEST_TTL_MS = 2 * 60 * 1000;

const TRANSITIONS = {
  pending: ['accepted', 'rejected', 'expired', 'cancelled'],
  accepted: [], rejected: [], expired: [], cancelled: [],
};

class LiveRoom {
  constructor(id, hostId) {
    this.id = id; this.hostId = hostId;
    this.state = 'live';
    this.participants = new Map([[hostId, 'host']]);
    this.requests = new Map(); // requesterId -> {state, at}
  }
  requestGuest(requesterId, now = Date.now()) {
    if (this.state !== 'live') return { ok: false, code: 'ROOM_NOT_LIVE' };
    if (requesterId === this.hostId) return { ok: false, code: 'HOST_CANNOT_REQUEST' };
    const existing = this.requests.get(requesterId);
    if (existing && existing.state === 'pending') return { ok: false, code: 'ALREADY_REQUESTED' };
    this.requests.set(requesterId, { state: 'pending', at: now });
    return { ok: true, state: 'pending' };
  }
  _resolve(requesterId, to, now = Date.now()) {
    const r = this.requests.get(requesterId);
    if (!r) return { ok: false, code: 'NO_REQUEST' };
    if (r.state === 'pending' && now - r.at > REQUEST_TTL_MS) { r.state = 'expired'; return { ok: false, code: 'EXPIRED' }; }
    if (!TRANSITIONS[r.state].includes(to)) return { ok: false, code: 'ILLEGAL_TRANSITION' };
    r.state = to;
    return { ok: true, state: to };
  }
  accept(hostId, requesterId, now = Date.now()) {
    if (hostId !== this.hostId) return { ok: false, code: 'NOT_HOST' };
    if (this.participants.size >= MAX_PARTICIPANTS) return { ok: false, code: 'ROOM_FULL' };
    const r = this._resolve(requesterId, 'accepted', now);
    if (!r.ok) return r;
    this.participants.set(requesterId, 'guest');
    return { ok: true, state: 'accepted', issueToken: true };
  }
  reject(hostId, requesterId, now = Date.now()) {
    if (hostId !== this.hostId) return { ok: false, code: 'NOT_HOST' };
    return this._resolve(requesterId, 'rejected', now);
  }
  removeGuest(hostId, guestId) {
    if (hostId !== this.hostId) return { ok: false, code: 'NOT_HOST' };
    if (this.participants.get(guestId) !== 'guest') return { ok: false, code: 'NOT_A_GUEST' };
    this.participants.delete(guestId);
    return { ok: true };
  }
  end(hostId) {
    if (hostId !== this.hostId) return { ok: false, code: 'NOT_HOST' };
    this.state = 'ended'; this.participants.clear();
    return { ok: true, state: 'ended' };
  }
}

module.exports = { LiveRoom, MAX_PARTICIPANTS, REQUEST_TTL_MS };
