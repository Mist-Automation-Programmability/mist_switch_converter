/**
 * Checks that keep customer data out of the repository.
 *
 * The app never sends a configuration file to a server, and the test data must not
 * break that promise through the back door: everything under `__fixtures__` and
 * every configuration snippet in the tests has to be synthetic or sanitized.
 * These checks catch the most common leftovers of a real configuration.
 */

export interface Finding {
  line: number;
  rule: string;
  text: string;
}

const PLACEHOLDER = 'REDACTED';

/** Private, loopback, link-local, documentation (RFC 5737) and multicast ranges, plus masks. */
function isHarmlessAddress(a: number, b: number, c: number, d: number): boolean {
  if ([a, b, c, d].some((octet) => octet > 255)) return true; // not an address
  if (a === 10 || a === 127 || a === 0 || a >= 224) return true; // 224+ also covers netmasks
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

const SAFE_DOMAIN = /(^|\.)(example\.(com|net|org)|example|test|invalid|localhost)$/i;

type Rule = (line: string) => string | undefined;

/** Rules that are safe to apply to any text, test sources included. */
const UNIVERSAL_RULES: Record<string, Rule> = {
  'hashed or encrypted secret': (line) => line.match(/\$[1-9]\$[^\s"']{4,}/)?.[0],

  'public IP address': (line) => {
    for (const match of line.matchAll(/(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g)) {
      const [a, b, c, d] = match.slice(1, 5).map(Number);
      if (!isHarmlessAddress(a, b, c, d)) return match[0];
    }
    return undefined;
  },

  'MAC address': (line) => line.match(/\b[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}\b|\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/i)?.[0],
};

/** A statement that carries a secret; the second group is the secret. */
const SECRET = /\b(secret|password|encrypted-password|key|community|authentication-key|pre-shared-key|key-string)\s+(?:\d\s+)?"?([^\s"]+)"?/i;

/** Rules for device configurations only: they would misfire on prose and on code. */
const CONFIGURATION_RULES: Record<string, Rule> = {
  'secret that is not the placeholder': (line) => {
    const match = line.match(SECRET);
    return match && match[2] !== PLACEHOLDER ? match[0] : undefined;
  },

  'domain name that is not a documentation domain': (line) => {
    const match = line.match(/\b(?:ip domain[ -]name|ip domain[ -]list|domain-name|domain-search)\s+"?([A-Za-z0-9.-]+)"?/);
    return match && !SAFE_DOMAIN.test(match[1]) ? match[1] : undefined;
  },

  'SNMP contact or e-mail address': (line) => line.match(/[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0],
};

function scan(text: string, rules: Record<string, Rule>): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((line, index) => {
    for (const [rule, check] of Object.entries(rules)) {
      const found = check(line);
      if (found !== undefined) findings.push({ line: index + 1, rule, text: found });
    }
  });
  return findings;
}

/** For a configuration file (anything under `__fixtures__`). */
export function scanConfiguration(text: string): Finding[] {
  return scan(text, { ...UNIVERSAL_RULES, ...CONFIGURATION_RULES });
}

/** For the source of a test, where configuration snippets are mixed with code. */
export function scanTestSource(text: string): Finding[] {
  return scan(text, UNIVERSAL_RULES);
}

/**
 * The secrets written in a configuration (passwords, keys, hashes, SNMP communities),
 * with the line they are on. Short values are left out: they are more often a key
 * number or a keyword than a secret.
 */
export function secretsOf(text: string): Array<{ line: number; value: string }> {
  const secrets: Array<{ line: number; value: string }> = [];
  text.split('\n').forEach((line, index) => {
    const value = line.match(SECRET)?.[2];
    if (value !== undefined && value !== PLACEHOLDER && value.length >= 6) secrets.push({ line: index + 1, value });
  });
  return secrets;
}
