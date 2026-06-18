import type { FC } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Content, Gallery, PageSection } from '@patternfly/react-core';
import ConfigMapEditor from '../shared/ConfigMapEditor';
import { regoTemplatesForPolicy, validateRego } from '../../utils/rego';
import type { TrusteeTabProps } from './types';
import '../trustee.css';

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
      <Content component="p" className="trustee-openshift-console-plugin__mb">
        {t(
          'The operator generates working default policies from your TrusteeConfig — edit them here only to customize trust decisions. Policies are written in Rego; use the template buttons to start from a known-good policy.',
        )}
      </Content>
      <Content
        component="p"
        className="trustee-openshift-console-plugin__mb trustee-openshift-console-plugin__muted"
      >
        {t(
          'The attestation policies (CPU and GPU) decide whether a workload’s TEE evidence is trusted; the resource policy then decides which secrets a trusted workload may retrieve. The Restricted profile enforces strict policies, while Permissive is lenient.',
        )}
      </Content>
      <Gallery hasGutter minWidths={{ default: '480px' }}>
        {policies.map((p) => (
          <ConfigMapEditor
            key={p.suffix}
            namespace={namespace}
            configMapName={`${name}-${p.suffix}`}
            title={p.title}
            description={p.desc}
            preferredKey="policy.rego"
            templates={regoTemplatesForPolicy(p.suffix)}
            validate={validateRego}
          />
        ))}
      </Gallery>
    </PageSection>
  );
};

export default TrusteePoliciesTab;
