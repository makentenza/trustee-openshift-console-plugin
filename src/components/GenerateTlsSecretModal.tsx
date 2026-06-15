import type { FC } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  k8sCreate,
  k8sDelete,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Button,
  Content,
  Form,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  TextInput,
} from '@patternfly/react-core';
import {
  JobGVK,
  JobModel,
  RoleBindingModel,
  RoleModel,
  ServiceAccountModel,
  UBI9_IMAGE,
} from '../k8s/resources';
import type { JobKind } from '../k8s/types';

const PREFIX = 'trustee-openshift-console-plugin';
const DNS_1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

const isNotFound = (e: unknown): boolean =>
  /not found|notfound|404/i.test(e instanceof Error ? e.message : String(e));

type Props = {
  trusteeConfigName: string;
  namespace: string;
  ingressDomain?: string;
  defaultSecretName?: string;
  onCreated: (secretName: string) => void;
  onClose: () => void;
};

/**
 * The in-cluster Job: openssl generates a self-signed cert+key, then curl
 * server-side-applies it as a kubernetes.io/tls Secret using the Job's own
 * ServiceAccount token. The private key is generated inside the cluster and never
 * reaches the browser.
 */
const buildScript = (opts: { secret: string; cn: string; san: string; namespace: string }): string => {
  const { secret, cn, san, namespace } = opts;
  return [
    'set -e',
    'cd /tmp',
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout tls.key -out tls.crt -subj "/CN=${cn}" -addext "subjectAltName=${san}" -days 825`,
    'B64CRT=$(base64 -w0 tls.crt)',
    'B64KEY=$(base64 -w0 tls.key)',
    'TOKEN=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)',
    'CA=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
    'API="https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT}"',
    `printf '{"apiVersion":"v1","kind":"Secret","metadata":{"name":"%s"},"type":"kubernetes.io/tls","data":{"tls.crt":"%s","tls.key":"%s"}}' "${secret}" "$B64CRT" "$B64KEY" > secret.json`,
    `curl -sS --fail-with-body --cacert "$CA" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/apply-patch+yaml" -X PATCH "\${API}/api/v1/namespaces/${namespace}/secrets/${secret}?fieldManager=trustee-tls-gen&force=true" --data-binary @secret.json`,
    `echo "CREATED ${secret}"`,
  ].join('\n');
};

