// Build and encode Kata "initdata" entirely in the browser — no backend, no new deps.
// Initdata is authored on the Trustee (attestation authority) side: its measurement is
// added to the RVPS reference values, and the gzip+base64 annotation is shared with the
// confidential-workload owner to put on their pod.
//   initdata.toml  ->  gzip | base64   (the cc_init_data pod annotation)
//
// The MEASUREMENT differs by platform (validated against the OSC 1.12 Azure docs):
//   * Bare-metal Intel TDX: raw sha256(initdata.toml), placed verbatim in the TD report's
//     48-byte MRCONFIGID / `init_data` register (right zero-padded). RAW padded digest,
//     NOT a TPM PCR-extend. Registered in RVPS as `init_data`.
//   * Cloud peer pods (Azure SEV-SNP or TDX Confidential VM): the guest has a vTPM and the
//     initdata digest is extended into PCR 8:  PCR8 = sha256( 32 zero bytes ‖ sha256(toml) ).
//     Registered in RVPS as the PCR-8 reference value.
// Kata always hashes initdata.toml with sha256 for this, so there is no algorithm choice.

/** The Kata initdata hash is always sha256 (both the TDX register and the vTPM PCR bank). */
const SHA256 = 'SHA-256';

/**
 * Where the confidential workload runs — this decides the runtime class, how the initdata
 * measurement is derived, and the RVPS reference-value name it is registered under.
 */
export type MeasurementPlatform = 'tdx-baremetal' | 'snp-cloud' | 'tdx-cloud';

export interface PlatformMeta {
  id: MeasurementPlatform;
  /** Full label for the selector. */
  label: string;
  /** Short label for inline copy. */
  short: string;
  /** Cloud peer pods (kata-remote in a cloud Confidential VM) vs bare-metal on-node TEE. */
  cloud: boolean;
  /** Runtime class the workload pod must use. */
  runtimeClass: 'kata-cc' | 'kata-remote';
  /** Default RVPS reference-value name the initdata measurement is registered under. */
  refvalName: string;
  /** Human description of the register/measurement the value lands in. */
  measurementKind: string;
}

/**
 * Platform metadata. `refvalName` is the DEFAULT reference-value key; the Initdata tab
 * shows it editable, because the exact cloud vTPM PCR-8 key can vary by Trustee policy and
 * the Trustee admin authoring the initdata knows their setup. Bare-metal TDX is `init_data`
 * (the generic CoCo init-data claim); cloud defaults to `pcr08`.
 */
export const MEASUREMENT_PLATFORMS: Record<MeasurementPlatform, PlatformMeta> = {
  'tdx-baremetal': {
    id: 'tdx-baremetal',
    label: 'Intel TDX — bare metal (on-node TEE)',
    short: 'Intel TDX (bare metal)',
    cloud: false,
    runtimeClass: 'kata-cc',
    refvalName: 'init_data',
    measurementKind: 'TDX MRCONFIGID (init_data register)',
  },
  'snp-cloud': {
    id: 'snp-cloud',
    label: 'AMD SEV-SNP — cloud peer pods',
    short: 'AMD SEV-SNP (cloud)',
    cloud: true,
    runtimeClass: 'kata-remote',
    refvalName: 'pcr08',
    measurementKind: 'vTPM PCR 8',
  },
  'tdx-cloud': {
    id: 'tdx-cloud',
    label: 'Intel TDX — cloud peer pods',
    short: 'Intel TDX (cloud)',
    cloud: true,
    runtimeClass: 'kata-remote',
    refvalName: 'pcr08',
    measurementKind: 'vTPM PCR 8',
  },
};

export const PLATFORM_ORDER: MeasurementPlatform[] = ['tdx-baremetal', 'snp-cloud', 'tdx-cloud'];

/**
 * The default RVPS reference-value names the initdata measurement may be registered under
 * across platforms (init_data for bare-metal TDX, pcr08 for cloud peer pods). Used to detect
 * "initdata is registered" regardless of environment, without assuming the bare-metal name.
 */
export const INITDATA_REFVAL_NAMES: string[] = Array.from(
  new Set(PLATFORM_ORDER.map((p) => MEASUREMENT_PLATFORMS[p].refvalName)),
);

/** Kata Agent policy requests, in the order the doc lists them, with the permissive defaults. */
export const POLICY_DEFAULTS: readonly (readonly [string, boolean])[] = [
  ['AddARPNeighborsRequest', true],
  ['AddSwapRequest', true],
  ['CloseStdinRequest', true],
  ['CopyFileRequest', true],
  ['CreateContainerRequest', true],
  ['CreateSandboxRequest', true],
  ['DestroySandboxRequest', true],
  ['GetMetricsRequest', true],
  ['GetOOMEventRequest', true],
  ['GuestDetailsRequest', true],
  ['ListInterfacesRequest', true],
  ['ListRoutesRequest', true],
  ['MemHotplugByProbeRequest', true],
  ['OnlineCPUMemRequest', true],
  ['PauseContainerRequest', true],
  ['PullImageRequest', true],
  ['ReadStreamRequest', false],
  ['RemoveContainerRequest', true],
  ['RemoveStaleVirtiofsShareMountsRequest', true],
  ['ReseedRandomDevRequest', true],
  ['ResumeContainerRequest', true],
  ['SetGuestDateTimeRequest', true],
  ['SignalProcessRequest', true],
  ['StartContainerRequest', true],
  ['StartTracingRequest', true],
  ['StatsContainerRequest', true],
  ['StopTracingRequest', true],
  ['TtyWinResizeRequest', true],
  ['UpdateContainerRequest', true],
  ['UpdateEphemeralMountsRequest', true],
  ['UpdateInterfaceRequest', true],
  ['UpdateRoutesRequest', true],
  ['WaitProcessRequest', true],
  ['ExecProcessRequest', false],
  ['SetPolicyRequest', false],
  ['WriteStreamRequest', false],
];

