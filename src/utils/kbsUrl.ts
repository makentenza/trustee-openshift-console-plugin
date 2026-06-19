// ---------------------------------------------------------------------------
// KBS-URL classification for sharing initdata across clusters (hub-and-spoke).
//
// Initdata bakes in a KBS URL the confidential workload attests to at boot. When
// the initdata is SHARED for a workload on ANOTHER cluster (the hub-and-spoke
// best practice), an in-cluster Service URL (kbs-service.<ns>.svc) is unroutable
// from the spoke — the pod can't reach the KBS and silently fails to attest. The
// externally reachable Route URL must be used instead.
//
// Pure logic (no React) so it is unit-testable; components pass the URL in.
// ---------------------------------------------------------------------------

import { KBS_SERVICE_NAME, KBS_SERVICE_PORT } from '../k8s/resources';
import type { RouteKind } from '../k8s/types';

/**
 * Is this KBS URL an in-cluster-only endpoint (the Kubernetes Service), i.e. one
 * a workload on a DIFFERENT cluster cannot reach?
 *
 * In-cluster hosts: the bare Service name, `<svc>.<ns>`, the `.svc` /
 * `.svc.cluster.local` FQDN, and `.cluster.local` names. An external Route host
 * (a routable FQDN like `kbs-trustee.apps.example.com`) is NOT in-cluster.
 */
export const isInClusterKbsUrl = (
  kbsUrl: string,
  serviceName: string = KBS_SERVICE_NAME,
): boolean => {
  const raw = kbsUrl.trim();
  if (raw === '') return false;
  // Only trust URL() when the input has a proper scheme://; otherwise a bare
  // host:port like `kbs-service.ns.svc:8080` is misparsed (the host becomes the
  // "scheme"), so we parse the host out manually.
  let host: string;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (hasScheme) {
    try {
      host = new URL(raw).hostname;
    } catch {
      host = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
    }
  } else {
    host = raw.split('/')[0];
  }
  // Strip a trailing :port, IPv6 brackets aside (KBS hosts here are DNS names).
  host = host.replace(/:\d+$/, '').toLowerCase();
  if (host === serviceName) return true; // bare Service name
  if (host.startsWith(`${serviceName}.`)) return true; // <svc>.<ns>[.svc...]
  return host.endsWith('.svc') || host.endsWith('.svc.cluster.local');
};

/**
 * Should we warn before sharing this initdata for another cluster? Only when an
 * external Route is being shared do we stay quiet; an in-cluster URL is the
 * footgun. Returns true when the chosen URL is in-cluster (so a spoke can't reach
 * it).
 */
export const warnInClusterForSharing = (
  kbsUrl: string,
  serviceName: string = KBS_SERVICE_NAME,
): boolean => isInClusterKbsUrl(kbsUrl, serviceName);

/**
 * Is an existing KBS Route edge-terminated? CDH (rustls) rejects the cluster
 * ingress cert that edge TLS presents, so a spoke can't attest through an edge
 * Route — it must be passthrough. Returns true only for an explicit `edge`.
 */
export const isEdgeRoute = (route?: RouteKind): boolean => route?.spec?.tls?.termination === 'edge';

/** The name of the passthrough Route this plugin creates for a TrusteeConfig. */
export const kbsRouteName = (trusteeConfigName: string): string => `${trusteeConfigName}-kbs`;

/**
 * Build a PASSTHROUGH Route exposing the KBS Service for hub-and-spoke. Passthrough
 * forwards TLS straight to the KBS (the in-guest CDH validates the KBS cert), which
 * is the only termination CDH accepts. Host is left for the router to assign.
 *
 * Returned as a loose object (a superset of our minimal RouteKind) so it carries
 * the full Route spec k8sCreate needs without fighting the narrow watch type.
 */
