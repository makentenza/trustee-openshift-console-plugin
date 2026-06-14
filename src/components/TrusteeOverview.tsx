import type { FC } from 'react';
import { Link } from 'react-router-dom-v5-compat';
import { useTranslation } from 'react-i18next';
import {
  DocumentTitle,
  ListPageHeader,
  ResourceLink,
  Timestamp,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  Bullseye,
  Button,
  Card,
  CardBody,
  CardTitle,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Gallery,
  Label,
  PageSection,
  Spinner,
} from '@patternfly/react-core';
import { LockIcon } from '@patternfly/react-icons';
import { useTrusteeConfigs } from '../k8s/hooks';
import { TrusteeConfigGVK } from '../k8s/resources';
import type { TrusteeConfigKind } from '../k8s/types';
import './trustee.css';

// The Deploy Trustee wizard.
const TRUSTEECONFIG_DEPLOY = '/trustee/deploy';

const isReady = (tc: TrusteeConfigKind): boolean =>
  tc.status?.isReady === true ||
  (tc.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');

const SummaryCard: FC<{ trusteeConfig: TrusteeConfigKind }> = ({ trusteeConfig }) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const spec = trusteeConfig.spec ?? {};
  const ns = trusteeConfig.metadata?.namespace;
  const ready = isReady(trusteeConfig);

  return (
    <Card>
      <CardTitle>
        <ResourceLink
          groupVersionKind={TrusteeConfigGVK}
          name={trusteeConfig.metadata?.name}
          namespace={ns}
        />
      </CardTitle>
      <CardBody>
        <DescriptionList isCompact>
          <DescriptionListGroup>
            <DescriptionListTerm>{t('Status')}</DescriptionListTerm>
            <DescriptionListDescription>
              {ready ? (
                <Label color="green" icon={<LockIcon />}>
                  {t('Ready')}
                </Label>
              ) : (
                <Label color="orange">{t('Pending')}</Label>
              )}
            </DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>{t('Profile')}</DescriptionListTerm>
            <DescriptionListDescription>
              {spec.profileType ? (
                <Label color={spec.profileType === 'Restricted' ? 'blue' : 'grey'}>
                  {spec.profileType}
                </Label>
              ) : (
                t('Unknown')
              )}
            </DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>{t('Service type')}</DescriptionListTerm>
            <DescriptionListDescription>
              {spec.kbsServiceType ?? 'ClusterIP'}
            </DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>{t('HTTPS')}</DescriptionListTerm>
            <DescriptionListDescription>
              {spec.httpsSpec?.tlsSecretName ? (
                <Label color="green">{t('Enabled')}</Label>
              ) : (
                <Label color="grey">{t('Disabled')}</Label>
              )}
            </DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>{t('Token verification')}</DescriptionListTerm>
            <DescriptionListDescription>
              {spec.attestationTokenVerificationSpec?.tlsSecretName ? (
                <Label color="green">{t('Enabled')}</Label>
              ) : (
                <Label color="grey">{t('Disabled')}</Label>
              )}
            </DescriptionListDescription>
          </DescriptionListGroup>
          <DescriptionListGroup>
            <DescriptionListTerm>{t('Created')}</DescriptionListTerm>
            <DescriptionListDescription>
              <Timestamp timestamp={trusteeConfig.metadata?.creationTimestamp} />
            </DescriptionListDescription>
          </DescriptionListGroup>
        </DescriptionList>
      </CardBody>
    </Card>
  );
};

const EmptyTrustee: FC = () => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  return (
    <Bullseye>
      <Card isLarge>
        <CardTitle>
          <LockIcon /> {t('No Trustee deployment found')}
        </CardTitle>
        <CardBody>
          <p className="trustee-openshift-console-plugin__mb">
            {t(
              'The Red Hat build of Trustee brokers secrets to confidential workloads after verifying their attestation evidence. Create a TrusteeConfig to deploy and configure it — one resource generates the KBS, attestation policies, reference values, and secrets.',
            )}
          </p>
          <Button
            variant="primary"
            component={(props) => <Link {...props} to={TRUSTEECONFIG_DEPLOY} />}
          >
            {t('Create TrusteeConfig')}
          </Button>
        </CardBody>
      </Card>
    </Bullseye>
  );
};

const TrusteeOverview: FC = () => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const [trusteeConfigs, loaded] = useTrusteeConfigs();

  return (
    <>
      <DocumentTitle>{t('Trustee')}</DocumentTitle>
      <ListPageHeader title={t('Trustee (Attestation)')}>
        {loaded && trusteeConfigs.length > 0 && (
          <Button
            variant="primary"
            component={(props) => <Link {...props} to={TRUSTEECONFIG_DEPLOY} />}
          >
            {t('Create TrusteeConfig')}
          </Button>
        )}
      </ListPageHeader>
      <PageSection>
        {!loaded ? (
          <Bullseye>
            <Spinner aria-label={t('Loading')} />
          </Bullseye>
        ) : trusteeConfigs.length === 0 ? (
          <EmptyTrustee />
        ) : (
          <Gallery hasGutter minWidths={{ default: '320px' }}>
            {trusteeConfigs.map((tc) => (
              <SummaryCard key={tc.metadata?.uid} trusteeConfig={tc} />
            ))}
          </Gallery>
        )}
      </PageSection>
    </>
  );
};

export default TrusteeOverview;
