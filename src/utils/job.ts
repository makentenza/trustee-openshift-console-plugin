// ---------------------------------------------------------------------------
// Helpers for reporting a batch/v1 Job's failure to the user. The veritas
// reference-value Job surfaces its real cause only in a Failed condition's
// reason/message; without pulling that up, the UI can only say "it failed".
// ---------------------------------------------------------------------------
import type { JobKind } from '../k8s/types';

/** True once the Job has failed (failed pods or a Failed condition). */
export const jobFailed = (job?: JobKind): boolean =>
  !!job &&
  ((job.status?.failed ?? 0) > 0 ||
    (job.status?.conditions ?? []).some((c) => c.type === 'Failed' && c.status === 'True'));

/**
 * Human-readable failure detail from the Job's Failed condition, e.g.
 * "BackoffLimitExceeded: Job has reached the specified backoff limit". Empty
 * string when the Job hasn't failed or carries no condition message.
 */
export const jobFailureMessage = (job?: JobKind): string => {
  const cond = (job?.status?.conditions ?? []).find(
    (c) => c.type === 'Failed' && c.status === 'True',
  );
  if (!cond) return '';
  return [cond.reason, cond.message].filter((s) => s && s.length > 0).join(': ');
};
