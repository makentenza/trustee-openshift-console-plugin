import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Action } from '@openshift-console/dynamic-plugin-sdk';
import type { PodKind } from '../k8s/types';

/**
 * Action provider for Pods: adds "Verify attestation" to pods running on a
 * confidential (kata-cc*) runtime class. Routes to the guided verification page.
 */
export const useCcPodActions = (resource: PodKind): [Action[], boolean, undefined] => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const actions = useMemo<Action[]>(() => {
    const rc = resource?.spec?.runtimeClassName;
    const name = resource?.metadata?.name;
    const ns = resource?.metadata?.namespace;
    if (!rc || !rc.startsWith('kata-cc') || !name || !ns) return [];
    return [
      {
        id: 'trustee-verify-attestation',
        label: t('Verify attestation'),
        cta: { href: `/trustee/verify/${ns}/${name}` },
      },
    ];
  }, [resource, t]);
  return [actions, true, undefined];
};
