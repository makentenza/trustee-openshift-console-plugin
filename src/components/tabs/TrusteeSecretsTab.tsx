import { useState } from 'react';
import type { FC } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ResourceLink,
  k8sCreate,
  k8sPatch,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardTitle,
  Flex,
  FlexItem,
  Form,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  PageSection,
  TextArea,
  TextInput,
} from '@patternfly/react-core';
import { PlusCircleIcon } from '@patternfly/react-icons';
import { KbsConfigGVK, KbsConfigModel, SecretGVK, SecretModel } from '../../k8s/resources';
import type { KbsConfigKind, SecretKind } from '../../k8s/types';
import type { TrusteeTabProps } from './types';
import '../trustee.css';

const TRUSTED_ARTIFACT_SIGNER_URL =
  'https://www.redhat.com/en/technologies/cloud-computing/openshift/trusted-artifact-signer';

/** Parse `key=value` lines (or `key: value`) from the textarea into a data map. */
const parseLiterals = (text: string): { data: Record<string, string>; error?: string } => {
  const data: Record<string, string> = {};
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (const line of lines) {
    const eq = line.indexOf('=');
    const colon = line.indexOf(':');
    const sep = eq >= 0 && (colon < 0 || eq < colon) ? eq : colon;
    if (sep <= 0) {
      return { data, error: `Could not parse "${line}" — expected key=value.` };
    }
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (!key) {
      return { data, error: `Empty key in "${line}".` };
    }
    data[key] = value;
  }
  return { data };
};

interface CreateSecretModalProps {
  namespace: string;
  kbsConfig?: KbsConfigKind;
  onClose: () => void;
}

/**
 * Creates an Opaque Secret and appends its name to the KbsConfig's
 * spec.kbsSecretResources so the operator brokers it to attested workloads
 * (attestation-status, image-signature / img-sig, security-policy, …).
 */
