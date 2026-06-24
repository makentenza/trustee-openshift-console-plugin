import { buildInitdataToml, buildWorkloadPodYaml, type InitdataInput } from './initdata';

const base: InitdataInput = {
  trusteeUrl: 'https://kbs.example.com',
  algorithm: 'sha256',
  policyOverrides: {},
};

// Slice the rendered document into its embedded sub-configs so assertions can target
// aa.toml vs cdh.toml independently.
const section = (toml: string, start: string, end?: string): string => {
  const from = toml.indexOf(start);
  const to = end ? toml.indexOf(end, from + start.length) : toml.length;
  return toml.slice(from, to === -1 ? toml.length : to);
};

describe('buildInitdataToml', () => {
  it('omits the cert from every embedded config when none is supplied (plain HTTP)', () => {
    const toml = buildInitdataToml({ ...base, trusteeUrl: 'http://kbs.example.com:8080' });
    expect(toml).not.toContain('kbs_cert');
    expect(toml).not.toContain('cert = """');
  });

  it('pins the cert in aa.toml (both token_configs) AND cdh.toml — the AA needs it too', () => {
    // Regression guard: the Attestation Agent does the /attest handshake, so the cert
    // must be in aa.toml's token_configs, not only cdh.toml's [kbc]. Omitting it there
    // caused "AA-KBC get token failed" against an HTTPS KBS.
    const toml = buildInitdataToml({ ...base, kbsCert: 'PEMBODY' });

    const aa = section(toml, '"aa.toml"', '"cdh.toml"');
    const cocoAs = section(aa, '[token_configs.coco_as]', '[token_configs.kbs]');
    const kbs = section(aa, '[token_configs.kbs]');
    const cdh = section(toml, '"cdh.toml"', '"policy.rego"');

    expect(cocoAs).toContain('cert = """');
    expect(kbs).toContain('cert = """');
    expect(cdh).toContain('kbs_cert = """');

    // The PEM body is wrapped into all three cert blocks.
    expect(toml.match(/PEMBODY/g) ?? []).toHaveLength(3);
  });

  it('accepts a full PEM and re-wraps it exactly once per cert block', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nABCDEF\n-----END CERTIFICATE-----';
    const toml = buildInitdataToml({ ...base, kbsCert: pem });
    // 3 blocks: aa coco_as, aa kbs, cdh kbc — each with a single BEGIN/END pair.
    expect(toml.match(/-----BEGIN CERTIFICATE-----/g) ?? []).toHaveLength(3);
    expect(toml.match(/-----END CERTIFICATE-----/g) ?? []).toHaveLength(3);
  });

  it('keeps the [image] policy inside cdh.toml only (not aa.toml)', () => {
    const toml = buildInitdataToml({
      ...base,
      imageSecurityPolicyUri: 'kbs:///default/security-policy/test',
    });
    const aa = section(toml, '"aa.toml"', '"cdh.toml"');
    const cdh = section(toml, '"cdh.toml"', '"policy.rego"');
    expect(aa).not.toContain('[image]');
    expect(cdh).toContain('[image]');
  });
});

describe('buildWorkloadPodYaml', () => {
  it('embeds the annotation and a kata-cc pod scaffold', () => {
    const y = buildWorkloadPodYaml({
      annotation: 'H4sIabc',
      source: 'tc',
      kbsUrl: 'http://kbs',
      pcr8: 'deadbeef',
    });
    expect(y).toContain('io.katacontainers.config.hypervisor.cc_init_data: "H4sIabc"');
    expect(y).toContain('runtimeClassName: kata-cc');
    expect(y).toContain('# KBS endpoint: http://kbs');
    expect(y).toContain('# PCR8 (registered in this Trustee'); // header carries pcr8
    expect(y).toContain('authored by Trustee (tc)');
  });

  it('omits the optional comment lines when only the annotation is given', () => {
    const y = buildWorkloadPodYaml({ annotation: 'X' });
    expect(y).toContain('cc_init_data: "X"');
    expect(y).not.toContain('# KBS endpoint:');
    expect(y).not.toContain('# PCR8');
    expect(y).toContain('name: my-confidential-workload');
  });
});
