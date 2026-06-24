import { isRemoteClient, parseKbsLog } from './kbsLog';

describe('isRemoteClient', () => {
  const localPods = new Set(['10.130.2.33', '10.131.0.7']);

  it('treats a co-located confidential pod IP as local (not remote)', () => {
    expect(isRemoteClient('10.130.2.33', localPods)).toBe(false);
  });

  it('treats loopback as not remote', () => {
    expect(isRemoteClient('127.0.0.1', localPods)).toBe(false);
    expect(isRemoteClient('::1', localPods)).toBe(false);
    expect(isRemoteClient(undefined, localPods)).toBe(false);
  });

  it('treats a cluster ROUTER IP (Route traffic, 10.x but not a local pod) as remote', () => {
    // Regression for the hub-and-spoke bug: spokes reach the KBS through the hub
    // Route, so the access log shows the router's 10.x IP. The old "non-10.x" test
    // wrongly dropped these; they must count as remote.
    expect(isRemoteClient('10.129.0.22', localPods)).toBe(true);
    expect(isRemoteClient('10.128.0.44', localPods)).toBe(true);
  });

  it('treats a genuine external (LoadBalancer) IP as remote', () => {
    expect(isRemoteClient('203.0.113.9', localPods)).toBe(true);
  });
});

describe('parseKbsLog', () => {
  // A real Trustee KBS actix-web access line (timestamp LEVEL target: <ip> "<method> <path>" <status>).
  const log = [
    '2026-06-24T03:56:58.805667Z  INFO actix_web::middleware::logger: 10.129.0.22 "POST /kbs/v0/attest HTTP/1.1" 200 22212 "-" "attestation-agent-kbs-client/0.1.0" 2.3',
    '2026-06-24T04:03:07.165864Z  INFO actix_web::middleware::logger: 10.128.0.44 "GET /kbs/v0/resource/default/maksecret/password HTTP/1.1" 200 418 "-" "x" 0.001',
    '2026-06-24T04:03:08.000000Z  INFO actix_web::middleware::logger: 8.8.8.8 "GET /robots.txt HTTP/1.1" 404 0 "-" "scanner" 0.0',
  ].join('\n');

  it('extracts attest/resource entries with client IP, path and status; drops non-/kbs noise', () => {
    const entries = parseKbsLog(log);
    const attest = entries.find((e) => e.kind === 'attest');
    const resource = entries.find((e) => e.kind === 'resource');
    expect(attest).toMatchObject({ clientIp: '10.129.0.22', status: 200, path: '/kbs/v0/attest' });
    expect(resource).toMatchObject({
      clientIp: '10.128.0.44',
      status: 200,
      path: '/kbs/v0/resource/default/maksecret/password',
    });
    // The scanner hit (/robots.txt, not under /kbs) is dropped.
    expect(entries.some((e) => e.path === '/robots.txt')).toBe(false);
  });
});
