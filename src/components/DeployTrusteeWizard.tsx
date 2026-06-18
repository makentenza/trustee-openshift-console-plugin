import {
  DocumentTitle,
  k8sCreate,
  ListPageHeader,
  ResourceLink,
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
  Flex,
  FlexItem,
  Form,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  Grid,
  GridItem,
  HelperText,
  HelperTextItem,
  Label,
  PageSection,
  TextInput,
} from '@patternfly/react-core';
import {
  ArrowRightIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  InProgressIcon,
} from '@patternfly/react-icons';
import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';
import type { FC, ReactNode } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useTrusteeConfigs } from '../k8s/hooks';
import {
  ConfigMapGVK,
  DeploymentGVK,
  IngressConfigGVK,
  RouteGVK,
  TRUSTEE_KBS_DEPLOYMENT,
  TRUSTEE_NAMESPACE,
  TRUSTEE_OPERATOR_DEPLOYMENT,
  TrusteeConfigGVK,
  TrusteeConfigModel,
  TrusteeConfigModelRef,
} from '../k8s/resources';
import type { ConfigMapKind, DeploymentKind, RouteKind, TrusteeConfigKind } from '../k8s/types';
import { findKbsRoute } from '../utils/readiness';
import {
  buildSetupSteps,
  requiredStepsReady,
  type SetupInputs,
  type SetupStep,
  type SetupStepState,
} from '../utils/setupChecklist';
import GenerateTlsSecretModal from './GenerateTlsSecretModal';
import './trustee.css';

type ProfileType = 'Permissive' | 'Restricted';
type ServiceType = 'ClusterIP' | 'NodePort' | 'LoadBalancer';

const PREFIX = 'trustee-openshift-console-plugin';

/** Status glyph for a checklist row: check / spinner / warning, or a step number for not-yet-started. */
const StepIndicator: FC<{ state: SetupStepState; n: number }> = ({ state, n }) => {
  if (state === 'ok') return <CheckCircleIcon className={`${PREFIX}__icon-success`} />;
  if (state === 'pending') return <InProgressIcon className={`${PREFIX}__icon-info`} />;
  if (state === 'attention')
    return <ExclamationTriangleIcon className={`${PREFIX}__icon-warning`} />;
  return <span className={`${PREFIX}__step-num`}>{n}</span>;
};

