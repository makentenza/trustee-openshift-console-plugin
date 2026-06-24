// ---------------------------------------------------------------------------
// Post-install readiness model for a Trustee deployment. A TrusteeConfig can be
// created and then never finish reconciling, or reconcile without an external
// Route / reference values — leaving the admin unsure why workloads can't attest.
// We derive three checks with sub-status lines from observable state:
//   1. TrusteeConfig reconciled
//   2. KBS Route present + admitted (reachable from a spoke)
//   3. RVPS reference-values ConfigMap present (and non-empty)
//
// Pure logic (no React) so it's unit-testable; components pass the watched
// resources in.
// ---------------------------------------------------------------------------
import { KBS_SERVICE_NAME, RVPS_REFERENCE_VALUES_KEY } from '../k8s/resources';
import type { ConfigMapKind, RouteKind, TrusteeConfigKind } from '../k8s/types';

export type ReadyState = 'ok' | 'warn' | 'pending';

export interface ReadinessCheck {
  id: 'trusteeconfig' | 'route' | 'refvals';
  label: string;
  state: ReadyState;
  /** A short status line describing the current state (already human-readable). */
  detail: string;
}

const tcReconciled = (tc?: TrusteeConfigKind): boolean =>
  !!tc &&
  (tc.status?.isReady === true ||
    (tc.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'));

/** First non-Ready/False condition message, to explain a stuck TrusteeConfig. */
const tcConditionDetail = (tc?: TrusteeConfigKind): string => {
  const c = (tc?.status?.conditions ?? []).find((x) => x.status !== 'True');
  return [c?.reason, c?.message].filter((s) => s && s.length > 0).join(': ');
};

/** The Route (if any) that targets the KBS Service. */
export const findKbsRoute = (
  routes: RouteKind[],
  serviceName: string = KBS_SERVICE_NAME,
): RouteKind | undefined => routes.find((r) => r.spec?.to?.name === serviceName);

/** A Route is reachable once an ingress host has been admitted (status.ingress). */
const routeAdmitted = (route?: RouteKind): boolean =>
  !!route && (route.status?.ingress ?? []).some((i) => !!i.host);

const rvpsPresent = (cm?: ConfigMapKind): boolean => {
  const raw = (cm?.data?.[RVPS_REFERENCE_VALUES_KEY] ?? '').trim();
  return raw !== '' && raw !== '[]' && raw !== '{}';
};

/**
 * Build the readiness checks. `kbsRouteRequired` lets the caller treat a missing
 * external Route as only a warning (co-located, same-cluster) vs. a hard gap
 * (hub-and-spoke). We keep it a warning either way — an in-cluster-only Trustee is
 * valid — but the detail text nudges toward a Route when sharing across clusters.
 */
/** True when the TrusteeConfig uses the Permissive profile (dev/test default). */
export const isPermissiveProfile = (tc?: TrusteeConfigKind): boolean =>
  !tc?.spec?.profileType || tc.spec.profileType === 'Permissive';

export const buildReadiness = (
  args: {
    tc?: TrusteeConfigKind;
    routes: RouteKind[];
    rvpsCm?: ConfigMapKind;
  },
  labels: {
    tcReconciled: string;
    tcReconciling: string;
    tcConditionPrefix: string;
    routeAdmitted: (host: string) => string;
    routePending: string;
    routeMissing: string;
    refvalsPresent: string;
    refvalsMissing: string;
    refvalsPermissive?: string;
  },
): ReadinessCheck[] => {
  const { tc, routes, rvpsCm } = args;
  const permissive = isPermissiveProfile(tc);

  const reconciled = tcReconciled(tc);
  const condDetail = tcConditionDetail(tc);
  const tcDetail = reconciled
    ? labels.tcReconciled
    : condDetail
      ? `${labels.tcConditionPrefix}${condDetail}`
      : labels.tcReconciling;

  const route = findKbsRoute(routes);
  const admitted = routeAdmitted(route);
  const routeDetail = !route
    ? labels.routeMissing
    : admitted
      ? labels.routeAdmitted(route.spec?.host ?? route.status?.ingress?.[0]?.host ?? '')
      : labels.routePending;

  const refPresent = rvpsPresent(rvpsCm);

  return [
    {
      id: 'trusteeconfig',
      label: 'TrusteeConfig',
      state: reconciled ? 'ok' : 'pending',
      detail: tcDetail,
    },
    {
      id: 'route',
      label: 'KBS Route',
      // A missing/un-admitted external Route is a warning, not a failure: an
      // in-cluster-only (co-located) Trustee is a supported topology.
      state: admitted ? 'ok' : 'warn',
      detail: routeDetail,
    },
    {
      id: 'refvals',
      label: 'Reference values',
      state: refPresent ? 'ok' : permissive ? 'ok' : 'warn',
      detail: refPresent
        ? labels.refvalsPresent
        : permissive
          ? (labels.refvalsPermissive ??
              'None registered — Trustee is in permissive mode; all measurements accepted')
          : labels.refvalsMissing,
    },
  ];
};
