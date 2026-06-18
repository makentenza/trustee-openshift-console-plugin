import { useMemo, useState } from 'react';
import type { FC } from 'react';
import { useTranslation } from 'react-i18next';
import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Button,
  ClipboardCopy,
  Content,
  ExpandableSection,
  Flex,
  FlexItem,
  FormSelect,
  FormSelectOption,
  PageSection,
} from '@patternfly/react-core';
import ConfigMapEditor from '../shared/ConfigMapEditor';
import GenerateReferenceValuesModal from '../GenerateReferenceValuesModal';
import { ClusterVersionGVK, NodeGVK } from '../../k8s/resources';
import type { NodeKind } from '../../k8s/types';
import { detectClusterTee } from '../../utils/topology';
import type { TrusteeTabProps } from './types';
import '../trustee.css';

type Tee = 'tdx' | 'snp';

/** Minimal ClusterVersion shape — we read status.desired.version. */
type ClusterVersionKind = K8sResourceCommon & {
  status?: { desired?: { version?: string } };
};

/** Edit the RVPS reference values (expected measurements, incl. the initdata PCR8). */
const TrusteeReferenceValuesTab: FC<TrusteeTabProps> = ({ obj }) => {
  const { t } = useTranslation('plugin__trustee-openshift-console-plugin');
  const [teeOverride, setTeeOverride] = useState<Tee | undefined>();
  const [modalOpen, setModalOpen] = useState(false);
  const name = obj?.metadata?.name;
  const namespace = obj?.metadata?.namespace ?? '';

  // Auto-detect the TEE platform from node NFD labels so the generator targets the
  // right hardware without a manual pick (a wrong choice makes evidence never
  // match, with no error). The user can still override via the selector; we derive
  // the effective value rather than syncing detection into state in an effect.
  const [nodes] = useK8sWatchResource<NodeKind[]>({ groupVersionKind: NodeGVK, isList: true });
  const detectedTee = useMemo(() => detectClusterTee(nodes ?? []), [nodes]);
  const tee: Tee = teeOverride ?? detectedTee ?? 'tdx';

  // Auto-fill the OCP version veritas should target from the cluster's own version.
  const [clusterVersion] = useK8sWatchResource<ClusterVersionKind>({
    groupVersionKind: ClusterVersionGVK,
    name: 'version',
  }) as [ClusterVersionKind | undefined, boolean, unknown];
  const ocpVersion = clusterVersion?.status?.desired?.version;

  if (!name) {
    return (
      <PageSection>
        <Alert variant="info" isInline title={t('No TrusteeConfig selected')} />
      </PageSection>
    );
  }

  const veritasCmd = [
    `podman run --rm -v ./initdata.toml:/initdata.toml:Z \\`,
    `  quay.io/openshift_sandboxed_containers/coco-tools:1.12 \\`,
    `  veritas --platform baremetal --tee ${tee} -i /initdata.toml > rvps-configmap.yaml`,
    `oc apply -f rvps-configmap.yaml`,
  ].join('\n');

  return (
    <PageSection>
      {modalOpen && (
        <GenerateReferenceValuesModal
          trusteeConfigName={name}
          namespace={namespace}
          tee={tee}
          defaultOcpVersion={ocpVersion}
          onClose={() => {
            setModalOpen(false);
          }}
        />
      )}
      <Alert
        variant="info"
        isInline
        title={t('Reference values must be generated per TEE platform')}
        className="trustee-openshift-console-plugin__mb"
      >
        <Content component="p">
          {t(
            'reference-values.json is empty by default. Generate it for your TEE platform with the veritas tool, then re-import it here. Regenerate and re-apply it after any TEE firmware, OpenShift, or OpenShift sandboxed containers (OSC) upgrade — those change the expected measurements.',
          )}
        </Content>
        <Flex
          alignItems={{ default: 'alignItemsCenter' }}
          gap={{ default: 'gapMd' }}
          className="trustee-openshift-console-plugin__mt trustee-openshift-console-plugin__mb"
        >
          <FlexItem>
            <FormSelect
              value={tee}
              aria-label={t('TEE platform')}
              onChange={(_e, v) => {
                setTeeOverride(v as Tee);
              }}
            >
              <FormSelectOption value="tdx" label={t('Intel TDX')} />
              <FormSelectOption value="snp" label={t('AMD SEV-SNP')} />
            </FormSelect>
          </FlexItem>
          <FlexItem>
            <Button
              variant="primary"
              onClick={() => {
                setModalOpen(true);
              }}
            >
              {t('Generate reference values')}
            </Button>
          </FlexItem>
        </Flex>
        <Content component="p" className="trustee-openshift-console-plugin__muted">
          {detectedTee
            ? t(
                'Detected {{tee}} on this cluster’s nodes (from NFD labels) — pre-selected above.',
                {
                  tee: detectedTee === 'tdx' ? t('Intel TDX') : t('AMD SEV-SNP'),
                },
              )
            : t(
                'No TEE node label (Intel TDX / AMD SEV-SNP) detected on this cluster’s nodes — pick your workload cluster’s platform above.',
              )}
        </Content>
        <ExpandableSection toggleText={t('Manual / advanced (run veritas yourself)')}>
          <Content component="p" className="trustee-openshift-console-plugin__mb">
            {t(
              'Prefer to run veritas outside the cluster? Generate the ConfigMap manually and import it below.',
            )}
          </Content>
          <ClipboardCopy
            isReadOnly
            isCode
            variant="expansion"
            hoverTip={t('Copy')}
            clickTip={t('Copied')}
          >
            {veritasCmd}
          </ClipboardCopy>
        </ExpandableSection>
      </Alert>
      <ConfigMapEditor
        namespace={namespace}
        configMapName={`${name}-rvps-reference-values`}
        title={t('RVPS reference values')}
        description={t(
          'Expected measurement values the Reference Value Provider Service checks against TEE evidence — including the PCR8 hash produced by the initdata builder.',
        )}
        preferredKey="reference-values.json"
      />
    </PageSection>
  );
};

export default TrusteeReferenceValuesTab;
