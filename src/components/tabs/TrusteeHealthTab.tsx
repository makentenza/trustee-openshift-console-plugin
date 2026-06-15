import type { FC } from 'react';
import { useTranslation } from 'react-i18next';
import { ResourceLink, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import {
  Card,
  CardBody,
  CardTitle,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Flex,
  FlexItem,
  Label,
  PageSection,
  Spinner,
} from '@patternfly/react-core';
import {
  DeploymentGVK,
  KBS_POD_LABEL_KEY,
  KBS_POD_LABEL_VALUE,
  PodGVK,
  TRUSTEE_KBS_DEPLOYMENT,
  TRUSTEE_NAMESPACE,
  TRUSTEE_OPERATOR_DEPLOYMENT,
} from '../../k8s/resources';
import type { ContainerStatusKind, DeploymentKind, PodKind } from '../../k8s/types';
import type { TrusteeTabProps } from './types';
import '../trustee.css';

type LabelColor = 'green' | 'orange' | 'red' | 'grey';

/** Watch a single Deployment by name; settles even when the Deployment 404s. */
const useDeployment = (name: string, namespace: string): [DeploymentKind | undefined, boolean] => {
  const [data, loaded, loadError] = useK8sWatchResource<DeploymentKind>({
    groupVersionKind: DeploymentGVK,
    name,
    namespace,
  }) as [DeploymentKind | undefined, boolean, unknown];
  return [data, loaded || Boolean(loadError)];
};

const DeploymentHealth: FC<{ name: string; namespace: string }> = ({ name, namespace }) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const [deployment, settled] = useDeployment(name, namespace);

  const desired = deployment?.spec?.replicas ?? 0;
  const ready = deployment?.status?.readyReplicas ?? 0;
  const available = deployment?.status?.availableReplicas ?? 0;

  let color: LabelColor = 'grey';
  let text = t('Not found');
  if (settled && deployment) {
    if (desired > 0 && ready >= desired) {
      color = 'green';
      text = t('Available');
    } else if (ready > 0) {
      color = 'orange';
      text = t('Degraded');
    } else {
      color = 'red';
      text = t('Unavailable');
    }
  }

  return (
    <DescriptionListGroup>
      <DescriptionListTerm>
        {settled && deployment ? (
          <ResourceLink groupVersionKind={DeploymentGVK} name={name} namespace={namespace} />
        ) : (
          <span className="trustee-openshift-console-plugin__mono">{name}</span>
        )}
      </DescriptionListTerm>
      <DescriptionListDescription>
        {!settled ? (
          <Spinner size="sm" aria-label={t('Loading')} />
        ) : (
          <Flex gap={{ default: 'gapSm' }} alignItems={{ default: 'alignItemsCenter' }}>
            <FlexItem>
              <Label color={color} isCompact>
                {text}
              </Label>
            </FlexItem>
            {deployment && (
              <FlexItem className="trustee-openshift-console-plugin__muted">
                {t('{{ready}}/{{desired}} ready, {{available}} available', {
                  ready,
                  desired,
                  available,
                })}
              </FlexItem>
            )}
          </Flex>
        )}
      </DescriptionListDescription>
    </DescriptionListGroup>
  );
};

const podColor = (phase: string | undefined, allReady: boolean): LabelColor => {
  if (phase === 'Running' && allReady) return 'green';
  if (phase === 'Running' || phase === 'Pending') return 'orange';
  if (phase === 'Failed' || phase === 'Unknown') return 'red';
  return 'grey';
};

const PodRow: FC<{ pod: PodKind; namespace: string }> = ({ pod, namespace }) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const phase = pod.status?.phase;
  const statuses: ContainerStatusKind[] = pod.status?.containerStatuses ?? [];
  const readyCount = statuses.filter((c) => c.ready).length;
  const total = statuses.length;
  const allReady = total > 0 && readyCount === total;
  const restarts = statuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);

  return (
    <DescriptionListGroup>
      <DescriptionListTerm>
        {/* The console renders a Logs tab on the pod details page this links to. */}
        <ResourceLink
          groupVersionKind={PodGVK}
          name={pod.metadata?.name}
          namespace={pod.metadata?.namespace ?? namespace}
        />
      </DescriptionListTerm>
      <DescriptionListDescription>
        <Flex gap={{ default: 'gapSm' }} alignItems={{ default: 'alignItemsCenter' }}>
          <FlexItem>
            <Label color={podColor(phase, allReady)} isCompact>
              {phase ?? t('Unknown')}
            </Label>
          </FlexItem>
          <FlexItem className="trustee-openshift-console-plugin__muted">
            {t('{{ready}}/{{total}} ready', { ready: readyCount, total })}
          </FlexItem>
          <FlexItem className="trustee-openshift-console-plugin__muted">
            {t('{{count}} restarts', { count: restarts })}
          </FlexItem>
        </Flex>
      </DescriptionListDescription>
    </DescriptionListGroup>
  );
};

/**
 * Operator & KBS health: shows the readiness of the Trustee operator and KBS
 * Deployments plus the per-pod phase/readiness/restarts of the KBS pods. Each pod
 * links to its console details page, where the built-in Logs tab is available.
 */
const TrusteeHealthTab: FC<TrusteeTabProps> = ({ obj }) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  // KBS runs in the namespace the TrusteeConfig targets; the operator runs in its
  // own (operator) namespace. Fall back to the operator namespace if unset.
  const namespace = obj?.metadata?.namespace || TRUSTEE_NAMESPACE;

  const [pods, podsLoaded, podsError] = useK8sWatchResource<PodKind[]>({
    groupVersionKind: PodGVK,
    namespace,
    isList: true,
  }) as [PodKind[] | undefined, boolean, unknown];
  const podsSettled = podsLoaded || Boolean(podsError);

  // KBS_POD_SELECTOR is `app=kbs`; filter client-side on metadata.labels.app.
  const kbsPods = (pods ?? []).filter(
    (p) => p.metadata?.labels?.[KBS_POD_LABEL_KEY] === KBS_POD_LABEL_VALUE,
  );

  return (
    <PageSection>
      <Card className="trustee-openshift-console-plugin__mb">
        <CardTitle>{t('Deployments')}</CardTitle>
        <CardBody>
          <DescriptionList isHorizontal>
            <DeploymentHealth name={TRUSTEE_KBS_DEPLOYMENT} namespace={namespace} />
            <DeploymentHealth name={TRUSTEE_OPERATOR_DEPLOYMENT} namespace={namespace} />
          </DescriptionList>
        </CardBody>
      </Card>

      <Card>
        <CardTitle>{t('KBS pods')}</CardTitle>
        <CardBody>
          <p className="trustee-openshift-console-plugin__mb trustee-openshift-console-plugin__muted">
            {t('Pods labelled app=kbs in namespace "{{namespace}}". Open a pod to view its logs.', {
              namespace,
            })}
          </p>
          {!podsSettled ? (
            <Spinner size="md" aria-label={t('Loading')} />
          ) : kbsPods.length === 0 ? (
            <span className="trustee-openshift-console-plugin__muted">
              {t('No KBS pods found. The Trustee operator may still be reconciling the KBS.')}
            </span>
          ) : (
            <DescriptionList isHorizontal>
              {kbsPods.map((pod) => (
                <PodRow key={pod.metadata?.uid} pod={pod} namespace={namespace} />
              ))}
            </DescriptionList>
          )}
        </CardBody>
      </Card>
    </PageSection>
  );
};

export default TrusteeHealthTab;
