/**
 * Customer configurations must never enter the repository: the app converts files
 * in the browser precisely so that they never leave the user's computer.
 * These tests fail when a fixture or a test still looks like a real configuration.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { relative } from 'path';
import { describe, expect, it } from 'vitest';
import { FIXTURES_DIR, listFiles, TESTS_DIR } from './support/fixtures';
import { REPOSITORY_DIR } from './support/local-configs';
import { scanConfiguration, scanTestSource } from './support/privacy';

const report = (findings: Array<{ line: number; rule: string; text: string }>): string[] =>
  findings.map((finding) => `line ${finding.line}: ${finding.rule}: ${finding.text}`);

describe('Fixtures and tests hold no customer data', () => {
  const fixtureFiles = listFiles(FIXTURES_DIR);
  // This file is left out: the examples below look like secrets on purpose.
  const testSources = listFiles(TESTS_DIR).filter((path) => path.endsWith('.ts') && !path.endsWith('fixture-privacy.test.ts'));

  it('finds the files to check', () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
    expect(testSources.length).toBeGreaterThan(0);
  });

  for (const path of fixtureFiles) {
    it(`fixture ${relative(FIXTURES_DIR, path)} has no secret, public address or real domain`, () => {
      expect(report(scanConfiguration(readFileSync(path, 'utf8')))).toEqual([]);
    });
  }

  for (const path of testSources) {
    it(`test source ${relative(TESTS_DIR, path)} has no hashed secret, public address or MAC address`, () => {
      expect(report(scanTestSource(readFileSync(path, 'utf8')))).toEqual([]);
    });
  }
});

describe('Real configurations stay out of git', () => {
  /** Output of a git command run at the root of the repository, or `undefined` when git cannot answer. */
  const git = (...args: string[]): string | undefined => {
    try {
      return execFileSync('git', args, { cwd: REPOSITORY_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return undefined;
    }
  };
  // Without git, or outside a checkout (a source archive), there is nothing to check.
  const inCheckout = git('rev-parse', '--is-inside-work-tree')?.trim() === 'true';

  it.skipIf(!inCheckout)('no file of test_configs is tracked by git', () => {
    expect(git('ls-files', '--', 'test_configs')?.split('\n').filter(Boolean)).toEqual([]);
  });

  it.skipIf(!inCheckout)('test_configs is ignored by git', () => {
    // `git check-ignore` prints the path when it is ignored, and fails when it is not.
    expect(git('check-ignore', 'test_configs/site/switch.txt')?.trim()).toBe('test_configs/site/switch.txt');
  });
});

describe('The privacy checks themselves', () => {
  const rulesFound = (text: string): string[] => scanConfiguration(text).map((finding) => finding.rule);

  it('accept a sanitized configuration', () => {
    const text = [
      'enable secret 9 REDACTED',
      'username admin privilege 15 secret 9 REDACTED',
      'service password-encryption',
      'snmp-server community REDACTED RO',
      'ip domain name corp.example.com',
      'ip address 10.99.0.11 255.255.255.0',
      'ip route 0.0.0.0 0.0.0.0 192.168.1.1',
      'access-list 10 permit 172.16.0.0 0.0.255.255',
      'ntp server 192.0.2.10',
      ' key 7 REDACTED',
      'set system root-authentication encrypted-password "REDACTED"',
      'set access radius-server 10.0.0.80 secret "REDACTED"',
      'set system domain-search corp.example.com',
      'set version 21.4R3-S5.4',
    ].join('\n');

    expect(scanConfiguration(text)).toEqual([]);
  });

  it('report secrets that were left in', () => {
    expect(rulesFound('enable secret 9 $9$abcdefghijklmnop')).toContain('hashed or encrypted secret');
    expect(rulesFound('set system root-authentication encrypted-password "$6$abcdefgh"')).toContain('hashed or encrypted secret');
    expect(rulesFound(' key 7 094F471A1A0A')).toEqual(['secret that is not the placeholder']);
    expect(rulesFound('snmp-server community n3tw0rk RO')).toEqual(['secret that is not the placeholder']);
    expect(rulesFound('set access radius-server 10.0.0.80 secret "hunter2"')).toEqual(['secret that is not the placeholder']);
  });

  it('report public addresses, MAC addresses, real domains and e-mail addresses', () => {
    expect(rulesFound('ip address 8.8.8.8 255.255.255.0')).toEqual(['public IP address']);
    expect(rulesFound('set system name-server 1.1.1.1')).toEqual(['public IP address']);
    expect(rulesFound('mac address-table static 0011.2233.4455 vlan 10 interface Gi1/0/1')).toEqual(['MAC address']);
    expect(rulesFound('set interfaces ge-0/0/0 mac 00:11:22:33:44:55')).toEqual(['MAC address']);
    expect(rulesFound('ip domain name corp.acme-industries.com')).toEqual(['domain name that is not a documentation domain']);
    expect(rulesFound('snmp-server contact noc@acme-industries.com')).toEqual(['SNMP contact or e-mail address']);
  });

  it('report the line number of a finding', () => {
    expect(scanConfiguration('hostname sw1\nip name-server 8.8.4.4\n')).toEqual([{ line: 2, rule: 'public IP address', text: '8.8.4.4' }]);
  });
});