const DeployTrusteeWizard: FC = () => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const navigate = useNavigate();
  const [existing, existingLoaded] = useTrusteeConfigs();

  // Live deployment state drives the guided checklist below — it reflects what the
  // operator has actually reconciled, not a fixed position.
  const tc = existing[0];
  const tcName = tc?.metadata?.name;
  const tcNs = tc?.metadata?.namespace ?? TRUSTEE_NAMESPACE;

  // The Trustee operator's controller-manager — confirms the operator is live (the
  // page itself only renders when the TrusteeConfig CRD is present).
  const [operatorDeploy] = useK8sWatchResource<DeploymentKind>({
    groupVersionKind: DeploymentGVK,
    name: TRUSTEE_OPERATOR_DEPLOYMENT,
    namespace: TRUSTEE_NAMESPACE,
  });
  const [kbsDeploy] = useK8sWatchResource<DeploymentKind>({
    groupVersionKind: DeploymentGVK,
    name: TRUSTEE_KBS_DEPLOYMENT,
    namespace: tcNs,
  });
  const [rvpsCm] = useK8sWatchResource<ConfigMapKind>({
    groupVersionKind: ConfigMapGVK,
    name: tc?.metadata?.name
      ? `${tc.metadata.name}-rvps-reference-values`
      : 'rvps-reference-values',
    namespace: tcNs,
  });
  // The external KBS Route lets a workload on a spoke reach the KBS (hub-and-spoke).
  const [routes] = useK8sWatchResource<RouteKind[]>({
    groupVersionKind: RouteGVK,
    namespace: tcNs,
    isList: true,
  });

  const tcCreated = existing.length > 0;
  const tcReady =
    !!tc &&
    (tc.status?.isReady === true ||
      (tc.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'));
  const kbsUp = (kbsDeploy?.status?.readyReplicas ?? 0) > 0 || tcReady;
  const rv = (rvpsCm?.data?.['reference-values.json'] ?? '').trim();
  const refValuesSet = tcCreated && rv !== '' && rv !== '[]' && rv !== '{}';
  const controllerRunning = (operatorDeploy?.status?.readyReplicas ?? 0) > 0;
  const route = findKbsRoute(routes ?? []);
  const routeAdmitted = !!route && (route.status?.ingress ?? []).some((ing) => !!ing.host);
  const routeHost = route?.status?.ingress?.[0]?.host ?? route?.spec?.host ?? '';
  // First non-Ready condition message — explains a TrusteeConfig stuck mid-reconcile.
  const stuckReason = (tc?.status?.conditions ?? [])
    .filter((c) => c.status !== 'True')
    .map((c) => [c.reason, c.message].filter((s): s is string => !!s && s.length > 0).join(': '))
    .find((s) => s.length > 0);

  const inputs: SetupInputs = {
    // The page only renders when the TrusteeConfig CRD exists, so the operator is
    // installed; controllerRunning just enriches the detail line.
    operatorReady: true,
    tcCreated,
    kbsReady: kbsUp,
    refValuesSet,
    routeAdmitted,
  };
  const steps = buildSetupSteps(inputs);
  const verifyReady = requiredStepsReady(inputs);
  const createdHref = tcName ? `/k8s/ns/${tcNs}/${TrusteeConfigModelRef}/${tcName}` : undefined;

  // Per-step copy. Built in the component so the strings are picked up by i18n.
  const META: Record<SetupStep['id'], { title: string; desc: string; action?: string }> = {
    operator: {
      title: t('Trustee operator installed'),
      desc: t(
        'The Red Hat build of Trustee operator provides the TrusteeConfig API and reconciles everything below it from a single resource.',
      ),
    },
    trusteeconfig: {
      title: t('Create the TrusteeConfig'),
      desc: t(
        'One resource the operator expands into the KBS plus its policies, reference values, and secrets. Use the form below.',
      ),
    },
    kbs: {
      title: t('Operator deploys the Key Broker Service'),
      desc: t(
        'Automatic. The operator rolls out the KBS and generates its attestation and resource policies and secrets.',
      ),
      action: t('View health'),
    },
    'reference-values': {
      title: t('Register reference values'),
      desc: t(
        'The expected TEE measurements that evidence is checked against. Trustee denies attestation until reference values exist.',
      ),
      action: t('Configure reference values'),
    },
    policies: {
      title: t('Tune attestation & resource policies'),
      desc: t(
        'Default policies are generated for you. Customize them to control which workloads are trusted and which secrets they receive.',
      ),
      action: t('Open policies'),
    },
    secrets: {
      title: t('Add delivered secrets'),
      desc: t('The sealed secrets the KBS releases to a workload after it attests successfully.'),
      action: t('Open delivered secrets'),
    },
    gpu: {
      title: t('Enable GPU attestation'),
      desc: t(
        'For NVIDIA H100 confidential GPUs. Uses the NVIDIA Remote Attestation Service (remote verifier only; Technology Preview).',
      ),
      action: t('Open GPU attestation'),
    },
    route: {
      title: t('Expose the KBS for hub-and-spoke'),
      desc: t(
        'Only when confidential workloads run on a separate cluster: expose kbs-service through a Route or LoadBalancer so remote workloads can reach it.',
      ),
    },
    verify: {
      title: t('Verify attestation'),
      desc: t('Boot a confidential workload and confirm it attests and receives its secrets.'),
      action: t('Go to attestation overview'),
    },
  };

  const detailFor = (id: SetupStep['id']): ReactNode => {
    switch (id) {
      case 'operator':
        return controllerRunning
          ? t('The operator controller-manager is running in {{nsName}}.', {
              nsName: TRUSTEE_NAMESPACE,
            })
          : t('TrusteeConfig CRDs are present on this cluster.');
      case 'trusteeconfig':
        return tcCreated
          ? t('Created: {{name}}.', { name: tcName })
          : t('Not created yet — use the form below.');
      case 'kbs':
        if (!tcCreated) return undefined;
        if (kbsUp) return t('KBS deployed and reconciled.');
        return stuckReason
          ? t('Waiting — {{reason}}', { reason: stuckReason })
          : t('Waiting for the operator to deploy the KBS…');
      case 'reference-values':
        if (!tcCreated) return undefined;
        return refValuesSet
          ? t('Reference values registered — attestation can match evidence.')
          : t('None registered yet — attestation stays denied until they exist.');
      case 'route':
        return routeAdmitted ? t('Reachable at {{host}}.', { host: routeHost }) : undefined;
      case 'verify':
        return verifyReady
          ? t('Required steps are complete — boot a workload to confirm.')
          : t('Finish the required steps first.');
      default:
        return undefined;
    }
  };

  const linkButton = (label: string, href: string): ReactNode => (
    <Button
      variant="link"
      isInline
      icon={<ArrowRightIcon />}
      iconPosition="end"
      onClick={() => void navigate(href)}
    >
      {label}
    </Button>
  );

  const actionFor = (step: SetupStep): ReactNode => {
    // The final verify link is always available — it's just the attestation overview.
    if (step.id === 'verify') return linkButton(META.verify.action ?? '', '/trustee');
    // Open the created TrusteeConfig resource.
    if (step.id === 'trusteeconfig')
      return createdHref ? linkButton(t('Open TrusteeConfig'), createdHref) : undefined;
    // Tab deep-links (reference values, policies, secrets, GPU) and the KBS health tab.
    // Before a TrusteeConfig exists these have nowhere to point — a single note above
    // the list explains they unlock then, so rows stay quiet.
    const tab = step.tab ?? (step.id === 'kbs' ? 'health' : undefined);
    const label = META[step.id].action;
    if (!tab || !label || !tcName) return undefined;
    return linkButton(label, `/k8s/ns/${tcNs}/${TrusteeConfigModelRef}/${tcName}/${tab}`);
  };

  const [name, setName] = useState('trustee-config');
  const [namespace, setNamespace] = useState(TRUSTEE_NAMESPACE);
  const [profileType, setProfileType] = useState<ProfileType>('Permissive');
  const [serviceType, setServiceType] = useState<ServiceType>('ClusterIP');
  const [httpsSecret, setHttpsSecret] = useState('');
  const [tokenSecret, setTokenSecret] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [tlsModalOpen, setTlsModalOpen] = useState(false);
  const [createdRef, setCreatedRef] = useState<{ name: string; namespace: string } | undefined>();

  // Cluster apps domain — offered as a SAN so generated certs also cover Routes.
  const [ingressConfig] = useK8sWatchResource<K8sResourceCommon & { spec?: { domain?: string } }>({
    groupVersionKind: IngressConfigGVK,
    name: 'cluster',
  });
  const ingressDomain = ingressConfig?.spec?.domain ?? '';

  const restricted = profileType === 'Restricted';
  const httpsRequiredMissing = restricted && httpsSecret.trim() === '';
  const valid = name.trim() !== '' && namespace.trim() !== '' && !httpsRequiredMissing;
  const nameExists = existing.some(
    (e) => e.metadata?.name === name.trim() && e.metadata?.namespace === namespace.trim(),
  );

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
      // Stay on the page and show a success panel: the operator's progress shows in
      // the checklist above, and the user isn't tempted to recreate the resource.
      setCreatedRef({ name: name.trim(), namespace: namespace.trim() });
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
        {createdRef ? (
          <Alert
            variant="success"
            isInline
            title={t('TrusteeConfig {{name}} created', { name: createdRef.name })}
            className="trustee-openshift-console-plugin__mb"
          >
            <Content component="p">
              {t(
                'The operator is now deploying the KBS and generating its policies, reference values, and secrets — follow progress in the checklist above. You don’t need to create another.',
              )}
            </Content>
            <div className="trustee-openshift-console-plugin__mt">
              <ResourceLink
                groupVersionKind={TrusteeConfigGVK}
                name={createdRef.name}
                namespace={createdRef.namespace}
                inline
              />
            </div>
          </Alert>
        ) : existingLoaded && existing.length > 0 ? (
          <Alert
            variant="info"
            isInline
            title={t('Trustee is already deployed on this cluster')}
            className="trustee-openshift-console-plugin__mb"
            actionLinks={
              <Button variant="link" isInline onClick={() => void navigate('/trustee')}>
                {t('View existing Trustee')}
              </Button>
            }
          >
            {t(
              'There is already a TrusteeConfig on this cluster. Follow the checklist below to finish configuring it, or create another.',
            )}
          </Alert>
        ) : null}

        {/* Before you begin — what Trustee is + the requirements and out-of-cluster prep. */}
        <Card className="trustee-openshift-console-plugin__mb">
          <CardTitle>{t('Before you begin')}</CardTitle>
          <CardBody>
            <Content component="p">
              {t(
                'Trustee is the Red Hat build of the confidential containers attestation service. From a single TrusteeConfig, the operator deploys the Key Broker Service (KBS) and its attestation and resource policies, reference values, and secrets. Your confidential workloads then attest to Trustee when they boot and, only if their TEE evidence is trusted, receive their sealed secrets.',
              )}
            </Content>
            <Content component="p" className="trustee-openshift-console-plugin__mt">
              {t('Requirements')}
            </Content>
            <Content component="ul">
              <Content component="li">
                {t(
                  'Run Trustee on a trusted cluster, kept separate from the confidential workloads it attests. Those workloads can be co-located on this cluster for dev/test, or remote “spoke” clusters in production.',
                )}
              </Content>
              <Content component="li">{t('cluster-admin on this cluster.')}</Content>
              <Content component="li">
                {t(
                  'The Red Hat build of Trustee operator must be installed — you are seeing this page, so it is.',
                )}
              </Content>
              <Content component="li">
                {t(
                  'For production, plan a Restricted profile with an HTTPS TLS secret (you can generate one below).',
                )}
              </Content>
            </Content>
            <ExpandableSection
              toggleText={t('External prerequisites to gather first')}
              className="trustee-openshift-console-plugin__mt"
            >
              <Content component="p" className="trustee-openshift-console-plugin__muted">
                {t('Some attestation inputs are produced outside the cluster:')}
              </Content>
              <Content component="ul">
                <Content component="li">
                  {t(
                    'Restricted profile — generate an HTTPS TLS cert + key (for example with openssl) and load it as the TLS secret below.',
                  )}
                </Content>
                <Content component="li">
                  {t(
                    'Reference values — run the veritas tool from the coco-tools image to produce RVPS reference values, then import them on the Reference values tab (the tab can also run veritas in-cluster for you).',
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
          </CardBody>
        </Card>

        {/* Guided, ordered setup checklist with live status + deep-links. */}
        <Card className="trustee-openshift-console-plugin__mb">
          <CardTitle>{t('Setup checklist')}</CardTitle>
          <CardBody>
            <Content component="p" className="trustee-openshift-console-plugin__muted">
              {t(
                'Complete these in order. Every required step must be done before any workload can attest; optional steps add capabilities.',
              )}
            </Content>
            {!tcCreated && (
              <Content
                component="p"
                className="trustee-openshift-console-plugin__muted trustee-openshift-console-plugin__mb"
              >
                {t('Per-step configuration links unlock once you create the TrusteeConfig below.')}
              </Content>
            )}
            {steps.map((step, i) => {
              const meta = META[step.id];
              const detail = detailFor(step.id);
              const action = actionFor(step);
              return (
                <Flex
                  key={step.id}
                  gap={{ default: 'gapMd' }}
                  alignItems={{ default: 'alignItemsFlexStart' }}
                  className="trustee-openshift-console-plugin__step-row"
                >
                  <FlexItem>
                    <StepIndicator state={step.state} n={i + 1} />
                  </FlexItem>
                  <FlexItem grow={{ default: 'grow' }}>
                    <Flex
                      gap={{ default: 'gapSm' }}
                      alignItems={{ default: 'alignItemsCenter' }}
                      flexWrap={{ default: 'wrap' }}
                    >
                      <FlexItem>
                        <strong>{meta.title}</strong>
                      </FlexItem>
                      <FlexItem>
                        <Label isCompact color={step.required ? 'blue' : 'grey'}>
                          {step.required ? t('Required') : t('Optional')}
                        </Label>
                      </FlexItem>
                    </Flex>
                    <div className="trustee-openshift-console-plugin__muted">{meta.desc}</div>
                    {detail && (
                      <div className="trustee-openshift-console-plugin__step-detail">{detail}</div>
                    )}
                    {action && (
                      <div className="trustee-openshift-console-plugin__mt-xs">{action}</div>
                    )}
                  </FlexItem>
                </Flex>
              );
            })}
          </CardBody>
        </Card>

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
                  {!createdRef && nameExists && (
                    <Alert
                      variant="warning"
                      isInline
                      isPlain
                      title={t(
                        'A TrusteeConfig named {{name}} already exists in {{ns}} — rename to create another.',
                        { name: name.trim(), ns: namespace.trim() },
                      )}
                    />
                  )}

                  <ActionGroup>
                    {createdRef ? (
                      <>
                        <Button
                          variant="primary"
                          onClick={() => {
                            void navigate(
                              `/k8s/ns/${createdRef.namespace}/${TrusteeConfigModelRef}/${createdRef.name}`,
                            );
                          }}
                        >
                          {t('Open TrusteeConfig')}
                        </Button>
                        <Button
                          variant="link"
                          onClick={() => {
                            void navigate('/trustee');
                          }}
                        >
                          {t('Go to attestation overview')}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          variant="primary"
                          onClick={() => void create()}
                          isLoading={busy}
                          isDisabled={busy || !valid || nameExists}
                        >
                          {t('Create')}
                        </Button>
                        <Button
                          variant="link"
                          onClick={() => {
                            void navigate('/trustee');
                          }}
                        >
                          {t('Cancel')}
                        </Button>
                      </>
                    )}
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