// Any request name is a valid override key; POLICY_DEFAULTS covers the rest.
export type SensitiveRequest = string;

/**
 * The one policy toggle we surface in the UI. The doc-critical control is disabling
 * `ExecProcessRequest` (no `oc exec` into the confidential VM). Everything else keeps its
 * secure POLICY_DEFAULTS value; in particular PullImageRequest stays true (disabling it
 * breaks the container) and Set/WriteStream stay false — so we don't expose footgun toggles
 * that only invite reference-value mismatches.
 */
export const SENSITIVE_REQUESTS = ['ExecProcessRequest'] as const;

export interface InitdataInput {
  trusteeUrl: string;
  /** Where the workload runs — selects runtime class + how the measurement is derived. */
  platform: MeasurementPlatform;
  /** PEM certificate (full PEM or just the base64 body). Optional — omit for insecure_http. */
  kbsCert?: string;
  /** kbs:///default/<secret-policy-name>/<key> — optional, only for image signature verification. */
  imageSecurityPolicyUri?: string;
  /** Overrides for the sensitive requests; anything unset uses POLICY_DEFAULTS. */
  policyOverrides: Partial<Record<SensitiveRequest, boolean>>;
}

const policyRego = (overrides: InitdataInput['policyOverrides']): string => {
  const lines = POLICY_DEFAULTS.map(([name, def]) => {
    const value = name in overrides ? overrides[name] : def;
    return `default ${name} := ${String(value)}`;
  });
  return `package agent_policy\n\n${lines.join('\n')}\n`;
};

/** Render a complete initdata.toml from the builder inputs. */
export const buildInitdataToml = (input: InitdataInput): string => {
  const { trusteeUrl, kbsCert, imageSecurityPolicyUri } = input;
  // Accept either a full PEM (with BEGIN/END lines) or just the base64 body —
  // strip any markers the user pasted, then re-wrap exactly once.
  const certBody = kbsCert
    ?.replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .trim();
  const certBlock = certBody
    ? `kbs_cert = """\n-----BEGIN CERTIFICATE-----\n${certBody}\n-----END CERTIFICATE-----\n"""\n`
    : '';
  // The same cert must ALSO be pinned in aa.toml's token_configs. The Attestation
  // Agent performs the KBS attestation handshake itself (POST /kbs/v0/attest), so it
  // needs the cert to validate an HTTPS KBS — without it the AA fails with
  // "AA-KBC get token failed" and the whole resource fetch fails, even though cdh.toml
  // carries kbs_cert (CDH only does the post-attestation resource GET). The aa.toml
  // field is `cert` (not `kbs_cert`). See trustee-initdata-hubspoke-bugs.
  const aaCertBlock = certBody
    ? `cert = """\n-----BEGIN CERTIFICATE-----\n${certBody}\n-----END CERTIFICATE-----\n"""\n`
    : '';
  // NB: the [image] table must live INSIDE the cdh.toml heredoc (CDH reads
  // image_security_policy_uri from cdh.toml). It is appended before the closing
  // ''' below — not after, or it would land at the document's top level and the
  // policy would be silently dropped (and the TOML — and PCR8 over it — malformed).
  const imageBlock = imageSecurityPolicyUri
    ? `[image]\nimage_security_policy_uri = '${imageSecurityPolicyUri}'\n`
    : '';

  return `algorithm = "sha256"
version = "0.1.0"
[data]
"aa.toml" = '''
[token_configs]
[token_configs.coco_as]
url = '${trusteeUrl}'
${aaCertBlock}
[token_configs.kbs]
url = '${trusteeUrl}'
${aaCertBlock}'''
"cdh.toml" = '''
socket = 'unix:///run/confidential-containers/cdh.sock'
credentials = []

[kbc]
name = 'cc_kbc'
url = '${trusteeUrl}'
${certBlock}${imageBlock}'''
"policy.rego" = '''
${policyRego(input.policyOverrides)}'''
`;
};

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const sha256 = (data: Uint8Array): Promise<ArrayBuffer> =>
  crypto.subtle.digest(SHA256, data.buffer as ArrayBuffer);

const sha256Hex = async (data: Uint8Array): Promise<string> => toHex(await sha256(data));

