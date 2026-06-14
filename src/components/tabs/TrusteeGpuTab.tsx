import type { FC } from 'react';
import { useTranslation } from 'react-i18next';
import { ResourceLink, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Card,
  CardBody,
  CardTitle,
  ClipboardCopy,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Label,
  PageSection,
} from '@patternfly/react-core';
import { CheckCircleIcon } from '@patternfly/react-icons';
import { ConfigMapGVK } from '../../k8s/resources';
import type { ConfigMapKind } from '../../k8s/types';
import type { TrusteeTabProps } from './types';
import '../trustee.css';

const DEFAULT_NRAS_URL = 'https://nras.attestation.nvidia.com/v4/attest';

/**
 * NVIDIA GPU attestation (Tech Preview). Trustee proxies GPU evidence to the
 * NVIDIA Remote Attestation Service (NRAS) in "Remote" verifier mode. This tab
 * reads the generated kbs-config to surface that configuration and the checks.
 */
const TrusteeGpuTab: FC<TrusteeTabProps> = ({ obj }) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const name = obj?.metadata?.name;
  const namespace = obj?.metadata?.namespace ?? '';

  const [cm, loaded, loadError] = useK8sWatchResource<ConfigMapKind>({
    groupVersionKind: ConfigMapGVK,
    name: name ? `${name}-kbs-config` : undefined,
    namespace,
  }) as [ConfigMapKind | undefined, boolean, unknown];
  // Settled once loaded OR errored — a missing kbs-config 404s and never flips
  // `loaded`, which would otherwise hang on "Loading…" forever.
  const settled = loaded || Boolean(loadError);

  const cfgText = Object.values(cm?.data ?? {}).join('\n');
  const hasNvidia = /nvidia_verifier/i.test(cfgText);
  const remoteMode = /type\s*=\s*"?Remote"?/i.test(cfgText);
  const urlMatch = /verifier_url\s*=\s*"([^"]+)"/i.exec(cfgText);
  const verifierUrl = urlMatch?.[1] ?? DEFAULT_NRAS_URL;

  const testCmd = `oc exec -n ${namespace || '<namespace>'} deployment/trustee-deployment -- curl -I https://nras.attestation.nvidia.com`;

  return (
    <PageSection>
      <Card className="trustee-openshift-console-plugin__mb">
        <CardTitle>
          {t('NVIDIA remote verifier')}{' '}
          <Label color="orange" isCompact>
            {t('Tech Preview')}
          </Label>
        </CardTitle>
        <CardBody>
          {name && (
            <p className="trustee-openshift-console-plugin__mb">
              <ResourceLink
                groupVersionKind={ConfigMapGVK}
                name={`${name}-kbs-config`}
                namespace={namespace}
              />
            </p>
          )}
          {!settled ? (
            <span className="trustee-openshift-console-plugin__muted">{t('Loading…')}</span>
          ) : (
            <DescriptionList isHorizontal>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Verifier mode')}</DescriptionListTerm>
                <DescriptionListDescription>
                  {hasNvidia && remoteMode ? (
                    <Label color="green" icon={<CheckCircleIcon />}>
                      {t('Remote (NRAS)')}
                    </Label>
                  ) : hasNvidia ? (
                    <Label color="orange">{t('NVIDIA verifier present, mode not "Remote"')}</Label>
                  ) : (
                    <Label color="grey">{t('Not configured')}</Label>
                  )}
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('NRAS verifier URL')}</DescriptionListTerm>
                <DescriptionListDescription className="trustee-openshift-console-plugin__mono">
                  {verifierUrl}
                </DescriptionListDescription>
              </DescriptionListGroup>
            </DescriptionList>
          )}
        </CardBody>
      </Card>

      <Card className="trustee-openshift-console-plugin__mb">
        <CardTitle>{t('Test NRAS connectivity')}</CardTitle>
        <CardBody>
          <p className="trustee-openshift-console-plugin__mb">
            {t(
              'In remote mode, Trustee must reach NVIDIA NRAS over egress HTTPS. Confirm connectivity from the Trustee pod:',
            )}
          </p>
          <ClipboardCopy isReadOnly hoverTip={t('Copy')} clickTip={t('Copied')}>
            {testCmd}
          </ClipboardCopy>
          <Alert
            variant="info"
            isInline
            title={t('Egress required')}
            className="trustee-openshift-console-plugin__mt"
          >
            {t(
              'HTTP response headers indicate success. A failure usually means an egress firewall is blocking nras.attestation.nvidia.com.',
            )}
          </Alert>
        </CardBody>
      </Card>

      <Card>
        <CardTitle>{t('NRAS attestation claims')}</CardTitle>
        <CardBody>
          <p className="trustee-openshift-console-plugin__mb trustee-openshift-console-plugin__muted">
            {t('Your GPU attestation policy should validate the claims NRAS returns:')}
          </p>
          <DescriptionList isHorizontal>
            <DescriptionListGroup>
              <DescriptionListTerm>{t('Verification status')}</DescriptionListTerm>
              <DescriptionListDescription>
                {t('Whether NRAS successfully verified the GPU attestation evidence.')}
              </DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>{t('GPU firmware version')}</DescriptionListTerm>
              <DescriptionListDescription>
                {t('The attested GPU firmware version.')}
              </DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>{t('Hardware model')}</DescriptionListTerm>
              <DescriptionListDescription>
                {t('The GPU hardware model (for example, H100).')}
              </DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>{t('Confidential Computing capabilities')}</DescriptionListTerm>
              <DescriptionListDescription>
                {t('Whether the GPU has Confidential Computing enabled.')}
              </DescriptionListDescription>
            </DescriptionListGroup>
          </DescriptionList>
        </CardBody>
      </Card>
    </PageSection>
  );
};

export default TrusteeGpuTab;
