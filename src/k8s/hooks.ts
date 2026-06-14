import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { KbsConfigGVK, TrusteeConfigGVK } from './resources';
import type { KbsConfigKind, TrusteeConfigKind } from './types';

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