const GenerateTlsSecretModal: FC<Props> = ({
  trusteeConfigName,
  namespace,
  ingressDomain,
  defaultSecretName,
  onCreated,
  onClose,
}) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');

  const [secretName, setSecretName] = useState(
    defaultSecretName || `${trusteeConfigName || 'kbs'}-https-tls`,
  );
  const [cn, setCn] = useState(`kbs-service.${namespace}.svc`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [started, setStarted] = useState(false);
  const [done, setDone] = useState(false);

  // SANs: the in-cluster Service DNS the user typed, plus the apps wildcard so any
  // passthrough Route on this cluster's ingress domain validates (hub-and-spoke).
  const san = useMemo(() => {
    const names = [`DNS:${cn.trim()}`];
    if (ingressDomain) names.push(`DNS:*.${ingressDomain}`);
    return names.join(',');
  }, [cn, ingressDomain]);

  const P = `${trusteeConfigName || 'kbs'}-tls-gen`;
  const secretValid = DNS_1123.test(secretName.trim()) && secretName.trim().length <= 253;
  const valid = secretValid && cn.trim() !== '';

  const [job] = useK8sWatchResource<JobKind>(
    started ? { groupVersionKind: JobGVK, name: P, namespace } : null,
  ) as [JobKind | undefined, boolean, unknown];

  const active = (job?.status?.active ?? 0) > 0;
  const succeeded = (job?.status?.succeeded ?? 0) > 0;
  const failed =
    (job?.status?.failed ?? 0) > 0 ||
    (job?.status?.conditions ?? []).some((c) => c.type === 'Failed' && c.status === 'True');

  // Once the Job succeeds, hand the secret name back to the wizard (once).
  useEffect(() => {
    if (succeeded && !done) {
      setDone(true);
      onCreated(secretName.trim());
    }
  }, [succeeded, done, onCreated, secretName]);

  const onGenerate = async () => {
    setBusy(true);
    setError('');
    try {
      const sa = {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name: P, namespace },
      };
      const role = {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'Role',
        metadata: { name: P, namespace },
        rules: [
          {
            apiGroups: [''],
            resources: ['secrets'],
            verbs: ['get', 'create', 'patch', 'update'],
          },
        ],
      };
      const rb = {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: { name: P, namespace },
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: P },
        subjects: [{ kind: 'ServiceAccount', name: P, namespace }],
      };
      // Idempotent: recreate the SA/Role/RoleBinding so reruns start clean.
      for (const [model, resource] of [
        [ServiceAccountModel, sa],
        [RoleModel, role],
        [RoleBindingModel, rb],
      ] as const) {
        try {
          await k8sDelete({ model, resource });
        } catch (e) {
          if (!isNotFound(e)) throw e;
        }
        await k8sCreate({ model, data: resource });
      }

      const script = buildScript({ secret: secretName.trim(), cn: cn.trim(), san, namespace });
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
                  name: 'openssl',
                  image: UBI9_IMAGE,
                  env: [{ name: 'HOME', value: '/tmp' }],
                  command: ['bash', '-c'],
                  args: [script],
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
    <Modal isOpen variant="medium" onClose={onClose} aria-label={t('Generate TLS secret')}>
      <ModalHeader title={t('Generate TLS secret')} />
      <ModalBody>
        <Form>
          <Alert
            variant="info"
            isInline
            title={t('How this works')}
            className={`${PREFIX}__mb`}
          >
            {t(
              'Runs a short in-cluster Job that generates a self-signed cert and key with openssl and stores them as a kubernetes.io/tls Secret. The private key is created inside the cluster and never reaches your browser. Substitute your own CA for production.',
            )}
          </Alert>

          <FormGroup label={t('Secret name')} isRequired fieldId="tls-secret">
            <TextInput
              id="tls-secret"
              value={secretName}
              isDisabled={started}
              validated={secretValid ? 'default' : 'error'}
              onChange={(_e, v) => {
                setSecretName(v);
              }}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem variant={secretValid ? 'default' : 'error'}>
                  {secretValid
                    ? t('Created in the {{ns}} namespace; referenced as the HTTPS TLS secret.', {
                        ns: namespace,
                      })
                    : t('Must be a lowercase DNS name (a–z, 0–9, -).')}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          <FormGroup label={t('Certificate hostname (CN)')} isRequired fieldId="tls-cn">
            <TextInput
              id="tls-cn"
              value={cn}
              isDisabled={started}
              onChange={(_e, v) => {
                setCn(v);
              }}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  {ingressDomain
                    ? t('SAN: {{cn}} (in-cluster) and *.{{domain}} (covers Routes for remote spokes).', {
                        cn: cn.trim(),
                        domain: ingressDomain,
                      })
                    : t('Subject and SAN of the cert. Defaults to the in-cluster KBS Service DNS.')}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          {started && !failed && !succeeded && (
            <Alert variant="info" isInline title={t('Generating…')}>
              {active ? t('The openssl Job is running.') : t('Waiting for the Job to start.')}
            </Alert>
          )}
          {succeeded && (
            <Alert variant="success" isInline title={t('TLS secret created')}>
              {t('Secret {{name}} is ready and has been filled into the form.', {
                name: secretName.trim(),
              })}
            </Alert>
          )}
          {failed && (
            <Alert variant="danger" isInline title={t('The generator Job failed')}>
              {t('Check the Job {{job}} in {{ns}} for details.', { job: P, ns: namespace })}
            </Alert>
          )}
          {error && (
            <Alert variant="danger" isInline title={t('Could not start the generator')}>
              {error}
            </Alert>
          )}
          <Content component="small" className={`${PREFIX}__muted`}>
            {t('Leaves a Job and its ServiceAccount/Role/RoleBinding named {{p}} behind.', { p: P })}
          </Content>
        </Form>
      </ModalBody>
      <ModalFooter>
        {!succeeded ? (
          <>
            <Button
              variant="primary"
              onClick={() => void onGenerate()}
              isLoading={busy || (started && !failed)}
              isDisabled={!valid || busy || (started && !failed)}
            >
              {started && failed ? t('Retry') : t('Generate')}
            </Button>
            <Button variant="link" onClick={onClose}>
              {t('Cancel')}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            {t('Done')}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  );
};

export default GenerateTlsSecretModal;
