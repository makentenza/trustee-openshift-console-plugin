import type { FC } from 'react';
import { useTranslation } from 'react-i18next';
import { ResourceLink, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { Card, CardBody, CardTitle, Flex, FlexItem, PageSection } from '@patternfly/react-core';
import { KbsConfigGVK, SecretGVK } from '../../k8s/resources';
import type { KbsConfigKind } from '../../k8s/types';
import type { TrusteeTabProps } from './types';
import '../trustee.css';

/** Read-only view of the secrets the operator generates and brokers to workloads. */
const TrusteeSecretsTab: FC<TrusteeTabProps> = ({ obj }) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const name = obj?.metadata?.name;
  const namespace = obj?.metadata?.namespace ?? '';

  const [kbs] = useK8sWatchResource<KbsConfigKind>({
    groupVersionKind: KbsConfigGVK,
    name: name ? `${name}-kbsconfig` : undefined,
    namespace,
  }) as [KbsConfigKind | undefined, boolean, unknown];

  const generated = name ? [`${name}-kbs-auth`, `${name}-https`, `${name}-attestation-token`] : [];
  const delivered = kbs?.spec?.kbsSecretResources ?? [];

  return (
    <PageSection>
      <Card className="trustee-openshift-console-plugin__mb">
        <CardTitle>{t('Operator-generated secrets')}</CardTitle>
        <CardBody>
          <Flex direction={{ default: 'column' }} gap={{ default: 'gapSm' }}>
            {generated.map((s) => (
              <FlexItem key={s}>
                <ResourceLink groupVersionKind={SecretGVK} name={s} namespace={namespace} />
              </FlexItem>
            ))}
          </Flex>
        </CardBody>
      </Card>
      <Card>
        <CardTitle>{t('Delivered to attested workloads (kbsSecretResources)')}</CardTitle>
        <CardBody>
          {delivered.length === 0 ? (
            <span className="trustee-openshift-console-plugin__muted">
              {t(
                'No secret resources are configured for delivery yet. Add them to the generated KbsConfig spec.kbsSecretResources.',
              )}
            </span>
          ) : (
            <Flex direction={{ default: 'column' }} gap={{ default: 'gapSm' }}>
              {delivered.map((s) => (
                <FlexItem key={s}>
                  <ResourceLink groupVersionKind={SecretGVK} name={s} namespace={namespace} />
                </FlexItem>
              ))}
            </Flex>
          )}
        </CardBody>
      </Card>
    </PageSection>
  );
};

export default TrusteeSecretsTab;
