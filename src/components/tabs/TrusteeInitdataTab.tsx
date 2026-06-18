import type { FC } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ResourceLink,
  k8sCreate,
  k8sDelete,
  k8sGet,
  k8sPatch,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardTitle,
  Checkbox,
  ClipboardCopy,
  Content,
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
  Split,
  SplitItem,
  TextArea,
  TextInput,
} from '@patternfly/react-core';
import {
  ConfigMapGVK,
  ConfigMapModel,
  INITDATA_REFERENCE_VALUE_NAME,
  KBS_SERVICE_NAME,
  KBS_SERVICE_PORT,
  RVPS_REFERENCE_VALUES_KEY,
  RVPS_REFERENCE_VALUES_SUFFIX,
  RouteGVK,
  RouteModel,
  SHARED_CONFIGMAP_SCHEMA_VERSION,
  SHARED_INITDATA_CM_SUFFIX,
  SHARED_INITDATA_LABEL,
  SecretGVK,
} from '../../k8s/resources';
import type { ConfigMapKind, RouteKind, SecretKind } from '../../k8s/types';
import {
  buildInitdata,
  SENSITIVE_REQUESTS,
  type HashAlgo,
  type InitdataResult,
  type SensitiveRequest,
} from '../../utils/initdata';
import { buildKbsPassthroughRoute, isEdgeRoute, isInClusterKbsUrl } from '../../utils/kbsUrl';
import type { TrusteeTabProps } from './types';
import '../trustee.css';

const PREFIX = 'trustee-openshift-console-plugin';

const DEFAULT_ALLOW: Record<SensitiveRequest, boolean> = {
  ExecProcessRequest: false,
  ReadStreamRequest: false,
  WriteStreamRequest: false,
  SetPolicyRequest: false,
  PullImageRequest: true,
};

const isNotFound = (e: unknown): boolean =>
  /not found|notfound|404/i.test(e instanceof Error ? e.message : String(e));

/**
 * Author the initdata on the Trustee side: generate it, register its PCR8 in the
 * RVPS reference values automatically, and share the cc_init_data annotation with
 * the confidential-workload owner (download + a ConfigMap they can read).
 */
