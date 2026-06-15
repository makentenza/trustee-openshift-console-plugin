import { useState } from 'react';
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
  Checkbox,
  Form,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Spinner,
  Split,
  SplitItem,
  TextArea,
  TextInput,
} from '@patternfly/react-core';
import {
  CLUSTER_PULL_SECRET,
  COCO_TOOLS_IMAGE,
  ConfigMapModel,
  JobGVK,
  JobModel,
  RoleBindingModel,
  RoleModel,
  SecretModel,
  ServiceAccountModel,
} from '../k8s/resources';
import type { ConfigMapKind, JobKind, SecretKind } from '../k8s/types';
import './trustee.css';

interface Props {
  trusteeConfigName: string;
  namespace: string;
  tee: 'tdx' | 'snp';
  defaultOcpVersion?: string;
  onClose: () => void;
}

/** Swallow AlreadyExists (409) so create is idempotent; rethrow anything else. */
const isAlreadyExists = (e: unknown): boolean => {
  const msg = e instanceof Error ? e.message : String(e);
  return /already exists/i.test(msg);
};

/** Swallow NotFound (404) on delete so delete-then-create is idempotent. */
const isNotFound = (e: unknown): boolean => {
  const msg = e instanceof Error ? e.message : String(e);
  return /not found|notfound|404/i.test(msg);
};

/**
 * Build the bash `-c` script the veritas Job runs. It generates RVPS reference
 * values for the given TEE/OCP version, extracts reference-values.json from
 * veritas's own ConfigMap manifest, and merge-patches it into the
 * operator-generated `<name>-rvps-reference-values` ConfigMap.
 */
const buildScript = (opts: {
  tee: 'tdx' | 'snp';
  ocpVersion: string;
  gpu: boolean;
  xfamFeatures: string[];
  rvpsConfigMap: string;
  namespace: string;
  hasInitdata: boolean;
}): string => {
  const { tee, ocpVersion, gpu, xfamFeatures, rvpsConfigMap, namespace, hasInitdata } = opts;
  const gpuFlag = gpu ? '--gpu' : '';
  const xfamFlags = xfamFeatures.map((f) => `--hw-xfam-allow ${f}`).join(' ');
  // Collapse any accidental double spaces from empty flags so the command line is clean.
  const veritasCmd = [
    'veritas --platform baremetal',
    `--tee ${tee}`,
    `--ocp-version ${ocpVersion}`,
    hasInitdata ? '--initdata /initdata/initdata.toml' : '',
    '--authfile /auth/.dockerconfigjson',
    gpuFlag,
    xfamFlags,
    '-o /tmp/out',
  ]
    .filter((s) => s.length > 0)
    .join(' ');

  return [
    'set -e',
    'mkdir -p /tmp/out',
    veritasCmd,
    // Render veritas's manifest client-side and pull out just reference-values.json.
    // The \\. keeps jsonpath treating "reference-values.json" as one literal key.
    `oc create -f /tmp/out/rvps-reference-values.yaml --dry-run=client -o 'jsonpath={.data.reference-values\\.json}' > /tmp/rv.json`,
    // Merge-patch the operator CM so we replace only the one key (keep other data).
    `oc patch configmap ${rvpsConfigMap} -n ${namespace} --type merge -p "$(python3 -c 'import json; print(json.dumps({"data": {"reference-values.json": open("/tmp/rv.json").read()}}))')"`,
    `echo "PATCHED ${rvpsConfigMap}"`,
  ].join('\n');
};

/**
 * One-click reference-value generation. Runs `veritas` in an in-cluster Job using
 * the cluster pull secret, then patches the result into the operator's RVPS
 * ConfigMap. The Job, its SA/Role/RoleBinding, the initdata ConfigMap, and the
 * copied pull secret are all named `<trusteeConfigName>-rvps-gen[...]`.
 */
