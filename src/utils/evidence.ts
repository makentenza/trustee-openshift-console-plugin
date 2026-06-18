// ---------------------------------------------------------------------------
// Attestation evidence record — the shared contract between the producers
// (the on-demand probe Job and the in-guest evidence sidecar) and the reader
// (the Attestation status overview). Both write a `attestation-evidence-<pod>`
// ConfigMap labelled trustee.attestation/evidence=true holding evidence.json.
//
// The producer (the CoCo plugin / sidecar) and this reader version independently
// (two operators), so we tolerate a missing or older `schema` stamp on read and
// only flag a NEWER one we don't understand. See AGENTS.md cross-plugin contracts.
// ---------------------------------------------------------------------------
import { SHARED_CONFIGMAP_SCHEMA_VERSION } from '../k8s/resources';

export interface EvidenceRecord {
  /** Cross-plugin contract version. Absent ⇒ pre-versioned ⇒ treated as "1". */
  schema?: string;
  /** "probe" (on-demand Job) or "sidecar" (continuous, in-guest). */
  source?: string;
  timestamp?: string;
  cluster?: string | null;
  workload?: {
    namespace?: string;
    name?: string;
    uid?: string;
    node?: string;
    runtimeClassName?: string;
    phase?: string;
    hasInitData?: boolean;
    initdataSha256?: string | null;
  };
  trustee?: { kbsEndpoint?: string | null };
  probe?: {
    method?: string;
    cdhPath?: string;
    /** HTTP status from the in-guest CDH fetch ("200"/"404"/"401"; "000" if unreachable). */
    httpStatus?: string;
    execExitCode?: number;
    response?: string;
    error?: string;
  };
  /** The EAR attestation token (JWT), when the producer could fetch one. */
  token?: string;
  verdict?: 'passed' | 'failed' | 'inconclusive';
}

export const parseEvidence = (raw?: string): EvidenceRecord | undefined => {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as EvidenceRecord;
  } catch {
    return undefined;
  }
};

/** A record's effective schema version (missing/blank ⇒ "1", the pre-stamp baseline). */
export const evidenceSchemaVersion = (e?: EvidenceRecord): string => {
  const v = (e?.schema ?? '').trim();
  return v === '' ? '1' : v;
};

/**
 * Can this reader understand the record? We render any version up to and including
 * the one we know (SHARED_CONFIGMAP_SCHEMA_VERSION); a NEWER major produced by a
 * newer producer operator is flagged so the UI can warn instead of misreading.
 * Non-numeric versions are treated as understood (best effort, never block).
 */
export const isEvidenceSchemaSupported = (
  e?: EvidenceRecord,
  knownVersion: string = SHARED_CONFIGMAP_SCHEMA_VERSION,
): boolean => {
  const got = Number.parseInt(evidenceSchemaVersion(e), 10);
  const known = Number.parseInt(knownVersion, 10);
  if (Number.isNaN(got) || Number.isNaN(known)) return true;
  return got <= known;
};

/** `<namespace>/<name>` key used to match an evidence record to a workload. */
export const evidenceKey = (e?: EvidenceRecord): string | undefined =>
  e?.workload?.namespace && e?.workload?.name
    ? `${e.workload.namespace}/${e.workload.name}`
    : undefined;

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

const base64UrlDecode = (segment: string): string => {
  const padded = segment + '='.repeat((4 - (segment.length % 4)) % 4);
  const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  // atob is a browser global (the console runs in the browser).
  const binary = atob(b64);
  try {
    return decodeURIComponent(
      binary
        .split('')
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    );
  } catch {
    return binary;
  }
};

/** Decode a JWT's header + payload without verifying the signature. */
export const decodeJwt = (token?: string): DecodedJwt | undefined => {
  if (!token) return undefined;
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    return {
      header: JSON.parse(base64UrlDecode(parts[0])) as Record<string, unknown>,
      payload: JSON.parse(base64UrlDecode(parts[1])) as Record<string, unknown>,
    };
  } catch {
    return undefined;
  }
};

/** Relative "x minutes ago" using a caller-provided now (ms) to stay testable. */
export const relativeTime = (iso?: string, nowMs?: number): string => {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const now = nowMs ?? Date.parse(new Date().toISOString());
  const sec = Math.max(0, Math.round((now - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
};

/** Evidence is "live" when collected within the last 5 minutes. */
export const isLive = (iso?: string, nowMs?: number): boolean => {
  if (!iso) return false;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return false;
  const now = nowMs ?? Date.parse(new Date().toISOString());
  return now - then < 5 * 60 * 1000;
};
