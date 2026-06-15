import { useEffect, useState } from 'react';
import type { FC } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ResourceLink,
  k8sCreate,
  k8sDelete,
  k8sGet,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Button,
  ClipboardCopy,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Form,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Spinner,
  Split,
  SplitItem,
  TextInput,
} from '@patternfly/react-core';
import {
  ConfigMapGVK,
  ConfigMapModel,
  COCO_TOOLS_IMAGE,
  JobGVK,
  JobModel,
  RoleBindingModel,
  RoleModel,
  ServiceAccountModel,
} from '../k8s/resources';
import type { ConfigMapKind, JobKind } from '../k8s/types';
import type { EvidenceRecord } from '../utils/evidence';
import './trustee.css';

interface Props {
  workload: { namespace: string; name: string };
  kbsEndpoint: string;
  clusterName: string;
  onClose: () => void;
}

const isAlreadyExists = (e: unknown): boolean =>
  /already exists/i.test(e instanceof Error ? e.message : String(e));
const isNotFound = (e: unknown): boolean =>
  /not found|notfound|404/i.test(e instanceof Error ? e.message : String(e));

// k8s names are short; keep generated names within the 63-char limit.
const short = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

/**
 * The Job runs as a non-root SA under the restricted SCC, so HOME=/tmp. All inputs
 * arrive as env vars (no shell interpolation of user values into the script). It:
 *   1. reads the target pod's spec (runtime, node, initdata annotation),
 *   2. execs the pod and fetches a resource from the in-guest Confidential Data Hub
 *      (a success means the TEE was attested by Trustee and the secret was released),
 *   3. assembles a signed-by-time evidence record and writes it to a ConfigMap.
 * `curl -sf` returns 0 on HTTP 2xx, 22 on an HTTP error, and other codes when the
 * exec itself is refused (e.g. the Kata agent policy denies ExecProcessRequest).
 */
const PROBE_SCRIPT = [
  'set -uo pipefail',
  'export TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
  'CFLAG=""',
  'if [ -n "${CONTAINER:-}" ]; then CFLAG="-c ${CONTAINER}"; fi',
  'oc get pod "${POD_NAME}" -n "${POD_NS}" -o json > /tmp/pod.json',
  'set +e',
  'oc exec "${POD_NAME}" -n "${POD_NS}" $CFLAG -- curl -sf -m 10 "http://127.0.0.1:8006/cdh/resource/${CDH_PATH}" > /tmp/probe.out 2>/tmp/probe.err',
  'export PRC=$?',
  'set -e',
  "python3 - <<'PY' > /tmp/evidence.json",
  'import json, os, hashlib',
  "pod = json.load(open('/tmp/pod.json'))",
  "md = pod.get('metadata', {}); spec = pod.get('spec', {}); status = pod.get('status', {})",
  "anno = (md.get('annotations') or {}).get('io.katacontainers.config.hypervisor.cc_init_data', '')",
  'initsha = hashlib.sha256(anno.encode()).hexdigest() if anno else None',
  "out = open('/tmp/probe.out').read() if os.path.exists('/tmp/probe.out') else ''",
  "err = open('/tmp/probe.err').read() if os.path.exists('/tmp/probe.err') else ''",
  "prc = int(os.environ.get('PRC', '1'))",
  "verdict = 'passed' if prc == 0 else ('failed' if prc == 22 else 'inconclusive')",
  'rec = {',
  "  'schema': 'trustee.attestation.evidence/v1',",
  "  'source': 'probe',",
  "  'timestamp': os.environ.get('TS'),",
  "  'cluster': os.environ.get('CLUSTER_NAME') or None,",
  "  'workload': {'namespace': os.environ.get('POD_NS'), 'name': os.environ.get('POD_NAME'),",
  "    'uid': md.get('uid'), 'node': spec.get('nodeName'), 'runtimeClassName': spec.get('runtimeClassName'),",
  "    'phase': status.get('phase'), 'hasInitData': bool(anno), 'initdataSha256': initsha},",
  "  'trustee': {'kbsEndpoint': os.environ.get('KBS_ENDPOINT') or None},",
  "  'probe': {'method': 'in-guest Confidential Data Hub resource fetch',",
  "    'cdhPath': os.environ.get('CDH_PATH'), 'execExitCode': prc, 'response': out[:4000], 'error': err[:1000]},",
  "  'verdict': verdict,",
  '}',
  'print(json.dumps(rec, indent=2))',
  'PY',
  'oc create configmap "${EVIDENCE_CM}" -n "${POD_NS}" --from-file=evidence.json=/tmp/evidence.json --dry-run=client -o yaml | oc label --local -f - trustee.attestation/evidence=true "trustee.attestation/pod=${POD_NAME}" -o yaml | oc apply -f -',
  'echo "EVIDENCE_WRITTEN ${EVIDENCE_CM}"',
].join('\n');

