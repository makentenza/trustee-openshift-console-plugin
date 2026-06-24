// ---------------------------------------------------------------------------
// Best-effort parser for the Trustee KBS (all-in-one) container log. The KBS
// runs actix-web + the attestation service; its log is a Rust `tracing` stream
// with ANSI colour. We keep only attestation-relevant lines — requests to the
// KBS API (/kbs/...) and attestation-service events — and drop the internet
// scanner noise that hits the (formerly public) endpoint. Heuristic by design.
// ---------------------------------------------------------------------------

export type LogKind = 'attest' | 'resource' | 'kbs-http' | 'as-event' | 'other';

export interface KbsLogEntry {
  timestamp?: string;
  level?: string;
  target?: string;
  message: string;
  kind: LogKind;
  status?: number;
  path?: string;
  clientIp?: string;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, '');

const LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+([^\s:]+):\s*(.*)$/;
const HTTP =
  /(\d{1,3}(?:\.\d{1,3}){3})\s+"(?:GET|POST|PUT|DELETE|PATCH|HEAD|CONNECT)\s+(\S+)[^"]*"\s+(\d{3})/;

/**
 * Parse a KBS log blob into attestation-relevant entries (oldest→newest order
 * preserved). Scanner traffic (any HTTP path not under /kbs/) and the verbose
 * startup config dump / debug lines are dropped.
 */
export const parseKbsLog = (text: string): KbsLogEntry[] => {
  const out: KbsLogEntry[] = [];
  for (const rawLine of text.split('\n')) {
    const line = stripAnsi(rawLine).replace(/\s+$/, '');
    if (!line.trim()) continue;
    const m = LINE.exec(line.trim());
    const timestamp = m?.[1];
    const level = m?.[2];
    const target = m?.[3];
    const message = m?.[4] ?? line.trim();

    const isHttp = (target ?? '').includes('actix_web');
    if (isHttp) {
      const h = HTTP.exec(message);
      const path = h?.[2];
      // Drop everything that isn't a call to the KBS API — that's the scanner noise.
      if (!path || !path.startsWith('/kbs')) continue;
      const status = h ? Number(h[3]) : undefined;
      const kind: LogKind = path.includes('/attest')
        ? 'attest'
        : path.includes('/resource')
          ? 'resource'
          : 'kbs-http';
      out.push({ timestamp, level, target, message, kind, status, path, clientIp: h?.[1] });
      continue;
    }

    if ((target ?? '').startsWith('attestation_service') || (target ?? '').startsWith('kbs')) {
      // Skip the noisy startup config dump and debug/trace chatter.
      if (level === 'DEBUG' || level === 'TRACE') continue;
      if (/^[a-z_]+:\s/.test(message) || /[{}]\s*$/.test(message) || message === '}') continue;
      out.push({ timestamp, level, target, message, kind: 'as-event' });
    }
  }
  return out;
};

/**
 * Is a KBS access-log client a REMOTE confidential workload (in another cluster),
 * rather than one co-located on this cluster?
 *
 * Co-located workloads reach the KBS through the in-cluster Service, so the access
 * log records their own pod IP. Remote spokes reach it through the hub's external
 * Route, so the log records the hub ROUTER pod's IP — which is ALSO a cluster
 * (10.x) address. An earlier "is the IP non-10.x?" test therefore dropped every
 * real spoke, since Route traffic always looks in-cluster. We instead classify by
 * exclusion: a client is remote when it is not loopback and not one of this
 * cluster's confidential-workload pod IPs.
 */
export const isRemoteClient = (ip: string | undefined, localPodIps: ReadonlySet<string>): boolean =>
  !!ip && ip !== '127.0.0.1' && !ip.startsWith('::1') && !localPodIps.has(ip);

export const kindLabel = (e: KbsLogEntry): string => {
  switch (e.kind) {
    case 'attest':
      return 'attest';
    case 'resource':
      return 'resource';
    case 'kbs-http':
      return 'kbs';
    case 'as-event':
      return e.level?.toLowerCase() ?? 'event';
    default:
      return 'log';
  }
};

/** green = released/ok, blue = attest challenge, red = error, grey = info. */
export const kindColor = (e: KbsLogEntry): 'green' | 'blue' | 'red' | 'orange' | 'grey' => {
  if (e.status && e.status >= 400) return 'red';
  if (e.level === 'ERROR') return 'red';
  if (e.level === 'WARN') return 'orange';
  if (e.kind === 'resource' && (!e.status || e.status < 300)) return 'green';
  if (e.kind === 'attest') return 'blue';
  return 'grey';
};
