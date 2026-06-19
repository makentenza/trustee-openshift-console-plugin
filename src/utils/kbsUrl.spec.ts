import {
  buildKbsHttpRoute,
  buildKbsPassthroughRoute,
  isEdgeRoute,
  isInClusterKbsUrl,
  kbsConfigEnableTls,
  kbsRouteName,
  kbsTlsModeFromToml,
  warnInClusterForSharing,
} from './kbsUrl';
import { KBS_SERVICE_NAME } from '../k8s/resources';
import type { RouteKind } from '../k8s/types';

describe('isInClusterKbsUrl', () => {
  it('flags the bare Service name', () => {
    expect(isInClusterKbsUrl('kbs-service')).toBe(true);
    expect(isInClusterKbsUrl('http://kbs-service:8080')).toBe(true);
  });

  it('flags a <svc>.<ns> name', () => {
    expect(isInClusterKbsUrl('http://kbs-service.trustee-operator-system:8080')).toBe(true);
  });

  it('flags the .svc FQDN (with and without cluster.local)', () => {
    expect(isInClusterKbsUrl('http://kbs-service.trustee-operator-system.svc:8080')).toBe(true);
    expect(
      isInClusterKbsUrl('http://kbs-service.trustee-operator-system.svc.cluster.local:8080'),
    ).toBe(true);
  });

  it('does NOT flag an external Route host', () => {
    expect(isInClusterKbsUrl('https://kbs-trustee.apps.example.com')).toBe(false);
    expect(isInClusterKbsUrl('https://kbs-trustee.apps.example.com:443/path')).toBe(false);
  });

  it('does NOT flag a routable host that merely contains the service name', () => {
    // kbs-service.example.com is a real external FQDN, not the in-cluster Service.
    expect(isInClusterKbsUrl('https://kbs-service-public.example.com')).toBe(false);
  });

  it('is case-insensitive on the host', () => {
    expect(isInClusterKbsUrl('http://KBS-SERVICE.NS.SVC:8080')).toBe(true);
  });

  it('treats an empty/blank URL as not in-cluster (nothing to warn about yet)', () => {
    expect(isInClusterKbsUrl('')).toBe(false);
    expect(isInClusterKbsUrl('   ')).toBe(false);
  });

  it('honors a custom Service name', () => {
    expect(isInClusterKbsUrl('http://my-kbs.ns.svc:8080', 'my-kbs')).toBe(true);
    expect(isInClusterKbsUrl('http://kbs-service.ns.svc:8080', 'my-kbs')).toBe(true); // .svc suffix still in-cluster
  });

  it('handles a host with no scheme', () => {
    expect(isInClusterKbsUrl('kbs-service.trustee-operator-system.svc:8080')).toBe(true);
    expect(isInClusterKbsUrl('kbs-trustee.apps.example.com')).toBe(false);
  });
});

describe('warnInClusterForSharing', () => {
  it('warns for an in-cluster URL (a spoke cannot reach it)', () => {
    expect(warnInClusterForSharing('http://kbs-service.ns.svc:8080')).toBe(true);
  });

  it('stays quiet for an external Route URL', () => {
    expect(warnInClusterForSharing('https://kbs-trustee.apps.example.com')).toBe(false);
  });
});

describe('isEdgeRoute', () => {
  it('is true for an edge-terminated Route', () => {
    const r: RouteKind = { spec: { tls: { termination: 'edge' } } };
    expect(isEdgeRoute(r)).toBe(true);
  });

  it('is false for passthrough / no TLS / undefined', () => {
    expect(isEdgeRoute({ spec: { tls: { termination: 'passthrough' } } })).toBe(false);
    expect(isEdgeRoute({ spec: {} })).toBe(false);
    expect(isEdgeRoute(undefined)).toBe(false);
  });
});

describe('buildKbsPassthroughRoute', () => {
  const route = buildKbsPassthroughRoute('trustee-config', 'trustee-operator-system') as {
    metadata: { name: string; namespace: string };
    spec: { to: { name: string }; tls: { termination: string } };
  };

  it('names the Route <tc>-kbs in the given namespace', () => {
    expect(route.metadata.name).toBe('trustee-config-kbs');
    expect(kbsRouteName('trustee-config')).toBe('trustee-config-kbs');
    expect(route.metadata.namespace).toBe('trustee-operator-system');
  });

  it('targets the KBS Service with passthrough TLS (CDH rejects edge)', () => {
    expect(route.spec.to.name).toBe(KBS_SERVICE_NAME);
    expect(route.spec.tls.termination).toBe('passthrough');
  });
});

describe('buildKbsHttpRoute', () => {
  const route = buildKbsHttpRoute('trustee-config', 'trustee-operator-system') as {
    metadata: { name: string };
    spec: { to: { name: string }; tls?: unknown };
  };

  it('targets the KBS Service with NO tls block (plain HTTP via the router)', () => {
    expect(route.metadata.name).toBe('trustee-config-kbs');
    expect(route.spec.to.name).toBe(KBS_SERVICE_NAME);
    expect(route.spec.tls).toBeUndefined();
  });
});

describe('kbsTlsModeFromToml', () => {
  it('reads insecure_http = true as http (the operator default)', () => {
    expect(
      kbsTlsModeFromToml('[http_server]\nsockets = ["0.0.0.0:8080"]\ninsecure_http = true\n'),
    ).toBe('http');
  });

  it('reads a private_key + certificate listener as https', () => {
    expect(
      kbsTlsModeFromToml(
        '[http_server]\nprivate_key = "/etc/https-key/privateKey"\ncertificate = "/etc/https-cert/certificate"\n',
      ),
    ).toBe('https');
  });

  it('reads insecure_http = false as https', () => {
    expect(kbsTlsModeFromToml('[http_server]\ninsecure_http = false\n')).toBe('https');
  });

  it('is unknown for empty/unrecognized config', () => {
    expect(kbsTlsModeFromToml(undefined)).toBe('unknown');
    expect(kbsTlsModeFromToml('[attestation_service]\n')).toBe('unknown');
  });
});

describe('kbsConfigEnableTls', () => {
  const http =
    '[http_server]\nsockets = ["0.0.0.0:8080"]\ninsecure_http = true\nworker_count = 4\n';

  it('swaps insecure_http for the mounted cert/key paths, keeping the rest', () => {
    const out = kbsConfigEnableTls(http);
    expect(out).not.toContain('insecure_http');
    expect(out).toContain('private_key = "/etc/https-key/privateKey"');
    expect(out).toContain('certificate = "/etc/https-cert/certificate"');
    expect(kbsTlsModeFromToml(out)).toBe('https');
    expect(out).toContain('sockets = ["0.0.0.0:8080"]');
    expect(out).toContain('worker_count = 4');
  });

  it('is idempotent on a config already serving TLS', () => {
    const tls = kbsConfigEnableTls(http);
    expect(kbsConfigEnableTls(tls)).toBe(tls);
  });
});
