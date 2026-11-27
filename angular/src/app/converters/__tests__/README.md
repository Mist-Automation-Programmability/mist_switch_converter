# Converter tests

These tests cover the code that turns Cisco IOS and Junos configurations into a Mist
switch template (`angular/src/app/converters`). They run in Node with
[Vitest](https://vitest.dev): no browser, no Angular build, about one second.

```sh
cd angular
npm ci                # once
npm test              # run everything
npm run test:watch    # rerun on change
npm run test:defects  # run the known defects as normal tests, to see how each one fails
npm run test:types    # type-check the converter and the tests
npm test -- -u        # record new golden files after an intended change
npm run test:local    # only the real configurations of test_configs/ (local, never committed)
```

## What is in here

| File | What it checks |
| --- | --- |
| `cisco-ios.test.ts`, `junos.test.ts` | One feature at a time: a few lines of configuration, the part of the template they must produce. |
| `shared.test.ts` | What does not depend on the vendor: file detection, port usage names, RADIUS, several files in one template. |
| `golden.test.ts` | Whole configurations from `__fixtures__`, compared with the `expected.json` stored next to them. |
| `invariants.test.ts` | Rules every template must respect (every network exists, port names are valid...), on every fixture. |
| `fixture-privacy.test.ts` | No secret, public address or real domain in the fixtures and the tests. No file of `test_configs/` in git. |
| `local-configs.test.ts` | Real configurations in `test_configs/`, compared with the results of the previous run. Local only, skipped when the folder does not exist. |
| `helpers.test.ts` | The subnet calculation and the translation of Cisco port names. |
| `support/` | The harness shared by the tests. |

## Writing a test

`convert()` takes configuration text and returns what a user gets from the app: the
exported template, the status of each file and the log. Tests assert on that result,
not on the internals of the parsers, so they stay useful when the parsers are reworked.

```ts
it('converts the access VLAN and the voice VLAN', async () => {
  const result = await convert(
    ios(
      `
      interface GigabitEthernet1/0/1
       switchport access vlan 10
       switchport mode access
       switchport voice vlan 20
      !
      `,
      { vlans: { 10: 'USERS', 20: 'VOICE' } },
    ),
  );

  expect(usageFor(result, 'GigabitEthernet1/0/1')).toMatchObject({ mode: 'access', port_network: 'users', voip_network: 'voice' });
});
```

- `ios(body, { vlans, hostname })` wraps the body in a realistic capture (`show vlan brief` and `show running-config`).
- `junos(body)` is for `display set` output.
- `usageFor(result, 'ge-0/0/1')` returns the port usage given to an interface of the source.
- `portConfig(result, 'ge-0/0/0')` returns the entry of the switch rule for a port, by its Mist name.
- `usageOfPort(result, 'ge-0/0/0')` returns the port usage that the switch rule gives to that port.
- `vlanIds`, `endpoints`, `missingNetworks`, `configuredPorts`, `switchRule`, `logsOf` cover the rest.

Profile ids are random in the app. In the tests `uuid` is replaced by a counter
(`support/deterministic-uuid.ts`), so names such as `printer-0002` are stable.

## Known defects

A test written with `knownDefect('A5', ...)` describes the **correct** behaviour for a
defect that is not fixed yet. It is reported as passed while the defect is there, so the
suite stays green and the defect stays documented. It turns red when the defect is
fixed: replace `knownDefect('A5', ...)` by `it(...)`, move its line to the list of fixed
defects below, and the test keeps guarding the fix.
It also turns red if the body crashes instead of failing an expectation.

`it.todo(...)` marks syntax that the converter does not read yet.

A14 to A20, B15 and B16 were found by converting real configurations (see the end of
this file) and are reproduced here with synthetic lines. A9, A18 and A19 mostly show
up with files that are not a `show running-config` but the commands typed in
configuration mode; `__fixtures__/cisco-ios/catalyst-config-script` is such a file.

| Id | What happens today |
| --- | --- |
| A1 | Cisco: a port list wrapped over several lines in `show vlan brief` ends the VLAN table. The VLANs after it lose their name (`vlan10` instead of `users`). |
| A2 | Cisco: `switchport trunk allowed vlan add ...` replaces the list and creates a network named `vlanadd 150`. `none` creates `vlannone`. |
| A4 | Cisco: `banner motd` is never converted, and the banner block never closes. |
| A5 | Cisco: `ip name-server a b` keeps the first address only. |
| A6 | Cisco: with `vrf <name>` in `ip name-server` or `ntp server`, the server is the word `vrf`. |
| A7 | Cisco: `GigabitEthernet0/0` becomes port `ge-0/0/-1`. `TwoGigabitEthernet`, `FiveGigabitEthernet` and `HundredGigE` are not translated. |
| A8 | Cisco: `switchport mode dynamic auto` is copied as the Mist mode. |
| A9 | Cisco: interfaces that are not separated by `!` are merged into one, and all but the last are lost. |
| A10 | Cisco: a file is flagged "No VLAN database found" even when its VLAN table was read. |
| A11 | Cisco: a port in VLAN 1 has no network when the file has no VLAN table. |
| A12 | Cisco: `Loopback0` becomes a switch port. |
| A13 | Cisco: a `radius server` without explicit ports is dropped. |
| A14 | Cisco: the VLAN names of the running configuration (`vlan 10` followed by ` name users`) are not read. A file without `show vlan brief` gets networks named `vlan10`. |
| A15 | Cisco: a VLAN that is only known from an `interface Vlan` with an address and no description is removed from the access and trunk ports that use it. |
| A16 | Cisco: a range in `switchport trunk allowed vlan` creates one network per id, also for VLANs that the switch does not have. `1-4094` creates 4094 networks. |
| A17 | Cisco: `AppGigabitEthernet1/0/1` (internal port of the Catalyst 9000) becomes port `ge-0/0/0` and replaces the configuration of `GigabitEthernet1/0/1`. |
| A18 | Cisco: `interface range ...` (configuration script) creates one port named `range GigabitEthernet1/0/5 - 8`. |
| A19 | Cisco: an interface configured in two blocks (configuration script) keeps the settings of the last block only. |
| A20 | Cisco: the voice VLAN of a port is dropped when the file has no VLAN table. The access VLAN gets a network named `vlan10`, the voice VLAN gets nothing. |
| B1 | Junos: the ports of an interface range that have no statement of their own are not created. |
| B2 | Junos: a port of an interface range with its own statements loses the VLAN of the range, and its settings leak to the other ports of the range. |
| B4 | Junos: a RADIUS server on the default port is dropped, and a server inherits the ports of the one before it. |
| B5 | Junos: a TACACS+ server without `port` gets an empty port, and a syslog server inherits the port of the one before it. |
| B6 | Junos: `mac-radius` without option does not enable MAC authentication. |
| B7 | Junos: voice and guest VLAN names are copied as written (`VOICE`) and do not match the network (`voice`). |
| B8 | Junos: `switch-options voip interface access-ports` creates a port named `access-ports`. |
| B9 | Junos: `ae10` and above get the wrong aggregated interface number. |
| B10 | Junos: an interface range with a wildcard member (`ge-0/0/*`) raises an exception and the ranges after it are skipped. |
| B11 | Junos: with Windows line endings the subnets of the VLANs are lost. |
| B12 | Junos: `port-mode trunk` (switches without ELS) gives an access port on the first VLAN. |
| B13 | Junos: `protocols rstp interface all` creates a port named `all`. |
| B14 | Junos: a port without VLAN has no network. |
| B15 | Junos: DHCP snooping is not seen on a VLAN whose `dhcp-security` has an option (`arp-inspection`, `group ... overrides trusted`...). |
| B16 | Junos: the server lists of `access profile <name> radius` are not read. A server listed as `accounting-server` is not an accounting server unless it has `accounting-port`. |
| C3 | Two files that name the same VLAN id differently leave a port usage pointing to a network that does not exist. |
| C4 | Two files that use the same VLAN name for different ids keep one of the two VLANs only. |
| C5 | Port usage names keep characters such as `+`, `/`, `.`, `(`. |
| C6 | An Aruba AOS-CX configuration is detected as Cisco and converts to nothing. |
| C7 | A file without hostname creates a switch rule with an empty name. |
| C8 | The member ports of a link aggregation leave an unused port usage in the template. |
| C9 | Log lines about the VLANs of a Cisco file do not name that file. |

### Fixed defects

Their tests are normal tests now and keep the id in their name.

| Id | What was wrong | What the converter does now |
| --- | --- | --- |
| A3 | Cisco: every port was an STP edge port, with or without `spanning-tree portfast`. | A port is an edge port when it has `spanning-tree portfast` (also `edge`, `trunk`, `edge trunk`) or `spanning-tree bpduguard enable`. With the global `spanning-tree portfast [edge] default`, access ports are edge ports unless they have `spanning-tree portfast disable`. |
| B3 | Junos: `disable` was not read, because the parser looked for the word `disabled`. | `set interfaces <port> disable` gives a disabled port, also when it is set on an interface range. |
| C1 | RADIUS accounting servers were added to `auth_servers`, and `acct_servers` was always empty. | Accounting servers go to `acct_servers`, authentication servers to `auth_servers`. |
| C2 | RADIUS change of authorization was read from Junos (`dynamic-request-port`) but never written to the template. | `radius_config.coa_enabled` and `coa_port` follow the source. Reading it from Cisco is still a todo. |

## Golden files

Each directory under `__fixtures__` holds one or more input files and `expected.json`,
the full result of converting them together. `expected.json` records what the converter
does **today**, known defects included. Its job is to show the whole effect of a change:

1. change the converter,
2. run `npm test -- -u`,
3. review the diff of the `expected.json` files like any other code.

To add a fixture, create a directory with the input files (`*.txt`, `*.cfg` or
`*.config`) and run `npm test -- -u`. The invariants and the privacy checks pick it up
on their own.

## Invariants

`invariants.test.ts` lists rules that hold for any valid template. A rule that a fixture
breaks today is listed in `KNOWN_VIOLATIONS` with the id of the defect that explains it.
Two rules are assumptions about what Mist accepts and are marked as such in the file.

## Test data: no customer configuration, ever

The app converts files in the browser so that customer configurations never leave the
user's computer. Test data must respect the same promise:

- Never commit a real configuration, not even a "cleaned" one that was not checked line by line.
- Write fixtures by hand, or sanitize a capture on your own computer before it gets near the repository.
- Replace every secret, key, hash and SNMP community by the word `REDACTED`.
- Use private or documentation addresses (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `192.0.2.0/24`), and `example.com` for domains.
- Use made-up hostnames, descriptions, locations and contacts.

`fixture-privacy.test.ts` fails on the most common leftovers (hashes, non-placeholder
secrets, public addresses, MAC addresses, real domains, e-mail addresses). It is a
safety net, not a sanitizer: it cannot recognise a customer name in a description.

## Real configurations: local only

Real configurations are the best test of a change, and they must never leave your
computer. Put them in `test_configs/` at the root of the repository:

```
test_configs/
  site1/            one folder per set of files that are converted together
    core.txt
    access-1.txt
  site2/
    ex-stack.txt
  _results/         written by the test
```

`test_configs/` is in `.gitignore`. `fixture-privacy.test.ts` fails if a file of that
folder is tracked by git or if the ignore rule is removed. To keep the files outside
the repository altogether, set `SWITCH_CONVERTER_TEST_CONFIGS` to their folder.

```sh
npm run test:local          # convert them and compare with the recorded results
npm run test:local -- -u    # accept the new results
```

`local-configs.test.ts` converts the files of each folder together, and each file on
its own when a folder holds several. The first run records the results. The next runs
fail when a result differs, which shows what a change to the converter does to real
configurations. `npm test` runs it too, and skips it when the folder does not exist,
as on GitHub.

What it writes, all inside `test_configs/_results`:

- one file per conversion, with the same content as `expected.json` plus the invariants
  it breaks (`broken_rules`). **These files hold customer data**, like the
  configurations. Review their diffs locally, and never share or commit them.
- `summary.json`: numbers and rule names only. No hostname, address, description,
  VLAN name, file name or log text. It tells how many results are new, the same or
  changed, which fields changed and how often, and how many times each invariant is
  broken. It is the only file that is safe to share, for example in an issue.

Found a defect with a real configuration? Reproduce it with a few synthetic lines in a
test or a fixture. Do not copy lines of the real file.
