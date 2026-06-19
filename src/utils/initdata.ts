// Build and encode Kata "initdata" entirely in the browser — no backend, no new deps.
// Initdata is authored on the Trustee (attestation authority) side: its PCR8 measurement
// is added to the RVPS reference values, and the gzip+base64 annotation is shared with the
// confidential-workload owner to put on their pod.
//   initdata.toml  ->  gzip | base64   (the cc_init_data pod annotation)
//   PCR8_HASH = sha256( 32 zero bytes || <algorithm>(initdata.toml) )   (for RVPS)

export type HashAlgo = 'sha256' | 'sha384' | 'sha512';

const SUBTLE: Record<HashAlgo, string> = {
  sha256: 'SHA-256',
  sha384: 'SHA-384',
  sha512: 'SHA-512',
};

/** Kata Agent policy requests, in the order the doc lists them, with the permissive defaults. */
export const POLICY_DEFAULTS: ReadonlyArray<readonly [string, boolean]> = [
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

/** The security-sensitive requests we surface as toggles in the UI. */
export const SENSITIVE_REQUESTS = [
  'ExecProcessRequest',
  'ReadStreamRequest',
  'WriteStreamRequest',
  'SetPolicyRequest',
  'PullImageRequest',
] as const;

export type SensitiveRequest = (typeof SENSITIVE_REQUESTS)[number];

export interface InitdataInput {
  trusteeUrl: string;
  algorithm: HashAlgo;
  /** PEM certificate (full PEM or just the base64 body). Optional — omit for insecure_http. */
  kbsCert?: string;
  /** kbs:///default/<secret-policy-name>/<key> — optional, only for image signature verification. */
  imageSecurityPolicyUri?: string;
  /** Overrides for the sensitive requests; anything unset uses POLICY_DEFAULTS. */
  policyOverrides: Partial<Record<SensitiveRequest, boolean>>;
}

const policyRego = (overrides: InitdataInput['policyOverrides']): string => {
  const lines = POLICY_DEFAULTS.map(([name, def]) => {
    const value = name in overrides ? overrides[name as SensitiveRequest] : def;
    return `default ${name} := ${String(value)}`;
  });
  return `package agent_policy\n\n${lines.join('\n')}\n`;
};

/** Render a complete initdata.toml from the builder inputs. */
export const buildInitdataToml = (input: InitdataInput): string => {
  const { trusteeUrl, algorithm, kbsCert, imageSecurityPolicyUri } = input;
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

  return `algorithm = "${algorithm}"
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

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const digestHex = async (algo: HashAlgo, data: Uint8Array): Promise<string> =>
  toHex(await crypto.subtle.digest(SUBTLE[algo], data.buffer as ArrayBuffer));

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

/** PCR8 reference value for RVPS: sha256( 32 zero bytes || <algorithm>(toml) ). */
export const computePcr8 = async (algorithm: HashAlgo, tomlText: string): Promise<string> => {
  const hashHex = await digestHex(algorithm, new TextEncoder().encode(tomlText));
  const initialPcr = '00'.repeat(32);
  return digestHex('sha256', hexToBytes(initialPcr + hashHex));
};

export interface InitdataResult {
  toml: string;
  /** gzip+base64 — the io.katacontainers.config.hypervisor.cc_init_data annotation. */
  annotation: string;
  /** PCR8 hash — added to the RVPS reference values in Trustee. */
  pcr8: string;
}

export const buildInitdata = async (input: InitdataInput): Promise<InitdataResult> => {
  const toml = buildInitdataToml(input);
  const [annotation, pcr8] = await Promise.all([
    gzipBase64(toml),
    computePcr8(input.algorithm, toml),
  ]);
  return { toml, annotation, pcr8 };
};