export const buildKbsPassthroughRoute = (
  trusteeConfigName: string,
  namespace: string,
  serviceName: string = KBS_SERVICE_NAME,
): Record<string, unknown> => ({
  apiVersion: 'route.openshift.io/v1',
  kind: 'Route',
  metadata: { name: kbsRouteName(trusteeConfigName), namespace },
  spec: {
    to: { kind: 'Service', name: serviceName, weight: 100 },
    port: { targetPort: KBS_SERVICE_PORT },
    tls: { termination: 'passthrough', insecureEdgeTerminationPolicy: 'None' },
    wildcardPolicy: 'None',
  },
});

/**
 * Build an HTTP (no-TLS) Route exposing a plain-HTTP KBS for hub-and-spoke. The router
 * serves it on :80 and forwards plaintext to kbs-service:8080. Used when the KBS runs
 * `insecure_http` (the operator's default) — the workload attests over http:// with no
 * cert. The released secret is still cryptographically wrapped to the TEE, so secret
 * confidentiality holds; HTTP loses only server authentication of the KBS.
 */
export const buildKbsHttpRoute = (
  trusteeConfigName: string,
  namespace: string,
  serviceName: string = KBS_SERVICE_NAME,
): Record<string, unknown> => ({
  apiVersion: 'route.openshift.io/v1',
  kind: 'Route',
  metadata: { name: kbsRouteName(trusteeConfigName), namespace },
  spec: {
    to: { kind: 'Service', name: serviceName, weight: 100 },
    port: { targetPort: KBS_SERVICE_PORT },
    wildcardPolicy: 'None',
  },
});

export type KbsTlsMode = 'http' | 'https' | 'unknown';

/**
 * How the KBS's rendered kbs-config.toml exposes its HTTP server:
 * - 'http'    — `insecure_http = true` (the operator default): plain HTTP, no TLS.
 * - 'https'   — `[http_server]` has `private_key` + `certificate`: real TLS.
 * - 'unknown' — couldn't tell (no config / unparseable).
 * A confidential workload must use http:// for 'http' and https:// (+ a pinned CA) for
 * 'https'. The trustee-operator (v1.1.0) renders 'http' even when an httpsSpec cert is
 * given, which is why a passthrough Route + https initdata silently fails to attest.
 */
export const kbsTlsModeFromToml = (toml?: string): KbsTlsMode => {
  if (!toml) return 'unknown';
  if (/^\s*insecure_http\s*=\s*true/m.test(toml)) return 'http';
  if (/^\s*certificate\s*=/m.test(toml) && /^\s*private_key\s*=/m.test(toml)) return 'https';
  if (/^\s*insecure_http\s*=\s*false/m.test(toml)) return 'https';
  return 'unknown';
};

/** Mount paths the operator gives the KBS cert/key secrets (kbsHttpsCert/KeySecretName). */
export const KBS_TLS_CERT_PATH = '/etc/https-cert/certificate';
export const KBS_TLS_KEY_PATH = '/etc/https-key/privateKey';

/**
 * Rewrite a kbs-config.toml's [http_server] block to terminate TLS with the mounted
 * cert/key instead of `insecure_http`. The operator mounts the httpsSpec cert at
 * KBS_TLS_CERT_PATH / KBS_TLS_KEY_PATH but (v1.1.0) leaves `insecure_http = true`, so
 * "Enforce TLS on KBS" applies this. Idempotent: a config already serving TLS is
 * returned unchanged. The ConfigMap is operator-owned but not content-reconciled, so the
 * edit persists; KBS must be restarted to load it.
 */
export const kbsConfigEnableTls = (
  toml: string,
  certPath: string = KBS_TLS_CERT_PATH,
  keyPath: string = KBS_TLS_KEY_PATH,
): string => {
  if (kbsTlsModeFromToml(toml) === 'https') return toml;
  const tlsLines = `private_key = "${keyPath}"\ncertificate = "${certPath}"`;
  if (/^[ \t]*insecure_http[ \t]*=[ \t]*true[ \t]*$/m.test(toml)) {
    return toml.replace(/^[ \t]*insecure_http[ \t]*=[ \t]*true[ \t]*$/m, tlsLines);
  }
  // No insecure_http line to swap: inject the TLS lines just under [http_server].
  return toml.replace(/^([ \t]*\[http_server\][ \t]*)$/m, `$1\n${tlsLines}`);
};