const CreateSecretModal: FC<CreateSecretModalProps> = ({ namespace, kbsConfig, onClose }) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const [secretName, setSecretName] = useState('');
  const [literals, setLiterals] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const valid = secretName.trim() !== '' && literals.trim() !== '';

  const onCreate = async () => {
    setBusy(true);
    setError('');
    const name = secretName.trim();
    const { data, error: parseError } = parseLiterals(literals);
    if (parseError) {
      setError(parseError);
      setBusy(false);
      return;
    }
    try {
      const secret: SecretKind = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name, namespace },
        type: 'Opaque',
        // stringData (cleartext) is base64-encoded by the API server on write.
        stringData: data,
      };
      await k8sCreate({ model: SecretModel, data: secret });

      // Register the secret for delivery on the KbsConfig, if we have one.
      if (kbsConfig) {
        const existing = kbsConfig.spec?.kbsSecretResources ?? [];
        if (!existing.includes(name)) {
          const hasArray = Array.isArray(kbsConfig.spec?.kbsSecretResources);
          const hasSpec = Boolean(kbsConfig.spec);
          await k8sPatch<KbsConfigKind>({
            model: KbsConfigModel,
            resource: kbsConfig,
            data: [
              hasArray
                ? { op: 'add', path: '/spec/kbsSecretResources/-', value: name }
                : hasSpec
                  ? { op: 'add', path: '/spec/kbsSecretResources', value: [name] }
                  : { op: 'add', path: '/spec', value: { kbsSecretResources: [name] } },
            ],
          });
        }
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen variant="medium" onClose={onClose} aria-label={t('Create secret')}>
      <ModalHeader title={t('Create delivered secret')} />
      <ModalBody>
        <Form>
          <FormGroup label={t('Secret name')} isRequired fieldId="trustee-secret-name">
            <TextInput
              id="trustee-secret-name"
              value={secretName}
              onChange={(_e, v) => {
                setSecretName(v);
              }}
              placeholder={t('for example, attestation-status, img-sig, security-policy')}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  {t('Created as an Opaque Secret in namespace "{{namespace}}".', { namespace })}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>
          <FormGroup
            label={t('Data (key=value per line)')}
            isRequired
            fieldId="trustee-secret-data"
          >
            <TextArea
              id="trustee-secret-data"
              value={literals}
              onChange={(_e, v) => {
                setLiterals(v);
              }}
              rows={6}
              resizeOrientation="vertical"
              aria-label={t('Secret data')}
              placeholder={'key1=value1\nkey2=value2'}
              style={{ fontFamily: 'var(--pf-t--global--font--family--mono)' }}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  {t(
                    'One key=value per line. Values are stored via stringData (the API server base64-encodes them).',
                  )}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>
          {error && (
            <Alert variant="danger" isInline title={t('Could not create secret')}>
              {error}
            </Alert>
          )}
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button
          variant="primary"
          onClick={() => void onCreate()}
          isLoading={busy}
          isDisabled={busy || !valid}
        >
          {t('Create')}
        </Button>
        <Button variant="link" onClick={onClose} isDisabled={busy}>
          {t('Cancel')}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

/** View the secrets the operator brokers to workloads, and create new ones. */
const TrusteeSecretsTab: FC<TrusteeTabProps> = ({ obj }) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const name = obj?.metadata?.name;
  const namespace = obj?.metadata?.namespace ?? '';
  const [modalOpen, setModalOpen] = useState(false);

  const [kbs] = useK8sWatchResource<KbsConfigKind>({
    groupVersionKind: KbsConfigGVK,
    name: name ? `${name}-kbsconfig` : undefined,
    namespace,
  }) as [KbsConfigKind | undefined, boolean, unknown];

  const generated = name ? [`${name}-kbs-auth`, `${name}-https`, `${name}-attestation-token`] : [];
  const delivered = kbs?.spec?.kbsSecretResources ?? [];

  return (
    <PageSection>
      {modalOpen && (
        <CreateSecretModal
          namespace={namespace}
          kbsConfig={kbs}
          onClose={() => {
            setModalOpen(false);
          }}
        />
      )}
      <Card className="trustee-openshift-console-plugin__mb">
        <CardTitle>{t('Operator-generated secrets')}</CardTitle>
        <CardBody>
          <Flex direction={{ default: 'column' }} gap={{ default: 'gapSm' }}>
            {generated.map((s) => (
              <FlexItem key={s}>
                <ResourceLink groupVersionKind={SecretGVK} name={s} namespace={namespace} />
              </FlexItem>
            ))}
          </Flex>
        </CardBody>
      </Card>
      <Card>
        <CardTitle>
          <Flex
            justifyContent={{ default: 'justifyContentSpaceBetween' }}
            alignItems={{ default: 'alignItemsCenter' }}
          >
            <FlexItem>{t('Delivered to attested workloads (kbsSecretResources)')}</FlexItem>
            <FlexItem>
              <Button
                variant="secondary"
                icon={<PlusCircleIcon />}
                onClick={() => {
                  setModalOpen(true);
                }}
                isDisabled={!name}
              >
                {t('Create secret')}
              </Button>
            </FlexItem>
          </Flex>
        </CardTitle>
        <CardBody>
          <Alert
            variant="info"
            isInline
            title={t('Adding secrets for delivery')}
            className="trustee-openshift-console-plugin__mb"
          >
            <p>
              {t(
                'Create secret adds an Opaque Secret and registers its name on the KbsConfig spec.kbsSecretResources so the operator brokers it after attestation. Use this for attestation-status, image-signature (img-sig), and security-policy resources.',
              )}
            </p>
            <p className="trustee-openshift-console-plugin__mt">
              {t('You can also edit the KbsConfig directly from the ')}
              <ResourceLink
                groupVersionKind={KbsConfigGVK}
                name={name ? `${name}-kbsconfig` : undefined}
                namespace={namespace}
                inline
              />
              {t(' resource (or the KbsConfigs nav entry). To produce image-signing keys, see ')}
              <a href={TRUSTED_ARTIFACT_SIGNER_URL} target="_blank" rel="noopener noreferrer">
                {t('Red Hat Trusted Artifact Signer')}
              </a>
              .
            </p>
          </Alert>
          {delivered.length === 0 ? (
            <span className="trustee-openshift-console-plugin__muted">
              {t('No secret resources are configured for delivery yet.')}
            </span>
          ) : (
            <Flex direction={{ default: 'column' }} gap={{ default: 'gapSm' }}>
              {delivered.map((s) => (
                <FlexItem key={s}>
                  <ResourceLink groupVersionKind={SecretGVK} name={s} namespace={namespace} />
                </FlexItem>
              ))}
            </Flex>
          )}
        </CardBody>
      </Card>
    </PageSection>
  );
};

export default TrusteeSecretsTab;
