/**
 * TinG Orchestrator v2: pure, fail-closed task-selection and claim protocol.
 * No network, credentials, GitHub/Notion mutations, code dispatch or production access.
 * A durable adapter MUST implement atomic compareAndSwap before live dispatch is allowed.
 */
export const STATES = Object.freeze({
  READY: 'ready', CLAIMED: 'claimed', REVIEW: 'review', DONE: 'done', BLOCKED: 'blocked'
});
const priority = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3 });
const validId = id => typeof id === 'string' && /^[A-Z][A-Z0-9-]{2,63}$/.test(id);
function assertSnapshot(tasks) {
  if (!Array.isArray(tasks)) throw new Error('invalid snapshot');
  const seen = new Set();
  for (const t of tasks) {
    if (!t || !validId(t.id) || seen.has(t.id) || !Object.values(STATES).includes(t.state) ||
        !Array.isArray(t.dependencies) || !['P0','P1','P2','P3'].includes(t.priority) ||
        !['low','medium','high'].includes(t.risk) || typeof t.version !== 'number' ||
        !Number.isSafeInteger(t.version) || t.version < 0 || typeof t.approvalRequired !== 'boolean') {
      throw new Error('invalid or duplicate task record');
    }
    seen.add(t.id);
  }
  for (const t of tasks) {
    if (t.dependencies.some(dep => !validId(dep) || !seen.has(dep) || dep === t.id)) {
      throw new Error('unresolved dependency');
    }
  }
}
export function selectNext(tasks) {
  assertSnapshot(tasks);
  const byId = new Map(tasks.map(t => [t.id, t]));
  // Only explicitly low-risk, approval-free work enters automatic selection.
  // Unknown fields, unclear ownership, or unfinished dependencies must stop.
  const ready = tasks.filter(t =>
    t.state === STATES.READY && t.risk === 'low' && !t.approvalRequired &&
    (t.owner === null || t.owner === undefined) &&
    t.dependencies.every(id => byId.get(id).state === STATES.DONE)
  );
  ready.sort((a,b) => priority[a.priority] - priority[b.priority] || a.id.localeCompare(b.id));
  return ready.length ? { id: ready[0].id, version: ready[0].version } : null;
}
export async function claimSelected(store, snapshot, workerId) {
  if (!validId(workerId)) throw new Error('invalid worker identity');
  const candidate = selectNext(snapshot);
  if (!candidate) return { status: 'nothing_eligible' };
  // A production adapter must compare BOTH version and expected state
  // atomically in one durable transaction, otherwise duplicate claims are possible.
  const result = await store.compareAndSwap({
    id: candidate.id, expectedVersion: candidate.version,
    expectedState: STATES.READY, expectedOwner: null,
    nextState: STATES.CLAIMED, nextOwner: workerId
  });
  if (result !== true) return { status: 'conflict', id: candidate.id };
  return { status: 'claimed', id: candidate.id, owner: workerId };
}
export async function handoffToReview(store, { id, version, workerId, evidenceUrl }) {
  if (!validId(id) || !validId(workerId) ||
      !Number.isSafeInteger(version) || version < 0 ||
      typeof evidenceUrl !== 'string' || !/^https:\/\/(github\.com|app\.notion\.com)\//.test(evidenceUrl)) {
    throw new Error('invalid handoff');
  }
  const ok = await store.compareAndSwap({
    id, expectedVersion: version, expectedState: STATES.CLAIMED,
    expectedOwner: workerId, nextState: STATES.REVIEW,
    nextOwner: workerId, evidenceUrl
  });
  return ok === true ? { status: 'review_required', id } : { status: 'conflict', id };
}
