import type { FC } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { k8sCreate, k8sDelete, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
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

interface Props {
  trusteeConfigName: string;
  namespace: string;
  ingressDomain?: string;
  defaultSecretName?: string;
  onCreated: (secretName: string) => void;
  onClose: () => void;
}

/**
 * The in-cluster Job: openssl mints a CA and a server leaf it signs, then curl
 * server-side-applies them as a kubernetes.io/tls Secret (tls.crt = leaf, tls.key,
 * ca.crt = the CA) using the Job's own ServiceAccount token. The private key is
 * generated inside the cluster and never reaches the browser.
 *
 * Why a CA → leaf chain (not a single self-signed cert): the in-guest Confidential
 * Data Hub validates the KBS with rustls/webpki, which REJECTS a self-signed CA:TRUE
 * certificate presented as the server leaf. KBS must serve an end-entity leaf
 * (serverAuth, CA:FALSE) signed by a separate CA, and the workload pins that CA
 * (the secret's ca.crt) in its initdata.
 */
const buildScript = (opts: {
  secret: string;
  cn: string;
  san: string;
  namespace: string;
}): string => {
  const { secret, cn, san, namespace } = opts;
  return [
    'set -e',
    'cd /tmp',
    // 1. CA (self-signed root) — the trust anchor the workload pins in its initdata.
    'openssl genrsa -out ca.key 2048',
    `openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -subj "/CN=${cn} Root CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -out ca.crt`,
    // 2. Server leaf — end-entity (CA:FALSE), serverAuth EKU, SAN = the KBS hostnames.
    'openssl genrsa -out tls.key 2048',
    `openssl req -new -key tls.key -subj "/CN=${cn}" -out tls.csr`,
    `printf 'basicConstraints=critical,CA:FALSE\\nkeyUsage=critical,digitalSignature,keyEncipherment\\nextendedKeyUsage=serverAuth\\nsubjectAltName=${san}\\n' > leaf.ext`,
    'openssl x509 -req -in tls.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 -sha256 -extfile leaf.ext -out tls.crt',
    'B64CRT=$(base64 -w0 tls.crt)',
    'B64KEY=$(base64 -w0 tls.key)',
    'B64CA=$(base64 -w0 ca.crt)',
    'TOKEN=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)',
    'KUBECA=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
    'API="https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT}"',
    // KBS serves tls.crt/tls.key (the leaf); ca.crt is the anchor the workload pins.
    `printf '{"apiVersion":"v1","kind":"Secret","metadata":{"name":"%s"},"type":"kubernetes.io/tls","data":{"tls.crt":"%s","tls.key":"%s","ca.crt":"%s"}}' "${secret}" "$B64CRT" "$B64KEY" "$B64CA" > secret.json`,
    `curl -sS --fail-with-body --cacert "$KUBECA" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/apply-patch+yaml" -X PATCH "\${API}/api/v1/namespaces/${namespace}/secrets/${secret}?fieldManager=trustee-tls-gen&force=true" --data-binary @secret.json`,
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
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
        await k8sDelete({ model: JobModel, resource: jobResource });
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      await k8sCreate({ model: JobModel, data: jobResource });
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
          <Alert variant="info" isInline title={t('How this works')} className={`${PREFIX}__mb`}>
            {t(
              'Runs a short in-cluster Job that mints a CA and a server certificate it signs (openssl), stored as a kubernetes.io/tls Secret: tls.crt + tls.key are the leaf KBS serves, ca.crt is the CA the workload pins in its initdata. A proper CA→leaf chain is required — the in-guest Confidential Data Hub rejects a single self-signed certificate. The private key is created inside the cluster and never reaches your browser.',
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
                    ? t(
                        'SAN: {{cn}} (in-cluster) and *.{{domain}} (covers Routes for remote spokes).',
                        {
                          cn: cn.trim(),
                          domain: ingressDomain,
                        },
                      )
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
            {t('Leaves a Job and its ServiceAccount/Role/RoleBinding named {{p}} behind.', {
              p: P,
            })}
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