const TrusteeInitdataTab: FC<TrusteeTabProps> = ({ obj }) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const name = obj?.metadata?.name;
  const namespace = obj?.metadata?.namespace ?? '';
  const httpsSecretName = obj?.spec?.httpsSpec?.tlsSecretName;

  // --- endpoint detection: in-cluster Service + external Route ---
  const [routes] = useK8sWatchResource<RouteKind[]>({
    groupVersionKind: RouteGVK,
    namespace,
    isList: true,
  });
  const kbsRoute = useMemo(
    () => (routes ?? []).find((r) => r.spec?.to?.name === KBS_SERVICE_NAME),
    [routes],
  );
  const externalUrl = kbsRoute?.spec?.host ? `https://${kbsRoute.spec.host}` : undefined;
  const routeIsEdge = isEdgeRoute(kbsRoute);
  // In-cluster KBS endpoint is HTTP: the trustee-operator's KBS serves plain HTTP by default
  // (insecure_http=true), and the in-guest CDH (rustls) rejects the operator's self-signed
  // HTTPS cert outright (no hostname/CA leeway), so HTTPS to the in-cluster Service does not
  // work. `.svc` is the fully-qualified Service host (also matches the cert CN/SAN should you
  // later front the KBS with a CDH-trusted HTTPS cert). The field stays editable for that case.
  const inClusterUrl = `http://${KBS_SERVICE_NAME}.${namespace}.svc:${KBS_SERVICE_PORT}`;

  // --- cert auto-fill from the HTTPS secret (passthrough route / in-cluster TLS) ---
  const [httpsSecret] = useK8sWatchResource<SecretKind>(
    httpsSecretName ? { groupVersionKind: SecretGVK, name: httpsSecretName, namespace } : null,
  ) as [SecretKind | undefined, boolean, unknown];
  const autoCert = useMemo(() => {
    const b64 = httpsSecret?.data?.['tls.crt'];
    if (!b64) return '';
    try {
      return atob(b64);
    } catch {
      return '';
    }
  }, [httpsSecret]);

  // --- form state ---
  // This tab AUTHORS initdata to share with a workload owner — commonly on a
  // different cluster (hub-and-spoke). So when an external Route exists we prefer
  // it by default (a spoke can't reach the in-cluster Service URL). `modeTouched`
  // lets the user override; until then the effective mode is derived, not stored,
  // so it tracks the async-loaded Route without a state-sync effect.
  const [mode, setMode] = useState<'incluster' | 'external'>('incluster');
  const [modeTouched, setModeTouched] = useState(false);
  const effectiveMode: 'incluster' | 'external' = modeTouched
    ? mode
    : externalUrl
      ? 'external'
      : 'incluster';
  const [trusteeUrl, setTrusteeUrl] = useState('');
  const [urlTouched, setUrlTouched] = useState(false);
  const sharingInClusterUrl = isInClusterKbsUrl(trusteeUrl);
  const [algorithm, setAlgorithm] = useState<HashAlgo>('sha256');
  const [kbsCert, setKbsCert] = useState('');
  const [certTouched, setCertTouched] = useState(false);
  const [allow, setAllow] = useState<Record<SensitiveRequest, boolean>>(DEFAULT_ALLOW);
  const [result, setResult] = useState<InitdataResult | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rvStatus, setRvStatus] = useState('');
  const [shareStatus, setShareStatus] = useState('');
  const [routeStatus, setRouteStatus] = useState('');

  // Default the URL from the effective endpoint, until the user edits it.
  useEffect(() => {
    if (urlTouched) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTrusteeUrl(effectiveMode === 'external' ? (externalUrl ?? '') : inClusterUrl);
  }, [effectiveMode, externalUrl, inClusterUrl, urlTouched]);

  // Pre-fill the cert from the HTTPS secret, until the user edits it.
  useEffect(() => {
    if (!certTouched && autoCert) setKbsCert(autoCert);
  }, [autoCert, certTouched]);

  const requestHelp: Record<SensitiveRequest, string> = {
    ExecProcessRequest: t('Allow oc/kubectl exec into the confidential VM (recommended off).'),
    ReadStreamRequest: t('Allow reading container stdout/stderr streams (recommended off).'),
    WriteStreamRequest: t('Allow writing to container stdin (recommended off).'),
    SetPolicyRequest: t('Allow replacing the Kata Agent policy at runtime (recommended off).'),
    PullImageRequest: t('Allow the guest to pull container images.'),
  };

  const generate = async () => {
    setBusy(true);
    setError('');
    setRvStatus('');
    setShareStatus('');
    try {
      setResult(
        await buildInitdata({
          trusteeUrl: trusteeUrl.trim(),
          algorithm,
          kbsCert: kbsCert.trim() || undefined,
          policyOverrides: allow,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Create a passthrough Route to the KBS so a spoke can reach it (hub-and-spoke).
  // CDH rejects an edge-terminated Route's cluster ingress cert, so we always make
  // it passthrough.
  const createRoute = async () => {
    if (!name) return;
    setRouteStatus('');
    try {
      await k8sCreate({
        model: RouteModel,
        data: buildKbsPassthroughRoute(name, namespace),
      });
      setRouteStatus('ok');
    } catch (e) {
      setRouteStatus(`error:${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const rvCmName = name ? `${name}${RVPS_REFERENCE_VALUES_SUFFIX}` : '';

  const addToReferenceValues = async () => {
    if (!result || !name) return;
    setRvStatus('');
    const entry = {
      name: INITDATA_REFERENCE_VALUE_NAME,
      expiration: '2099-12-31T00:00:00Z',
      value: [result.pcr8],
    };
    try {
      let cm: ConfigMapKind | undefined;
      try {
        cm = await k8sGet<ConfigMapKind>({
          model: ConfigMapModel,
          name: rvCmName,
          ns: namespace,
        });
      } catch (e) {
        // The operator normally creates this RVPS ConfigMap when the TrusteeConfig
        // reconciles, but on a fresh deployment it may not exist yet. Rather than
        // fail silently, create it with just this initdata's PCR8 so attestation
        // can accept the workload now; reference values can be regenerated later.
        if (!isNotFound(e)) throw e;
      }

      if (!cm) {
        const fresh: ConfigMapKind = {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: rvCmName, namespace },
          data: { [RVPS_REFERENCE_VALUES_KEY]: JSON.stringify([entry], null, 2) },
        };
        await k8sCreate({ model: ConfigMapModel, data: fresh });
        setRvStatus('created');
        return;
      }

      let arr: { name?: string; expiration?: string; value?: string[] }[] = [];
      try {
        const parsed = JSON.parse(cm.data?.[RVPS_REFERENCE_VALUES_KEY] ?? '[]');
        if (Array.isArray(parsed)) arr = parsed;
      } catch {
        arr = [];
      }
      const idx = arr.findIndex((e) => e?.name === INITDATA_REFERENCE_VALUE_NAME);
      if (idx >= 0) arr[idx] = entry;
      else arr.push(entry);
      // `add` (not `replace`) so it works whether or not the key already exists.
      await k8sPatch({
        model: ConfigMapModel,
        resource: cm,
        data: [
          {
            op: 'add',
            path: '/data/reference-values.json',
            value: JSON.stringify(arr, null, 2),
          },
        ],
      });
      setRvStatus('ok');
    } catch (e) {
      setRvStatus(`error:${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const shareToConfigMap = async () => {
    if (!result || !name) return;
    setShareStatus('');
    const cmName = `${name}${SHARED_INITDATA_CM_SUFFIX}`;
    const cm: ConfigMapKind = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: cmName, namespace, labels: { [SHARED_INITDATA_LABEL]: 'true' } },
      data: {
        // Stamp the cross-plugin contract version so a reader (the CoCo plugin)
        // can detect operator skew instead of misparsing. See AGENTS.md.
        schema: SHARED_CONFIGMAP_SCHEMA_VERSION,
        cc_init_data: result.annotation,
        'kbs-url': trusteeUrl.trim(),
        pcr8: result.pcr8,
        README: t(
          'Share with the confidential-workload owner. Set cc_init_data as the io.katacontainers.config.hypervisor.cc_init_data annotation on the Pod (runtimeClassName: kata-cc).',
        ),
      },
    };
    try {
      try {
        await k8sDelete({ model: ConfigMapModel, resource: cm });
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      await k8sCreate({ model: ConfigMapModel, data: cm });
      setShareStatus('ok');
    } catch (e) {
      setShareStatus(`error:${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const download = () => {
    if (!result) return;
    const content = `# Confidential workload initdata — authored by Trustee (${name})
# KBS endpoint: ${trusteeUrl.trim()}
# PCR8 (registered in this Trustee's reference values): ${result.pcr8}
#
# Put the annotation below on your confidential Pod, then deploy it.
apiVersion: v1
kind: Pod
metadata:
  name: my-confidential-workload
  annotations:
    io.katacontainers.config.hypervisor.cc_init_data: "${result.annotation}"
spec:
  runtimeClassName: kata-cc
  containers:
    - name: app
      image: <your-image>
`;
    const url = URL.createObjectURL(new Blob([content], { type: 'application/yaml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `initdata-${name}.yaml`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  if (!name) {
    return (
      <PageSection>
        <Alert variant="info" isInline title={t('No TrusteeConfig selected')} />
      </PageSection>
    );
  }

  return (
    <PageSection>
      <Alert
        variant="info"
        isInline
        title={t('Author initdata here, then share it with the workload owner')}
        className={`${PREFIX}__mb`}
      >
        {t(
          'Initdata tells a confidential pod how to reach this Trustee and constrains the Kata agent. It is measured into PCR8, so its measurement must be registered in this Trustee’s reference values. Generate it here, click “Add to reference values”, then share the annotation with whoever creates the workload (works whether the workload runs in this cluster or a remote one).',
        )}
      </Alert>

      <Grid hasGutter>
        <GridItem md={6}>
          <Card>
            <CardTitle>{t('1. Configure')}</CardTitle>
            <CardBody>
              <Form>
                <FormGroup label={t('Where the workload runs')} fieldId="id-endpoint">
                  <FormSelect
                    id="id-endpoint"
                    value={effectiveMode}
                    onChange={(_e, v) => {
                      setMode(v as 'incluster' | 'external');
                      setModeTouched(true);
                      setUrlTouched(false);
                    }}
                  >
                    <FormSelectOption
                      value="external"
                      label={
                        externalUrl
                          ? t('A different cluster (hub-and-spoke) — recommended for sharing')
                          : t('A different cluster (hub-and-spoke)')
                      }
                      isDisabled={!externalUrl}
                    />
                    <FormSelectOption value="incluster" label={t('This cluster (co-located)')} />
                  </FormSelect>
                  <FormHelperText>
                    <HelperText>
                      <HelperTextItem>
                        {effectiveMode === 'external' && !externalUrl
                          ? t(
                              'No external Route to kbs-service found. Create a Route to expose this Trustee, or pick “This cluster”.',
                            )
                          : t(
                              'Picks the KBS URL baked into the initdata. Sharing initdata for a workload on another cluster? Use the external Route — the in-cluster Service URL is unreachable from a spoke.',
                            )}
                      </HelperTextItem>
                    </HelperText>
                  </FormHelperText>
                </FormGroup>

                {sharingInClusterUrl && (
                  <Alert
                    variant="warning"
                    isInline
                    isPlain
                    title={t('In-cluster KBS URL — only reachable from this cluster')}
                    className={`${PREFIX}__mb`}
                  >
                    {externalUrl
                      ? t(
                          'This URL is the in-cluster Service. A confidential workload on another cluster (hub-and-spoke) cannot reach it and will fail to attest. Switch to the external Route ({{route}}) unless the workload runs on this cluster.',
                          { route: externalUrl },
                        )
                      : t(
                          'This URL is the in-cluster Service, reachable only from this cluster. If the workload runs on another cluster, create an external Route to kbs-service and use it instead — otherwise the workload cannot reach the KBS to attest.',
                        )}
                  </Alert>
                )}

                {routeIsEdge && (
                  <Alert
                    variant="warning"
                    isInline
                    title={t('KBS Route uses edge TLS — a spoke cannot attest through it')}
                    className={`${PREFIX}__mb`}
                  >
                    {t(
                      'The existing Route to kbs-service is edge-terminated, presenting the cluster ingress certificate. The in-guest Confidential Data Hub (CDH) rejects it, so a remote workload cannot attest. Recreate the Route as passthrough (delete the edge Route, then use “Create passthrough Route”).',
                    )}
                  </Alert>
                )}

                {!externalUrl && (
                  <div className={`${PREFIX}__mb`}>
                    <Button variant="secondary" onClick={() => void createRoute()}>
                      {t('Create passthrough Route')}
                    </Button>{' '}
                    {routeStatus === 'ok' && (
                      <span className={`${PREFIX}__icon-success`}>
                        {t('Route created — waiting for the router to assign a host…')}
                      </span>
                    )}
                    {routeStatus.startsWith('error:') && (
                      <span className={`${PREFIX}__icon-danger`}>{routeStatus.slice(6)}</span>
                    )}
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>
                          {t(
                            'Expose this Trustee’s KBS to other clusters with a passthrough Route (the only TLS termination the in-guest CDH accepts). Needed for hub-and-spoke.',
                          )}
                        </HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </div>
                )}

                <FormGroup label={t('Trustee (KBS) URL')} isRequired fieldId="id-url">
                  <TextInput
                    id="id-url"
                    value={trusteeUrl}
                    onChange={(_e, v) => {
                      setTrusteeUrl(v);
                      setUrlTouched(true);
                    }}
                  />
                </FormGroup>

                <FormGroup label={t('KBS certificate (PEM, optional)')} fieldId="id-cert">
                  <TextArea
                    id="id-cert"
                    value={kbsCert}
                    onChange={(_e, v) => {
                      setKbsCert(v);
                      setCertTouched(true);
                    }}
                    rows={4}
                    placeholder={t('Paste the KBS TLS cert for HTTPS; leave blank for plain HTTP.')}
                    style={{ fontFamily: 'var(--pf-t--global--font--family--mono)' }}
                  />
                  <FormHelperText>
                    <HelperText>
                      <HelperTextItem>
                        {autoCert && !certTouched
                          ? t('Auto-filled from the HTTPS secret {{secret}}.', {
                              secret: httpsSecretName,
                            })
                          : effectiveMode === 'external' && routeIsEdge
                            ? t(
                                'This Route uses edge TLS (cluster ingress cert). Paste it — e.g. openssl s_client -connect <host>:443 | openssl x509.',
                              )
                            : t(
                                'Required when the KBS URL is https://. Accepts a full PEM or the body.',
                              )}
                      </HelperTextItem>
                    </HelperText>
                  </FormHelperText>
                </FormGroup>

                <FormGroup label={t('Measurement algorithm')} fieldId="id-algo">
                  <FormSelect
                    id="id-algo"
                    value={algorithm}
                    onChange={(_e, v) => {
                      setAlgorithm(v as HashAlgo);
                    }}
                  >
                    <FormSelectOption value="sha256" label="sha256" />
                    <FormSelectOption value="sha384" label="sha384" />
                    <FormSelectOption value="sha512" label="sha512" />
                  </FormSelect>
                </FormGroup>

                <FormGroup label={t('Kata Agent policy')} fieldId="id-policy">
                  {SENSITIVE_REQUESTS.map((req) => (
                    <Checkbox
                      key={req}
                      id={`id-allow-${req}`}
                      label={t('Allow {{req}}', { req })}
                      description={requestHelp[req]}
                      isChecked={allow[req]}
                      onChange={(_e, checked) => {
                        setAllow((prev) => ({ ...prev, [req]: checked }));
                      }}
                      className={`${PREFIX}__mb`}
                    />
                  ))}
                </FormGroup>

                <Button
                  variant="primary"
                  onClick={() => void generate()}
                  isLoading={busy}
                  isDisabled={busy || trusteeUrl.trim() === ''}
                >
                  {t('Generate initdata')}
                </Button>
                {error && (
                  <Alert
                    variant="danger"
                    isInline
                    title={t('Could not generate initdata')}
                    className={`${PREFIX}__mt`}
                  >
                    {error}
                  </Alert>
                )}
              </Form>
            </CardBody>
          </Card>
        </GridItem>

        <GridItem md={6}>
          <Card>
            <CardTitle>{t('2. Register & share')}</CardTitle>
            <CardBody>
              {!result ? (
                <span className={`${PREFIX}__muted`}>
                  {t('Configure on the left and select Generate. Computed in your browser.')}
                </span>
              ) : (
                <>
                  <FormGroup label={t('PCR8 measurement')} fieldId="id-pcr8">
                    <ClipboardCopy isReadOnly hoverTip={t('Copy')} clickTip={t('Copied')}>
                      {result.pcr8}
                    </ClipboardCopy>
                  </FormGroup>
                  <div className={`${PREFIX}__mt ${PREFIX}__mb`}>
                    <Button variant="primary" onClick={() => void addToReferenceValues()}>
                      {t('Add to reference values')}
                    </Button>{' '}
                    {rvStatus === 'ok' && (
                      <span className={`${PREFIX}__icon-success`}>
                        {t('Registered in {{cm}}', { cm: rvCmName })}
                      </span>
                    )}
                    {rvStatus === 'created' && (
                      <span className={`${PREFIX}__icon-success`}>
                        {t('Created {{cm}} and registered this PCR8', { cm: rvCmName })}
                      </span>
                    )}
                    {rvStatus.startsWith('error:') && (
                      <span className={`${PREFIX}__icon-danger`}>{rvStatus.slice(6)}</span>
                    )}
                    <FormHelperText>
                      <HelperText>
                        <HelperTextItem>
                          {t(
                            'Adds this initdata’s PCR8 to the RVPS reference values as “{{n}}”, so attestation accepts pods carrying it.',
                            { n: INITDATA_REFERENCE_VALUE_NAME },
                          )}
                        </HelperTextItem>
                      </HelperText>
                    </FormHelperText>
                  </div>

                  <FormGroup
                    label={t('cc_init_data annotation (share with the workload owner)')}
                    fieldId="id-ann"
                    className={`${PREFIX}__mt`}
                  >
                    <ClipboardCopy
                      isReadOnly
                      isExpanded
                      variant="expansion"
                      hoverTip={t('Copy')}
                      clickTip={t('Copied')}
                    >
                      {result.annotation}
                    </ClipboardCopy>
                  </FormGroup>
                  <Split hasGutter className={`${PREFIX}__mt`}>
                    <SplitItem>
                      <Button variant="secondary" onClick={download}>
                        {t('Download pod YAML')}
                      </Button>
                    </SplitItem>
                    <SplitItem>
                      <Button variant="secondary" onClick={() => void shareToConfigMap()}>
                        {t('Save to cluster (ConfigMap)')}
                      </Button>
                    </SplitItem>
                  </Split>
                  {shareStatus === 'ok' && (
                    <div className={`${PREFIX}__mt`}>
                      <ResourceLink
                        groupVersionKind={ConfigMapGVK}
                        name={`${name}${SHARED_INITDATA_CM_SUFFIX}`}
                        namespace={namespace}
                      />
                    </div>
                  )}
                  {shareStatus.startsWith('error:') && (
                    <Alert
                      variant="danger"
                      isInline
                      title={t('Could not save')}
                      className={`${PREFIX}__mt`}
                    >
                      {shareStatus.slice(6)}
                    </Alert>
                  )}
                  <Content component="p" className={`${PREFIX}__muted ${PREFIX}__mt`}>
                    {t(
                      'The ConfigMap {{cm}} (labelled {{label}}) holds the annotation for the workload owner to read in-cluster.',
                      { cm: `${name}${SHARED_INITDATA_CM_SUFFIX}`, label: SHARED_INITDATA_LABEL },
                    )}
                  </Content>
                </>
              )}
            </CardBody>
          </Card>
        </GridItem>
      </Grid>
    </PageSection>
  );
};

export default TrusteeInitdataTab;
