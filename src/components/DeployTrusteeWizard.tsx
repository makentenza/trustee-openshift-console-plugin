import {
  DocumentTitle,
  k8sCreate,
  ListPageHeader,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  ActionGroup,
  Alert,
  Button,
  Card,
  CardBody,
  CardTitle,
  CodeBlock,
  CodeBlockCode,
  Content,
  ExpandableSection,
  Form,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  Grid,
  GridItem,
  HelperText,
  HelperTextItem,
  PageSection,
  ProgressStep,
  ProgressStepper,
  TextInput,
} from '@patternfly/react-core';
import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';
import type { FC } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom-v5-compat';
import { useTranslation } from 'react-i18next';
import { useTrusteeConfigs } from '../k8s/hooks';
import {
  ConfigMapGVK,
  DeploymentGVK,
  IngressConfigGVK,
  TRUSTEE_KBS_DEPLOYMENT,
  TRUSTEE_NAMESPACE,
  TrusteeConfigModel,
} from '../k8s/resources';
import type { ConfigMapKind, DeploymentKind, TrusteeConfigKind } from '../k8s/types';
import GenerateTlsSecretModal from './GenerateTlsSecretModal';
import './trustee.css';

type ProfileType = 'Permissive' | 'Restricted';
type ServiceType = 'ClusterIP' | 'NodePort' | 'LoadBalancer';