const GenerateReferenceValuesModal: FC<Props> = ({
  trusteeConfigName,
  namespace,
  tee,
  defaultOcpVersion,
  onClose,
}) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');

  const [ocpVersion, setOcpVersion] = useState(defaultOcpVersion ?? '');
  const [initdata, setInitdata] = useState('');
  const [gpu, setGpu] = useState(false);
  const [xfam, setXfam] = useState('x87,sse,avx');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [started, setStarted] = useState(false);

  // Fixed name prefix for every resource this flow creates.
  const P = `${trusteeConfigName}-rvps-gen`;
  const rvpsConfigMap = `${trusteeConfigName}-rvps-reference-values`;

  // Once a Job has been created, watch it for progress. Disabled until `started`
  // so we don't 404-watch a Job that doesn't exist yet.
  const [job] = useK8sWatchResource<JobKind>(
    started
      ? {
          groupVersionKind: JobGVK,
          name: P,
          namespace,
        }
      : null,
  ) as [JobKind | undefined, boolean, unknown];

  const active = (job?.status?.active ?? 0) > 0;
  const succeeded = (job?.status?.succeeded ?? 0) > 0;
  const failed =
    (job?.status?.failed ?? 0) > 0 ||
    (job?.status?.conditions ?? []).some((c) => c.type === 'Failed' && c.status === 'True');

  const valid = ocpVersion.trim() !== '';

  const onGenerate = async () => {
    setBusy(true);
    setError('');
    try {
      const hasInitdata = initdata.trim() !== '';
      // a. Copy the cluster pull secret into this namespace so the Job can mount it.
      let dockerconfigjson: string | undefined;
      try {
        const src = await k8sGet<SecretKind>({
          model: SecretModel,
          name: CLUSTER_PULL_SECRET.name,
          ns: CLUSTER_PULL_SECRET.namespace,
        });
        dockerconfigjson = src.data?.['.dockerconfigjson'];
      } catch (e) {
        throw new Error(
          t(
            'Could not read the cluster pull secret ({{name}} in {{ns}}). veritas needs it to pull the OpenShift release image. This requires cluster-admin, or provide a pull secret in this namespace. ({{detail}})',
            {
              name: CLUSTER_PULL_SECRET.name,
              ns: CLUSTER_PULL_SECRET.namespace,
              detail: e instanceof Error ? e.message : String(e),
            },
          ),
        );
      }
      if (!dockerconfigjson) {
        throw new Error(
          t(
            'The cluster pull secret {{name}} has no .dockerconfigjson key; cannot pull the OpenShift release image.',
            { name: CLUSTER_PULL_SECRET.name },
          ),
        );
      }

      // Delete-then-create the pull secret so its content is always fresh.
      const pullSecretName = `${P}-pull`;
      const pullSecret: SecretKind = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: pullSecretName, namespace },
        type: 'kubernetes.io/dockerconfigjson',
        data: { '.dockerconfigjson': dockerconfigjson },
      };
      try {
        await k8sDelete({ model: SecretModel, resource: pullSecret });
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      await k8sCreate({ model: SecretModel, data: pullSecret });

      // b. initdata ConfigMap — only when an initdata.toml was provided (optional).
      const initdataCmName = `${P}-initdata`;
      if (hasInitdata) {
        const initdataCm: ConfigMapKind = {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name: initdataCmName, namespace },
          data: { 'initdata.toml': initdata },
        };
        try {
          await k8sDelete({ model: ConfigMapModel, resource: initdataCm });
        } catch (e) {
          if (!isNotFound(e)) throw e;
        }
        await k8sCreate({ model: ConfigMapModel, data: initdataCm });
      }

      // c. ServiceAccount the Job runs as.
      try {
        await k8sCreate({
          model: ServiceAccountModel,
          data: {
            apiVersion: 'v1',
            kind: 'ServiceAccount',
            metadata: { name: P, namespace },
          },
        });
      } catch (e) {
        if (!isAlreadyExists(e)) throw e;
      }

      // d. Role + RoleBinding letting the SA patch the RVPS ConfigMap.
      try {
        await k8sCreate({
          model: RoleModel,
          data: {
            apiVersion: 'rbac.authorization.k8s.io/v1',
            kind: 'Role',
            metadata: { name: P, namespace },
            rules: [
              {
                apiGroups: [''],
                resources: ['configmaps'],
                verbs: ['get', 'patch', 'update'],
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
            metadata: { name: P, namespace },
            roleRef: {
              apiGroup: 'rbac.authorization.k8s.io',
              kind: 'Role',
              name: P,
            },
            subjects: [{ kind: 'ServiceAccount', name: P, namespace }],
          } as ConfigMapKind & { roleRef: unknown; subjects: unknown[] },
        });
      } catch (e) {
        if (!isAlreadyExists(e)) throw e;
      }

      // e. Delete any prior Job (Jobs are immutable), then create a fresh one.
      const script = buildScript({
        tee,
        ocpVersion: ocpVersion.trim(),
        gpu,
        xfamFeatures: xfam
          .split(',')
          .map((f) => f.trim())
          .filter((f) => f.length > 0),
        rvpsConfigMap,
        namespace,
        hasInitdata,
      });

      const jobResource: JobKind & Record<string, unknown> = {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name: P, namespace },
        spec: {
          backoffLimit: 1,
          template: {
            spec: {
              serviceAccountName: P,
              restartPolicy: 'Never',
              containers: [
                {
                  name: 'veritas',
                  image: COCO_TOOLS_IMAGE,
                  // HOME=/tmp: under the restricted SCC the Job runs as a non-root
                  // UID with HOME=/, which isn't writable; veritas caches under HOME.
                  env: [{ name: 'HOME', value: '/tmp' }],
                  command: ['bash', '-c'],
                  args: [script],
                  volumeMounts: [
                    ...(hasInitdata ? [{ name: 'initdata', mountPath: '/initdata' }] : []),
                    { name: 'auth', mountPath: '/auth' },
                  ],
                },
              ],
              volumes: [
                ...(hasInitdata ? [{ name: 'initdata', configMap: { name: initdataCmName } }] : []),
                {
                  name: 'auth',
                  secret: {
                    secretName: pullSecretName,
                    items: [{ key: '.dockerconfigjson', path: '.dockerconfigjson' }],
                  },
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

  return (
    <Modal isOpen variant="medium" onClose={onClose} aria-label={t('Generate reference values')}>
      <ModalHeader title={t('Generate reference values')} />
      <ModalBody>
        <Form>
          <Alert
            variant="info"
            isInline
            title={t('How this works')}
            className="trustee-openshift-console-plugin__mb"
          >
            {t(
              'This runs the veritas tool in an in-cluster Job (using the cluster pull secret to fetch the OpenShift release image) and writes the result into the {{cm}} ConfigMap. It can take a few minutes. The Reference values editor below reflects the result once the Job succeeds.',
              { cm: rvpsConfigMap },
            )}
          </Alert>

          <FormGroup label={t('OpenShift version')} isRequired fieldId="rvgen-ocp">
            <TextInput
              id="rvgen-ocp"
              value={ocpVersion}
              isDisabled={started}
              onChange={(_e, v) => {
                setOcpVersion(v);
              }}
              placeholder={t('for example, 4.21.0')}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  {t(
                    'The OpenShift release whose extensions image veritas pulls to compute measurements. Defaulted from the cluster version.',
                  )}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          <FormGroup label={t('initdata.toml (optional)')} fieldId="rvgen-initdata">
            <TextArea
              id="rvgen-initdata"
              value={initdata}
              isDisabled={started}
              onChange={(_e, v) => {
                setInitdata(v);
              }}
              rows={8}
              resizeOrientation="vertical"
              aria-label={t('initdata.toml')}
              placeholder={t('Optional — paste an initdata.toml to fold its measurement in')}
              style={{ fontFamily: 'var(--pf-t--global--font--family--mono)' }}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  {t(
                    'Optional. Leave empty to generate just the platform (TEE firmware/kernel) measurements; add an initdata’s PCR8 separately from the Initdata tab. If you paste an initdata.toml here, its measurement is folded in too.',
                  )}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          <FormGroup fieldId="rvgen-gpu">
            <Checkbox
              id="rvgen-gpu"
              label={t('Generate measurements for GPU pods (--gpu)')}
              isChecked={gpu}
              isDisabled={started}
              onChange={(_e, checked) => {
                setGpu(checked);
              }}
            />
          </FormGroup>

          <FormGroup label={t('Allowed XFAM features (--hw-xfam-allow)')} fieldId="rvgen-xfam">
            <TextInput
              id="rvgen-xfam"
              value={xfam}
              isDisabled={started}
              onChange={(_e, v) => {
                setXfam(v);
              }}
              placeholder="x87,sse,avx"
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  {t(
                    'Comma-separated TEE XFAM features to allow. veritas warns that without these the default attestation policy’s xfam check fails. Edit to match your hardware.',
                  )}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          {error && (
            <Alert variant="danger" isInline title={t('Could not start generation')}>
              {error}
            </Alert>
          )}

          {started && (
            <>
              {active && (
                <Alert
                  variant="info"
                  isInline
                  customIcon={<Spinner size="md" />}
                  title={t('Generating reference values…')}
                >
                  {t(
                    'The veritas Job is running. This pulls the OpenShift release image and computes measurements; it can take a few minutes.',
                  )}
                </Alert>
              )}
              {succeeded && (
                <Alert variant="success" isInline title={t('Reference values written')}>
                  {t(
                    'veritas finished and the measurements were written into {{cm}}. The Reference values editor below now reflects them.',
                    { cm: rvpsConfigMap },
                  )}
                </Alert>
              )}
              {failed && (
                <Alert variant="danger" isInline title={t('Generation failed')}>
                  {t(
                    'The veritas Job failed. Open the Job to view its pod logs — common causes are an invalid initdata.toml, an unreachable OpenShift release image, or a pull-secret problem.',
                  )}
                </Alert>
              )}
              {!active && !succeeded && !failed && (
                <Alert
                  variant="info"
                  isInline
                  customIcon={<Spinner size="md" />}
                  title={t('Starting the Job…')}
                />
              )}
              <Split hasGutter className="trustee-openshift-console-plugin__mt">
                <SplitItem>
                  <ResourceLink groupVersionKind={JobGVK} name={P} namespace={namespace} />
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
            onClick={() => void onGenerate()}
            isLoading={busy}
            isDisabled={busy || !valid}
          >
            {t('Generate')}
          </Button>
        )}
        <Button variant={started ? 'primary' : 'link'} onClick={onClose} isDisabled={busy}>
          {t('Close')}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

export default GenerateReferenceValuesModal;
