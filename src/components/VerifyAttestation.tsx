import {
  DocumentTitle,
  ListPageHeader,
  ResourceLink,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Bullseye,
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
  Spinner,
} from '@patternfly/react-core';
import { CheckCircleIcon, ExclamationTriangleIcon } from '@patternfly/react-icons';
import type { FC } from 'react';
import { useParams } from 'react-router-dom-v5-compat';
import { useTranslation } from 'react-i18next';
import { CC_INIT_DATA_ANNOTATION, PodGVK } from '../k8s/resources';
import type { PodKind } from '../k8s/types';
import './trustee.css';

const StatusItem: FC<{ ok: boolean; okText: string; badText: string }> = ({
  ok,
  okText,
  badText,
}) =>
  ok ? (
    <Label color="green" icon={<CheckCircleIcon />}>
      {okText}
    </Label>
  ) : (
    <Label color="orange" icon={<ExclamationTriangleIcon />}>
      {badText}
    </Label>
  );

const VerifyAttestation: FC = () => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const { ns, name } = useParams();
  const [pod, loaded] = useK8sWatchResource<PodKind>({
    groupVersionKind: PodGVK,
    namespace: ns,
    name,
  });

  if (!loaded) {
    return (
      <Bullseye>
        <Spinner aria-label={t('Loading')} />
      </Bullseye>
    );
  }

  const rc = pod?.spec?.runtimeClassName;
  const isCc = Boolean(rc?.startsWith('kata-cc'));
  const hasInitData = Boolean(pod?.metadata?.annotations?.[CC_INIT_DATA_ANNOTATION]);
  const running = pod?.status?.phase === 'Running';
  const cmd = `oc exec -it ${name ?? '<pod>'} -n ${ns ?? '<namespace>'} -- curl http://127.0.0.1:8006/cdh/resource/default/attestation-status/status`;

  return (
    <>
      <DocumentTitle>{t('Verify attestation')}</DocumentTitle>
      <ListPageHeader title={t('Verify attestation')} />
      <PageSection>
        <Card>
          <CardTitle>
            {t('Pod')}: <ResourceLink groupVersionKind={PodGVK} name={name} namespace={ns} inline />
          </CardTitle>
          <CardBody>
            <DescriptionList isHorizontal>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Confidential runtime')}</DescriptionListTerm>
                <DescriptionListDescription>
                  <StatusItem
                    ok={isCc}
                    okText={rc ?? 'kata-cc'}
                    badText={t('Not a kata-cc workload')}
                  />
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Initdata')}</DescriptionListTerm>
                <DescriptionListDescription>
                  <StatusItem
                    ok={hasInitData}
                    okText={t('Present')}
                    badText={t('No cc_init_data annotation')}
                  />
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Pod phase')}</DescriptionListTerm>
                <DescriptionListDescription>
                  <StatusItem
                    ok={running}
                    okText={t('Running')}
                    badText={pod?.status?.phase ?? t('Unknown')}
                  />
                </DescriptionListDescription>
              </DescriptionListGroup>
            </DescriptionList>
          </CardBody>
        </Card>

        <Card className="trustee-openshift-console-plugin__mt">
          <CardTitle>{t('Run the attestation check')}</CardTitle>
          <CardBody>
            <p className="trustee-openshift-console-plugin__mb">
              {t(
                'Attestation happens inside the confidential VM, so the definitive check runs from a terminal. Fetch a resource from the Confidential Data Hub — a successful response means the TEE was attested by Trustee and the secret was released:',
              )}
            </p>
            <ClipboardCopy isReadOnly hoverTip={t('Copy')} clickTip={t('Copied')}>
              {cmd}
            </ClipboardCopy>
            <Alert
              variant="info"
              isInline
              title={t('What to expect')}
              className="trustee-openshift-console-plugin__mt"
            >
              {t(
                'A 200 response (for example "success") confirms attestation. Connection refused or a policy error means attestation has not completed — check the Trustee logs and the RVPS reference values (PCR8).',
              )}
            </Alert>
          </CardBody>
        </Card>
      </PageSection>
    </>
  );
};

export default VerifyAttestation;