const DeployTrusteeWizard: FC = () => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const navigate = useNavigate();
  const [existing, existingLoaded] = useTrusteeConfigs();

  // Live deployment progress for the stepper below — reflects what the operator
  // has actually reconciled, not a fixed "step 1" position.
  const tc = existing[0];
  const tcNs = tc?.metadata?.namespace ?? TRUSTEE_NAMESPACE;
  const [kbsDeploy] = useK8sWatchResource<DeploymentKind>({
    groupVersionKind: DeploymentGVK,
    name: TRUSTEE_KBS_DEPLOYMENT,
    namespace: tcNs,
  });
  const [rvpsCm] = useK8sWatchResource<ConfigMapKind>({
    groupVersionKind: ConfigMapGVK,
    name: tc?.metadata?.name ? `${tc.metadata.name}-rvps-reference-values` : 'rvps-reference-values',
    namespace: tcNs,
  });
  const tcCreated = existing.length > 0;
  const tcReady =
    !!tc &&
    (tc.status?.isReady === true ||
      (tc.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'));
  const kbsUp = (kbsDeploy?.status?.readyReplicas ?? 0) > 0 || tcReady;
  const rv = (rvpsCm?.data?.['reference-values.json'] ?? '').trim();
  const refValuesSet = tcCreated && rv !== '' && rv !== '[]' && rv !== '{}';
  const stepDone = [tcCreated, kbsUp, refValuesSet, false];
  const currentStep = stepDone.findIndex((d) => !d);
  const stepVariant = (i: number): 'success' | 'info' | 'pending' =>
    stepDone[i] ? 'success' : i === currentStep ? 'info' : 'pending';

  const [name, setName] = useState('trustee-config');
  const [namespace, setNamespace] = useState(TRUSTEE_NAMESPACE);
  const [profileType, setProfileType] = useState<ProfileType>('Permissive');
  const [serviceType, setServiceType] = useState<ServiceType>('ClusterIP');
  const [httpsSecret, setHttpsSecret] = useState('');
  const [tokenSecret, setTokenSecret] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [tlsModalOpen, setTlsModalOpen] = useState(false);

  // Cluster apps domain — offered as a SAN so generated certs also cover Routes.
  const [ingressConfig] = useK8sWatchResource<K8sResourceCommon & { spec?: { domain?: string } }>({
    groupVersionKind: IngressConfigGVK,
    name: 'cluster',
  });
  const ingressDomain = ingressConfig?.spec?.domain ?? '';

  const restricted = profileType === 'Restricted';
  const httpsRequiredMissing = restricted && httpsSecret.trim() === '';
  const valid = name.trim() !== '' && namespace.trim() !== '' && !httpsRequiredMissing;

  const buildSpec = (): TrusteeConfigKind['spec'] => ({
    profileType,
    kbsServiceType: serviceType,
    ...(httpsSecret.trim() ? { httpsSpec: { tlsSecretName: httpsSecret.trim() } } : {}),
    ...(tokenSecret.trim()
      ? { attestationTokenVerificationSpec: { tlsSecretName: tokenSecret.trim() } }
      : {}),
  });

  // openssl + `oc create secret tls` flow, wired to the form's live values.
  const tlsSecretCmd = [
    `# discover the cluster ingress domain (use it in your cert's CN/SAN if you front KBS with a route)`,
    `oc get ingresses.config/cluster -o jsonpath='{.spec.domain}'`,
    `# generate a self-signed cert + key`,
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout tls.key -out tls.crt -subj '/CN=kbs' -days 365`,
    `# load it as the TLS secret referenced above`,
    `oc create secret tls ${httpsSecret.trim() || '<tls-secret-name>'} --cert=tls.crt --key=tls.key -n ${namespace.trim() || '<namespace>'}`,
  ].join('\n');

  const yaml = [
    'apiVersion: confidentialcontainers.org/v1alpha1',
    'kind: TrusteeConfig',
    'metadata:',
    `  name: ${name || '<name>'}`,
    `  namespace: ${namespace || '<namespace>'}`,
    'spec:',
    `  profileType: ${profileType}`,
    `  kbsServiceType: ${serviceType}`,
    ...(httpsSecret.trim() ? ['  httpsSpec:', `    tlsSecretName: ${httpsSecret.trim()}`] : []),
    ...(tokenSecret.trim()
      ? ['  attestationTokenVerificationSpec:', `    tlsSecretName: ${tokenSecret.trim()}`]
      : []),
  ].join('\n');

  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const obj: TrusteeConfigKind = {
        apiVersion: 'confidentialcontainers.org/v1alpha1',
        kind: 'TrusteeConfig',
        metadata: { name: name.trim(), namespace: namespace.trim() },
        spec: buildSpec(),
      };
      await k8sCreate({ model: TrusteeConfigModel, data: obj });
      // Stay on this page so the progress stepper advances as the operator
      // reconciles KBS; the "already deployed" banner appears once the watch
      // picks up the new TrusteeConfig.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DocumentTitle>{t('Trustee setup')}</DocumentTitle>
      <ListPageHeader title={t('Trustee setup')} />
      <PageSection>
        {existingLoaded && existing.length > 0 && (
          <Alert
            variant="info"
            isInline
            title={t('Trustee is already deployed on this cluster')}
            className="trustee-openshift-console-plugin__mb"
            actionLinks={
              <Button variant="link" isInline onClick={() => navigate('/trustee')}>
                {t('View existing Trustee')}
              </Button>
            }
          >
            {t(
              'There is already a TrusteeConfig on this cluster. Manage it from the Trustee overview, or create another below.',
            )}
          </Alert>
        )}
        {/* What Trustee is & what happens after you create it */}
        <Card className="trustee-openshift-console-plugin__mb">
          <CardBody>
            <Content component="p">
              {t(
                'Trustee is the Red Hat build of the confidential containers attestation service. From this single resource, the operator deploys the Key Broker Service (KBS) and its attestation and resource policies, reference values, and secrets. Your confidential workloads then attest to Trustee when they boot and, if their TEE evidence is trusted, receive their sealed secrets.',
              )}
            </Content>
            <ProgressStepper
              aria-label={t('Trustee deployment flow')}
              isCenterAligned
              className="trustee-openshift-console-plugin__mt"
            >
              <ProgressStep
                variant={stepVariant(0)}
                isCurrent={currentStep === 0}
                id="tc-flow-create"
                titleId="tc-flow-create-title"
                description={tcCreated ? t('Created') : t('This form')}
              >
                {t('Create TrusteeConfig')}
              </ProgressStep>
              <ProgressStep
                variant={stepVariant(1)}
                isCurrent={currentStep === 1}
                id="tc-flow-kbs"
                titleId="tc-flow-kbs-title"
                description={t('KBS, policies, secrets')}
              >
                {t('Operator deploys KBS')}
              </ProgressStep>
              <ProgressStep
                variant={stepVariant(2)}
                isCurrent={currentStep === 2}
                id="tc-flow-policy"
                titleId="tc-flow-policy-title"
                description={t('Expected TEE measurements')}
              >
                {t('Set reference values')}
              </ProgressStep>
              <ProgressStep
                variant={stepVariant(3)}
                isCurrent={currentStep === 3}
                id="tc-flow-attest"
                titleId="tc-flow-attest-title"
                description={t('kata-cc pods on boot')}
              >
                {t('Workloads attest & get secrets')}
              </ProgressStep>
            </ProgressStepper>
          </CardBody>
        </Card>

        <ExpandableSection
          toggleText={t('Prerequisites & out-of-cluster steps')}
          className="trustee-openshift-console-plugin__mb"
        >
          <Content component="p" className="trustee-openshift-console-plugin__muted">
            {t('Some attestation setup happens outside the cluster:')}
          </Content>
          <Content component="ul">
            <Content component="li">
              {t(
                'Restricted profile — generate an HTTPS TLS cert + key (for example with openssl) and load it as the TLS secret below.',
              )}
            </Content>
            <Content component="li">
              {t(
                'Reference values — run the veritas tool from the coco-tools image to produce RVPS reference values, then import them on the Reference values tab.',
              )}
            </Content>
            <Content component="li">
              {t(
                'Image-signature keys — produce signing keys with Red Hat Trusted Artifact Signer and add them on the Delivered secrets tab.',
              )}
            </Content>
            <Content component="li">
              {t(
                'NVIDIA GPU attestation — requires an NRAS licensing agreement and outbound HTTPS to ',
              )}
              <a
                href="https://nras.attestation.nvidia.com"
                target="_blank"
                rel="noopener noreferrer"
              >
                nras.attestation.nvidia.com
              </a>
              .
            </Content>
            <Content component="li">
              {t('Intel TDX (on the workload cluster) — retrieve a PCCS API key from the ')}
              <a
                href="https://api.portal.trustedservices.intel.com"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('Intel Trusted Services API portal')}
              </a>
              .
            </Content>
          </Content>
        </ExpandableSection>

        <Grid hasGutter>
          <GridItem md={6}>
            <Card>
              <CardTitle>{t('TrusteeConfig')}</CardTitle>
              <CardBody>
                <Form>
                  <FormGroup label={t('Name')} isRequired fieldId="tc-name">
                    <TextInput
                      id="tc-name"
                      value={name}
                      onChange={(_e, v) => {
                        setName(v);
                      }}
                    />
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>
                          {t('A name for this Trustee deployment (the TrusteeConfig resource).')}
                        </HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </FormGroup>
                  <FormGroup label={t('Namespace')} isRequired fieldId="tc-namespace">
                    <TextInput
                      id="tc-namespace"
                      value={namespace}
                      onChange={(_e, v) => {
                        setNamespace(v);
                      }}
                    />
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>
                          {t(
                            'Where the Key Broker Service and its secrets are created. Defaults to the Trustee operator namespace.',
                          )}
                        </HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </FormGroup>
                  <FormGroup label={t('Profile')} fieldId="tc-profile">
                    <FormSelect
                      id="tc-profile"
                      value={profileType}
                      onChange={(_e, v) => {
                        setProfileType(v as ProfileType);
                      }}
                    >
                      <FormSelectOption value="Permissive" label={t('Permissive (dev/test)')} />
                      <FormSelectOption value="Restricted" label={t('Restricted (production)')} />
                    </FormSelect>
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>
                          {restricted
                            ? t(
                                'Restricted enforces strict attestation policies and requires TLS — use it for production.',
                              )
                            : t(
                                'Permissive accepts most attestation evidence — good for getting started in dev and test.',
                              )}
                        </HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </FormGroup>
                  <FormGroup label={t('KBS service type')} fieldId="tc-service">
                    <FormSelect
                      id="tc-service"
                      value={serviceType}
                      onChange={(_e, v) => {
                        setServiceType(v as ServiceType);
                      }}
                    >
                      <FormSelectOption value="ClusterIP" label="ClusterIP" />
                      <FormSelectOption value="NodePort" label="NodePort" />
                      <FormSelectOption value="LoadBalancer" label="LoadBalancer" />
                    </FormSelect>
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>
                          {t(
                            'How the Key Broker Service is reachable. ClusterIP keeps it in-cluster; use NodePort or LoadBalancer to reach it from a separate (hub-and-spoke) cluster.',
                          )}
                        </HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </FormGroup>
                  <FormGroup
                    label={t('HTTPS TLS secret')}
                    isRequired={restricted}
                    fieldId="tc-https"
                  >
                    <TextInput
                      id="tc-https"
                      value={httpsSecret}
                      validated={httpsRequiredMissing ? 'error' : 'default'}
                      onChange={(_e, v) => {
                        setHttpsSecret(v);
                      }}
                      placeholder={restricted ? t('Required for Restricted') : t('Optional')}
                    />
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem variant={httpsRequiredMissing ? 'error' : 'default'}>
                          {t(
                            'TLS secret that terminates HTTPS on the KBS endpoint. Required for the Restricted profile.',
                          )}
                        </HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                    <Button
                      variant="secondary"
                      className="trustee-openshift-console-plugin__mt"
                      isDisabled={namespace.trim() === ''}
                      onClick={() => {
                        setTlsModalOpen(true);
                      }}
                    >
                      {t('Generate TLS secret')}
                    </Button>
                    <ExpandableSection
                      toggleText={t('Generate it manually instead (custom CA)')}
                      className="trustee-openshift-console-plugin__mt"
                    >
                      <Content
                        component="p"
                        className="trustee-openshift-console-plugin__mb trustee-openshift-console-plugin__muted"
                      >
                        {t(
                          'Or generate a self-signed cert for the KBS yourself and load it as the TLS secret (substitute your own CA for production):',
                        )}
                      </Content>
                      <CodeBlock>
                        <CodeBlockCode>{tlsSecretCmd}</CodeBlockCode>
                      </CodeBlock>
                    </ExpandableSection>
                    {tlsModalOpen && (
                      <GenerateTlsSecretModal
                        trusteeConfigName={name}
                        namespace={namespace.trim() || TRUSTEE_NAMESPACE}
                        ingressDomain={ingressDomain}
                        onCreated={(s) => {
                          setHttpsSecret(s);
                        }}
                        onClose={() => {
                          setTlsModalOpen(false);
                        }}
                      />
                    )}
                  </FormGroup>
                  <FormGroup
                    label={t('Attestation token verification secret (optional)')}
                    fieldId="tc-token"
                  >
                    <TextInput
                      id="tc-token"
                      value={tokenSecret}
                      onChange={(_e, v) => {
                        setTokenSecret(v);
                      }}
                    />
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>
                          {t(
                            'Optional TLS secret used to verify attestation tokens issued by KBS.',
                          )}
                        </HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </FormGroup>

                  {error && (
                    <Alert variant="danger" isInline title={t('Could not create TrusteeConfig')}>
                      {error}
                    </Alert>
                  )}

                  <ActionGroup>
                    <Button
                      variant="primary"
                      onClick={() => void create()}
                      isLoading={busy}
                      isDisabled={busy || !valid}
                    >
                      {t('Create')}
                    </Button>
                    <Button
                      variant="link"
                      onClick={() => {
                        navigate('/trustee');
                      }}
                    >
                      {t('Cancel')}
                    </Button>
                  </ActionGroup>
                </Form>
              </CardBody>
            </Card>
          </GridItem>

          <GridItem md={6}>
            <Card>
              <CardTitle>{t('Manifest preview')}</CardTitle>
              <CardBody>
                <Content
                  component="p"
                  className="trustee-openshift-console-plugin__mb trustee-openshift-console-plugin__muted"
                >
                  {t(
                    'This is the single resource you are creating. The operator reconciles everything else from it.',
                  )}
                </Content>
                <CodeBlock>
                  <CodeBlockCode>{yaml}</CodeBlockCode>
                </CodeBlock>
              </CardBody>
            </Card>
          </GridItem>
        </Grid>
      </PageSection>
    </>
  );
};

export default DeployTrusteeWizard;