/** gzip(text) then base64 — the value of the cc_init_data pod annotation. */
export const gzipBase64 = async (text: string): Promise<string> => {
  const stream = new CompressionStream('gzip');
  const writer = stream.writable.getWriter();
  void writer.write(new TextEncoder().encode(text));
  void writer.close();
  const buf = await new Response(stream.readable).arrayBuffer();
  let binary = '';
  new Uint8Array(buf).forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
};

/**
 * Bare-metal Intel TDX initdata measurement: the `init_data` claim Trustee's TDX verifier
 * surfaces and the OPA policy compares to the RVPS reference value. The kata guest hashes
 * initdata.toml with sha256 and the host writes that 32-byte digest into the TD report's
 * 48-byte MRCONFIGID register, right zero-padded (32 B digest + 16 zero bytes).
 *
 * This is the RAW padded digest, NOT a TPM PCR-extend. Verified against a live TD quote's
 * mr_config_id.
 */
export const computeInitDataMrConfigId = async (tomlText: string): Promise<string> => {
  const digestHexStr = await sha256Hex(new TextEncoder().encode(tomlText));
  // MRCONFIGID is 48 bytes (96 hex): pad the 32-byte sha256 digest with trailing zeros.
  return (digestHexStr + '0'.repeat(96)).slice(0, 96);
};

/**
 * Cloud peer-pod initdata measurement (Azure SEV-SNP / TDX Confidential VM). The guest has a
 * vTPM and extends the initdata digest into PCR 8 from a zeroed PCR:
 *   PCR8 = sha256( 32 zero bytes ‖ sha256(initdata.toml) )
 * — a standard TPM extend, so the value is a 32-byte (64-hex) sha256 digest.
 */
export const computePcr8 = async (tomlText: string): Promise<string> => {
  const inner = await sha256(new TextEncoder().encode(tomlText));
  const extend = new Uint8Array(32 + 32); // 32 zero bytes (initial PCR) ‖ measurement digest
  extend.set(new Uint8Array(inner), 32);
  return sha256Hex(extend);
};

/** Compute the initdata measurement for the given platform. */
export const computeMeasurement = (
  platform: MeasurementPlatform,
  tomlText: string,
): Promise<string> =>
  MEASUREMENT_PLATFORMS[platform].cloud
    ? computePcr8(tomlText)
    : computeInitDataMrConfigId(tomlText);

export interface InitdataResult {
  toml: string;
  /** gzip+base64 — the io.katacontainers.config.hypervisor.cc_init_data annotation. */
  annotation: string;
  /** Initdata measurement — TDX MRCONFIGID (bare metal) or vTPM PCR 8 (cloud). */
  measurement: string;
  /** The platform the measurement was computed for. */
  platform: MeasurementPlatform;
}

export const buildInitdata = async (input: InitdataInput): Promise<InitdataResult> => {
  const toml = buildInitdataToml(input);
  const [annotation, measurement] = await Promise.all([
    gzipBase64(toml),
    computeMeasurement(input.platform, toml),
  ]);
  return { toml, annotation, measurement, platform: input.platform };
};

export interface WorkloadPodYamlInput {
  /** gzip+base64 cc_init_data annotation value (required). */
  annotation: string;
  /** Source TrusteeConfig name, for the comment header. */
  source?: string;
  /** KBS endpoint baked into the initdata. */
  kbsUrl?: string;
  /** Initdata measurement registered in the Trustee's reference values. */
  measurement?: string;
  /** Platform the initdata targets — decides the runtime class. Defaults to bare-metal TDX. */
  platform?: MeasurementPlatform;
  /** Pod name to scaffold. */
  podName?: string;
}

/**
 * Sample confidential Pod YAML carrying the cc_init_data annotation — what the
 * Initdata tab offers for download, both right after generating and later from the
 * "Saved initdata" list, so the value is the same regardless of where it's grabbed.
 * The runtime class follows the platform: kata-remote for cloud peer pods (Azure
 * Confidential VMs), kata-cc for bare-metal on-node TEE.
 */
export const buildWorkloadPodYaml = (input: WorkloadPodYamlInput): string => {
  const {
    annotation,
    source,
    kbsUrl,
    measurement,
    platform = 'tdx-baremetal',
    podName = 'my-confidential-workload',
  } = input;
  const meta = MEASUREMENT_PLATFORMS[platform];
  return [
    `# Confidential workload initdata${source ? ` — authored by Trustee (${source})` : ''}`,
    ...(kbsUrl ? [`# KBS endpoint: ${kbsUrl}`] : []),
    `# Platform: ${meta.short}`,
    ...(measurement
      ? [
          `# Measurement — ${meta.measurementKind} (registered in this Trustee as ${meta.refvalName}):`,
          `#   ${measurement}`,
        ]
      : []),
    '#',
    '# Put the annotation below on your confidential Pod, then deploy it.',
    'apiVersion: v1',
    'kind: Pod',
    'metadata:',
    `  name: ${podName}`,
    '  annotations:',
    `    io.katacontainers.config.hypervisor.cc_init_data: "${annotation}"`,
    'spec:',
    `  runtimeClassName: ${meta.runtimeClass}`,
    '  containers:',
    '    - name: app',
    '      image: <your-image>',
    '',
  ].join('\n');
};
