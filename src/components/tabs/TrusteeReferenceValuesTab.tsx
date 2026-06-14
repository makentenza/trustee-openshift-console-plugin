import type { FC } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, PageSection } from '@patternfly/react-core';
import ConfigMapEditor from '../shared/ConfigMapEditor';
import type { TrusteeTabProps } from './types';

/** Edit the RVPS reference values (expected measurements, incl. the initdata PCR8). */
const TrusteeReferenceValuesTab: FC<TrusteeTabProps> = ({ obj }) => {
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

  return (
    <PageSection>
      <ConfigMapEditor
        namespace={namespace}
        configMapName={`${name}-rvps-reference-values`}
        title={t('RVPS reference values')}
        description={t(
          'Expected measurement values the Reference Value Provider Service checks against TEE evidence — including the PCR8 hash produced by the initdata builder.',
        )}
        preferredKey="reference-values.json"
      />
    </PageSection>
  );
};

export default TrusteeReferenceValuesTab;
