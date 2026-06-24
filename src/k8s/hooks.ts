import { useCallback, useEffect, useRef, useState } from 'react';
import {
  consoleFetchText,
  useActiveNamespace,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  KBS_POD_LABEL_KEY,
  KBS_POD_LABEL_VALUE,
  KbsConfigGVK,
  NamespaceGVK,
  PodGVK,
  TRUSTEE_NAMESPACE,
  TrusteeConfigGVK,
} from './resources';
import type { KbsConfigKind, NamespaceKind, PodKind, TrusteeConfigKind } from './types';
import { isRemoteClient, parseKbsLog } from '../utils/kbsLog';

/** Console "All Projects" sentinel (ALL_NAMESPACES_KEY). */
const ALL_NAMESPACES = '#ALL_NS#';

/**
 * Default the console's active project to the Trustee operator namespace when it
 * exists — so the namespaced TrusteeConfigs list and the TrusteeConfig tab links
 * aren't empty — otherwise fall back to All Projects. Applies once per mount; the
 * user can still change the project afterward.
 */
export const useTrusteeDefaultProject = (): void => {
  const [, setActiveNamespace] = useActiveNamespace();
  const [, nsLoaded, nsError] = useK8sWatchResource<NamespaceKind>({
    groupVersionKind: NamespaceGVK,
    name: TRUSTEE_NAMESPACE,
  });
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current) return;
    if (nsLoaded) {
      setActiveNamespace(TRUSTEE_NAMESPACE);
      applied.current = true;
    } else if (nsError) {
      setActiveNamespace(ALL_NAMESPACES);
      applied.current = true;
    }
  }, [nsLoaded, nsError, setActiveNamespace]);
};

/** All TrusteeConfig CRs on the cluster (the user-facing attestation resource). */
export const useTrusteeConfigs = (): [TrusteeConfigKind[], boolean] => {
  const [data, loaded] = useK8sWatchResource<TrusteeConfigKind[]>({
    groupVersionKind: TrusteeConfigGVK,
    isList: true,
  });
  return [data ?? [], loaded];
};

/** All KbsConfig CRs (operator-generated; surfaced for advanced management). */
export const useKbsConfigs = (): [KbsConfigKind[], boolean] => {
  const [data, loaded] = useK8sWatchResource<KbsConfigKind[]>({
    groupVersionKind: KbsConfigGVK,
    isList: true,
  });
  return [data ?? [], loaded];
};

/** One remote source (a confidential workload in another cluster) that attested here. */
export interface RemoteSpoke {
  clientIp: string;
  lastSeen?: string;
  attests: number;
  released: number;
  attestOk: boolean;
  attestDenied: boolean;
  resources: { path: string; released: boolean }[];
}

/**
 * Remote confidential workloads (in OTHER clusters) that attested to this Trustee,
 * grouped by source IP — parsed from the KBS container log, since the console
 * cannot watch remote-cluster pods. A released secret counts as proof of
 * attestation (the KBS only releases after a valid token). Returns the grouped
 * spokes plus a manual refresh.
 *
 * `localPodIps` are the IPs of confidential workloads co-located on THIS cluster, so
 * remote-spoke detection can exclude them: co-located workloads hit the in-cluster
 * Service (own pod IP), whereas remote spokes traverse the hub Route and appear as
 * the cluster router's IP. See isRemoteClient.
 */
export const useRemoteAttestations = (
  hubNs: string,
  localPodIps: readonly string[] = [],
): {
  spokes: RemoteSpoke[];
  loading: boolean;
  error?: string;
  fetchedAt?: string;
  refresh: () => void;
} => {
  const [pods] = useK8sWatchResource<PodKind[]>({
    groupVersionKind: PodGVK,
    namespace: hubNs,
    isList: true,
  });
  const kbsPod = (pods ?? []).find(
    (p) =>
      p.metadata?.labels?.[KBS_POD_LABEL_KEY] === KBS_POD_LABEL_VALUE &&
      p.status?.phase === 'Running',
  )?.metadata?.name;

  const [spokes, setSpokes] = useState<RemoteSpoke[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [fetchedAt, setFetchedAt] = useState<string | undefined>();

  // Stable dependency key (value-equal across renders) so the effect doesn't refetch
  // the KBS log on every render — a fresh array identity each render would otherwise
  // loop. The Set of local pod IPs is rebuilt from this key inside the callback.
  const localIpsKey = [...localPodIps].sort((a, b) => a.localeCompare(b)).join(',');
  const fetchLogs = useCallback(async () => {
    if (!kbsPod) return;
    setLoading(true);
    setError(undefined);
    try {
      const localIps = new Set(localIpsKey ? localIpsKey.split(',') : []);
      const url = `/api/kubernetes/api/v1/namespaces/${hubNs}/pods/${kbsPod}/log?container=kbs&tailLines=5000`;
      const text = await consoleFetchText(url);
      const byIp = new Map<string, RemoteSpoke>();
      for (const e of parseKbsLog(text)) {
        if ((e.kind !== 'attest' && e.kind !== 'resource') || !isRemoteClient(e.clientIp, localIps))
          continue;
        if (!e.clientIp) continue;
        const ip = e.clientIp;
        const s: RemoteSpoke = byIp.get(ip) ?? {
          clientIp: ip,
          attests: 0,
          released: 0,
          attestOk: false,
          attestDenied: false,
          resources: [],
        };
        if (!s.lastSeen || (e.timestamp ?? '') > s.lastSeen) s.lastSeen = e.timestamp;
        if (e.kind === 'attest') {
          s.attests += 1;
          if (e.status && e.status < 300) s.attestOk = true;
          else if (e.status === 401 || e.status === 403) s.attestDenied = true;
        } else if (e.kind === 'resource' && e.path) {
          const ok = !!e.status && e.status < 300;
          // A released resource implies a valid attestation token, so it proves the
          // workload attested even if the one-time /attest line has aged out.
          if (ok) {
            s.attestOk = true;
            s.released += 1;
          }
          const path = e.path.replace('/kbs/v0/resource/', '');
          if (!s.resources.some((r) => r.path === path)) s.resources.push({ path, released: ok });
        }
        byIp.set(ip, s);
      }
      setSpokes(
        Array.from(byIp.values()).sort((a, b) =>
          (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''),
        ),
      );
      setFetchedAt(new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [kbsPod, hubNs, localIpsKey]);

  useEffect(() => {
    // Fetch-on-mount of external data (the KBS log); setState runs after the async
    // resolves, not synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchLogs();
  }, [fetchLogs]);

  return { spokes, loading, error, fetchedAt, refresh: () => void fetchLogs() };
};
