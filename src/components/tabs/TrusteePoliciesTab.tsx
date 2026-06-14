import type { FC } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Gallery, PageSection } from '@patternfly/react-core';
import ConfigMapEditor from '../shared/ConfigMapEditor';
import type { TrusteeTabProps } from './types';

/** Edit the Rego policies the operator generates from a TrusteeConfig. */
const TrusteePoliciesTab: FC<TrusteeTabProps> = ({ obj }) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const name = obj?.metadata?.name;
  const namespace = obj?.metadata?.namespace ?? '';

  if (!name) {
    return (
      <PageSection>
        <Alert variant="info" isInline title={t('No TrusteeConfig selected')} />
      </PageSection>
    );
  }

  const policies = [
    {
      suffix: 'attestation-policy-cpu',
      title: t('CPU attestation policy'),
      desc: t(
        'Rules the Attestation Service applies to CPU TEE evidence (Intel TDX / AMD SEV-SNP).',
      ),
    },
    {
      suffix: 'attestation-policy-gpu',
      title: t('GPU attestation policy'),
      desc: t('Attestation rules for confidential GPU evidence.'),
    },
    {
      suffix: 'resource-policy',
      title: t('Resource policy'),
      desc: t('Authorizes which secrets an attested client may retrieve after attestation.'),
    },
  ];

  return (
    <PageSection>
      <Gallery hasGutter minWidths={{ default: '480px' }}>
        {policies.map((p) => (
          <ConfigMapEditor
            key={p.suffix}
            namespace={namespace}
            configMapName={`${name}-${p.suffix}`}
            title={p.title}
            description={p.desc}
            preferredKey="policy.rego"
          />
        ))}
      </Gallery>
    </PageSection>
  );
};

export default TrusteePoliciesTab;