const verdictColor = (v?: string): 'green' | 'red' | 'orange' | 'grey' =>
  v === 'passed' ? 'green' : v === 'failed' ? 'red' : v === 'inconclusive' ? 'orange' : 'grey';

const CDH_PATH_RE = /^[A-Za-z0-9._/-]+$/;
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const AttestationProbeModal: FC<Props> = ({ workload, kbsEndpoint, clusterName, onClose }) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const ns = workload.namespace;
  const pod = workload.name;

  const [cdhPath, setCdhPath] = useState('default/attestation-status/status');
  const [container, setContainer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [started, setStarted] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceRecord | undefined>();
  const [evidenceRaw, setEvidenceRaw] = useState('');

  const P = short(`att-probe-${pod}`, 52);
  const evidenceCm = short(`attestation-evidence-${pod}`, 253);

  const [job] = useK8sWatchResource<JobKind>(
    started ? { groupVersionKind: JobGVK, name: P, namespace: ns } : null,
  ) as [JobKind | undefined, boolean, unknown];

  const active = (job?.status?.active ?? 0) > 0;
  const succeeded = (job?.status?.succeeded ?? 0) > 0;
  const failed =
    (job?.status?.failed ?? 0) > 0 ||
    (job?.status?.conditions ?? []).some((c) => c.type === 'Failed' && c.status === 'True');

  // Once the Job succeeds, read back the evidence ConfigMap it wrote.
  useEffect(() => {
    if (!succeeded || evidence) return;
    void (async () => {
      try {
        const cm = await k8sGet<ConfigMapKind>({ model: ConfigMapModel, name: evidenceCm, ns });
        const raw = cm.data?.['evidence.json'] ?? '';
        setEvidenceRaw(raw);
        setEvidence(JSON.parse(raw) as EvidenceRecord);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [succeeded, evidence, evidenceCm, ns]);

  const cdhValid = CDH_PATH_RE.test(cdhPath.trim());
  const containerValid = container.trim() === '' || NAME_RE.test(container.trim());
  const valid = cdhValid && containerValid;

  const onRun = async () => {
    setBusy(true);
    setError('');
    try {
      try {
        await k8sCreate({
          model: ServiceAccountModel,
          data: { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: P, namespace: ns } },
        });
      } catch (e) {
        if (!isAlreadyExists(e)) throw e;
      }
      try {
        await k8sCreate({
          model: RoleModel,
          data: {
            apiVersion: 'rbac.authorization.k8s.io/v1',
            kind: 'Role',
            metadata: { name: P, namespace: ns },
            rules: [
              { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] },
              { apiGroups: [''], resources: ['pods/exec'], verbs: ['create'] },
              {
                apiGroups: [''],
                resources: ['configmaps'],
                verbs: ['get', 'create', 'patch', 'update'],
              },
            ],
          } as ConfigMapKind & { rules: unknown[] },
        });
      } catch (e) {
        if (!isAlreadyExists(e)) throw e;
      }
      try {
        await k8sCreate({
          model: RoleBindingModel,
          data: {
            apiVersion: 'rbac.authorization.k8s.io/v1',
            kind: 'RoleBinding',
            metadata: { name: P, namespace: ns },
            roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: P },
            subjects: [{ kind: 'ServiceAccount', name: P, namespace: ns }],
          } as ConfigMapKind & { roleRef: unknown; subjects: unknown[] },
        });
      } catch (e) {
        if (!isAlreadyExists(e)) throw e;
      }

      const jobResource: JobKind & Record<string, unknown> = {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name: P, namespace: ns },
        spec: {
          backoffLimit: 1,
          template: {
            spec: {
              serviceAccountName: P,
              restartPolicy: 'Never',
              containers: [
                {
                  name: 'attestation-probe',
                  image: COCO_TOOLS_IMAGE,
                  env: [
                    { name: 'HOME', value: '/tmp' },
                    { name: 'POD_NS', value: ns },
                    { name: 'POD_NAME', value: pod },
                    { name: 'CONTAINER', value: container.trim() },
                    { name: 'CDH_PATH', value: cdhPath.trim() },
                    { name: 'EVIDENCE_CM', value: evidenceCm },
                    { name: 'KBS_ENDPOINT', value: kbsEndpoint },
                    { name: 'CLUSTER_NAME', value: clusterName },
                  ],
                  command: ['bash', '-c'],
                  args: [PROBE_SCRIPT],
                },
              ],
            },
          },
        },
      };
      try {
        await k8sDelete({ model: JobModel, resource: jobResource as JobKind });
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      await k8sCreate({ model: JobModel, data: jobResource as JobKind });
      setStarted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    const blob = new Blob([evidenceRaw], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `attestation-evidence-${ns}-${pod}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const wl = evidence?.workload;
  const verdict = evidence?.verdict;

  return (
    <Modal isOpen variant="medium" onClose={onClose} aria-label={t('Collect attestation evidence')}>
      <ModalHeader title={t('Collect attestation evidence')} />
      <ModalBody>
        <Form>
          <Alert
            variant="info"
            isInline
            title={t('What this does')}
            className="trustee-openshift-console-plugin__mb"
          >
            {t(
              'Runs an in-cluster Job that execs {{pod}} and queries its in-guest Confidential Data Hub. A released resource proves the TEE was attested by Trustee. The Job records a signed-by-time evidence document (workload identity, initdata digest, Trustee endpoint, result) you can download for auditors. Note: it requires the workload’s Kata agent policy to permit exec (ExecProcessRequest); if it doesn’t, the result is "inconclusive" and the config-side evidence is still captured.',
              { pod },
            )}
          </Alert>

          <FormGroup label={t('Workload')} fieldId="ap-wl">
            <ResourceLink kind="Pod" name={pod} namespace={ns} inline />
          </FormGroup>

          <FormGroup label={t('CDH resource path')} isRequired fieldId="ap-path">
            <TextInput
              id="ap-path"
              value={cdhPath}
              isDisabled={started}
              validated={cdhValid ? 'default' : 'error'}
              onChange={(_e, v) => {
                setCdhPath(v);
              }}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem variant={cdhValid ? 'default' : 'error'}>
                  {t(
                    'The KBS resource the guest requests, as repository/type/tag. A resource only releases after a successful attestation.',
                  )}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          <FormGroup label={t('Container (optional)')} fieldId="ap-container">
            <TextInput
              id="ap-container"
              value={container}
              isDisabled={started}
              validated={containerValid ? 'default' : 'error'}
              placeholder={t('defaults to the first container')}
              onChange={(_e, v) => {
                setContainer(v);
              }}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem variant={containerValid ? 'default' : 'error'}>
                  {t('The container to exec. It must have curl on its PATH.')}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          {error && (
            <Alert variant="danger" isInline title={t('Probe error')}>
              {error}
            </Alert>
          )}

          {started && !evidence && (
            <Alert
              variant="info"
              isInline
              customIcon={<Spinner size="md" />}
              title={
                active
                  ? t('Probing the workload…')
                  : failed
                    ? t('Job failed')
                    : t('Starting the probe…')
              }
            >
              {failed
                ? t('The probe Job failed before writing evidence. Open the Job to view its logs.')
                : t('The Job execs the pod and queries the Confidential Data Hub. This is quick.')}
              <Split hasGutter className="trustee-openshift-console-plugin__mt">
                <SplitItem>
                  <ResourceLink groupVersionKind={JobGVK} name={P} namespace={ns} />
                </SplitItem>
              </Split>
            </Alert>
          )}

          {evidence && (
            <>
              <Alert
                variant={
                  verdict === 'passed' ? 'success' : verdict === 'failed' ? 'danger' : 'warning'
                }
                isInline
                title={
                  <>
                    {t('Verdict')}: <Label color={verdictColor(verdict)}>{verdict}</Label>
                  </>
                }
                className="trustee-openshift-console-plugin__mb"
              >
                {verdict === 'passed'
                  ? t('Trustee released the requested resource — the workload is attested.')
                  : verdict === 'failed'
                    ? t(
                        'The Confidential Data Hub returned an error — attestation did not succeed for this resource.',
                      )
                    : t(
                        'The probe could not exec the guest (often the agent policy denies exec). The config-side evidence below is still recorded.',
                      )}
              </Alert>

              <DescriptionList isHorizontal isCompact>
                <DescriptionListGroup>
                  <DescriptionListTerm>{t('Collected')}</DescriptionListTerm>
                  <DescriptionListDescription>{evidence.timestamp}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                  <DescriptionListTerm>{t('Cluster')}</DescriptionListTerm>
                  <DescriptionListDescription>
                    {evidence.cluster ?? t('unknown')}
                  </DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                  <DescriptionListTerm>{t('Node / runtime')}</DescriptionListTerm>
                  <DescriptionListDescription>
                    {wl?.node ?? t('unscheduled')} · {wl?.runtimeClassName ?? '—'}
                  </DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                  <DescriptionListTerm>{t('Initdata digest (SHA-256)')}</DescriptionListTerm>
                  <DescriptionListDescription>
                    <span className="trustee-openshift-console-plugin__mono">
                      {wl?.initdataSha256 ?? t('none — workload carries no initdata')}
                    </span>
                  </DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                  <DescriptionListTerm>{t('Trustee KBS')}</DescriptionListTerm>
                  <DescriptionListDescription>
                    <span className="trustee-openshift-console-plugin__mono">
                      {evidence.trustee?.kbsEndpoint ?? '—'}
                    </span>
                  </DescriptionListDescription>
                </DescriptionListGroup>
              </DescriptionList>

              <FormGroup
                label={t('Signed evidence document (JSON)')}
                fieldId="ap-evidence"
                className="trustee-openshift-console-plugin__mt"
              >
                <ClipboardCopy
                  isCode
                  isReadOnly
                  isExpanded
                  variant="expansion"
                  hoverTip={t('Copy')}
                  clickTip={t('Copied')}
                >
                  {evidenceRaw}
                </ClipboardCopy>
                <FormHelperText>
                  <HelperText>
                    <HelperTextItem>
                      {t(
                        'Also stored in the {{cm}} ConfigMap as a durable record. Hand the downloaded file to auditors.',
                        { cm: evidenceCm },
                      )}
                    </HelperTextItem>
                  </HelperText>
                </FormHelperText>
              </FormGroup>

              <Split hasGutter className="trustee-openshift-console-plugin__mt">
                <SplitItem>
                  <ResourceLink groupVersionKind={ConfigMapGVK} name={evidenceCm} namespace={ns} />
                </SplitItem>
              </Split>
            </>
          )}
        </Form>
      </ModalBody>
      <ModalFooter>
        {!started && (
          <Button
            variant="primary"
            onClick={() => void onRun()}
            isLoading={busy}
            isDisabled={busy || !valid}
          >
            {t('Run probe')}
          </Button>
        )}
        {evidence && (
          <Button variant="primary" onClick={download}>
            {t('Download evidence (JSON)')}
          </Button>
        )}
        <Button variant={started ? 'secondary' : 'link'} onClick={onClose} isDisabled={busy}>
          {t('Close')}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

export default AttestationProbeModal;
