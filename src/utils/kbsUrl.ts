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
