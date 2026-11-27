# Converter tests

These tests cover the code that turns Cisco IOS, Junos and Aruba AOS-CX configurations into a Mist
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
| `cisco-ios.test.ts`, `junos.test.ts`, `aruba-cx.test.ts` | One feature at a time: a few lines of configuration, the part of the template they must produce. |
| `shared.test.ts` | What does not depend on the vendor: file detection, port usage names, RADIUS, several files in one template. |
| `golden.test.ts` | Whole configurations from `__fixtures__`, compared with the `expected.json` stored next to them. |
| `invariants.test.ts` | Rules every template must respect (every network exists, port names are valid...), on every fixture. |
| `fixture-privacy.test.ts` | No secret, public address or real domain in the fixtures and the tests. No file of `test_configs/` in git. |
| `local-configs.test.ts` | Real configurations in `test_configs/`, compared with the results of the previous run. Local only, skipped when the folder does not exist. |
| `unit/` | The building blocks of the converter on their own: readers, command rules, values, port names, extractors, file detection, the `convert()` entry point. |
| `support/` | The harness shared by the tests. |

## Writing a test

`convert()` takes configuration text and returns what a user gets from the app: the
exported template, the status of each file and the log. Tests assert on that result,
not on the internals of the converter, so they stay useful when the converter changes.
It calls the same `convert(files)` function as the app (`../convert.ts`).

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
- `cx(body, { hostname })` is for the `show running-config` of Aruba AOS-CX, with its blocks indented by four spaces.
- `usageFor(result, 'ge-0/0/1')` returns the port usage given to an interface of the source.
- `portConfig(result, 'ge-0/0/0')` returns the entry of the switch rule for a port, by its Mist name.
- `usageOfPort(result, 'ge-0/0/0')` returns the port usage that the switch rule gives to that port.
- `vlanIds`, `endpoints`, `missingNetworks`, `configuredPorts`, `switchRule`, `logsOf` cover the rest.

Nothing in the converter is random: the same files always give the same template, so
names such as `printer-0002` are stable.

## Known defects

A test written with `knownDefect('A21', 'title', ...)` describes the **correct**
behaviour for a defect that is not fixed yet. It is reported as passed while the defect
is there, so the suite stays green and the defect stays documented. It turns red when
the defect is fixed: replace `knownDefect('A21', 'title', ...)` by `it('title (A21)', ...)`,
add a line to the list of fixed defects below, and the test keeps guarding the fix.
It also turns red if the body crashes instead of failing an expectation.

`it.todo(...)` marks syntax that the converter does not read yet.

**No defect is open at the moment.** The next free ids are A21 (Cisco), B17 (Junos),
C10 (shared) and D1 (Aruba).

A14 to A20, B15 and B16 were found by converting real configurations (see the end of
this file) and are reproduced here with synthetic lines. A9, A18 and A19 mostly show
up with files that are not a `show running-config` but the commands typed in
configuration mode; `__fixtures__/cisco-ios/catalyst-config-script` is such a file.

### Fixed defects

Their tests are normal tests now and keep the id in their name. The first table lists
the defects that were fixed one by one in the first parsers. The second one lists those
that went away when the converter was rewritten as readers, extractors and a template
builder.

| Id | What was wrong | What the converter does now |
| --- | --- | --- |
| A3 | Cisco: every port was an STP edge port, with or without `spanning-tree portfast`. | A port is an edge port when it has `spanning-tree portfast` (also `edge`, `trunk`, `edge trunk`) or `spanning-tree bpduguard enable`. With the global `spanning-tree portfast [edge] default`, access ports are edge ports unless they have `spanning-tree portfast disable`. |
| A14 | Cisco: the VLAN names of the running configuration (`vlan 10` followed by ` name users`) were not read. A file without `show vlan brief` got networks named `vlan10`. | The names are read, also in a configuration script. A VLAN declared without a name (`vlan 30,40-41`) becomes a network too, named after its SVI description when it has one, `vlan30` otherwise. |
| A15 | Cisco: a VLAN that was only known from an `interface Vlan` with an address and no description was removed from the access and trunk ports that use it. | The ports keep it, under the name of its network (`vlan60`, or the description of the SVI). |
| A16 | Cisco: a range in `switchport trunk allowed vlan` created one network per id, also for VLANs that the switch does not have. `1-4094` created 4094 networks. | `1-4094` is a trunk that allows all networks. A range wider than 100 ids keeps the VLANs that the file is known to have in it (VLAN table, `vlan` blocks, SVIs, VLANs that the ports name one by one). A shorter range still gives one network per id. |
| A17 | Cisco: `AppGigabitEthernet1/0/1` (internal port of the Catalyst 9000) became port `ge-0/0/0` and replaced the configuration of `GigabitEthernet1/0/1`. | The application port is left out and named in the log. |
| A20 | Cisco: the voice VLAN of a port was dropped when the file had no VLAN table. | The voice VLAN gets a network like the access VLAN does (`vlan20` when nothing names it). `dot1p`, `none` and `untagged` create no network. |
| B3 | Junos: `disable` was not read, because the parser looked for the word `disabled`. | `set interfaces <port> disable` gives a disabled port, also when it is set on an interface range. |
| C1 | RADIUS accounting servers were added to `auth_servers`, and `acct_servers` was always empty. | Accounting servers go to `acct_servers`, authentication servers to `auth_servers`. |
| C2 | RADIUS change of authorization was read from Junos (`dynamic-request-port`) but never written to the template. | `radius_config.coa_enabled` and `coa_port` follow the source: `dynamic-request-port` on Junos, `aaa server radius dynamic-author` on Cisco. |

| Id | What was wrong | What the converter does now |
| --- | --- | --- |
| A1 | Cisco: a port list wrapped over several lines in `show vlan brief` ended the VLAN table. The VLANs after it lost their name (`vlan10` instead of `users`). | The table is read to its end. A wrapped line belongs to the VLAN before it. |
| A2 | Cisco: `switchport trunk allowed vlan add ...` replaced the list and created a network named `vlanadd 150`. `none` created `vlannone`. | `add`, `remove` and `except` change the list, `none` empties it, `all` allows every network. |
| A4 | Cisco: `banner motd` was never converted, and the banner block never closed. | The text of `banner motd` (`banner login` when there is no motd) goes to `switch_mgmt.cli_banner`, whatever its delimiter. |
| A5 | Cisco: `ip name-server a b` kept the first address only. | Every address of the line is kept. |
| A6 | Cisco: with `vrf <name>` in `ip name-server` or `ntp server`, the server was the word `vrf`. | The VRF is skipped and the address is read. |
| A7 | Cisco: `GigabitEthernet0/0` became port `ge-0/0/-1`. `TwoGigabitEthernet`, `FiveGigabitEthernet` and `HundredGigE` were not translated. | Port names are translated by position (`extractors/cisco_interfaces.ts`), with every Ethernet speed. A name that cannot be a switch port is reported and left out. |
| A8 | Cisco: `switchport mode dynamic auto` was copied as the Mist mode. | A dynamic port is converted as an access port, with a warning. |
| A9 | Cisco: interfaces that were not separated by `!` were merged into one, and all but the last were lost. | Blocks are read from the indentation and from the commands, not from the `!` lines. |
| A10 | Cisco: a file was flagged "No VLAN database found" even when its VLAN table was read. | The flag follows what was read. |
| A11 | Cisco: a port in VLAN 1 had no network when the file had no VLAN table. | VLAN 1 is the network `default`. |
| A12 | Cisco: `Loopback0` became a switch port. | Loopback, tunnel, management and other interfaces that are not switch ports are left out. |
| A13 | Cisco: a `radius server` without explicit ports was dropped. | It is kept with ports 1812 and 1813. |
| A18 | Cisco: `interface range ...` (configuration script) created one port named `range GigabitEthernet1/0/5 - 8`. | Every port of the range gets the settings of the range. |
| A19 | Cisco: an interface configured in two blocks (configuration script) kept the settings of the last block only. | The settings of all its blocks are merged, in the order of the file. |
| B1 | Junos: the ports of an interface range that had no statement of their own were not created. | Every member of the range is a port, `member-range` included. |
| B2 | Junos: a port of an interface range with its own statements lost the VLAN of the range, and its settings leaked to the other ports of the range. | A port has the settings of its ranges, then its own, which win. |
| B4 | Junos: a RADIUS server on the default port was dropped, and a server inherited the ports of the one before it. | Each server has its own ports, 1812 and 1813 unless the file gives others. |
| B5 | Junos: a TACACS+ server without `port` got an empty port, and a syslog server inherited the port of the one before it. | The ports are 49 and 514 unless the file gives others. |
| B6 | Junos: `mac-radius` without option did not enable MAC authentication. | It does. `mac-radius restrict` gives MAC authentication only. |
| B7 | Junos: voice and guest VLAN names were copied as written (`VOICE`) and did not match the network (`voice`). | A VLAN is known by its id everywhere, so every reference uses the name of the network. |
| B8 | Junos: `switch-options voip interface access-ports` created a port named `access-ports`. | `access-ports` gives the voice VLAN to every access port. |
| B9 | Junos: `ae10` and above got the wrong aggregated interface number. | `ae_idx` is the number of the `ae` interface. |
| B10 | Junos: an interface range with a wildcard member (`ge-0/0/*`) raised an exception and the ranges after it were skipped. | The wildcard matches the ports that the file configures by name, with a warning that says so. The other ranges are read. |
| B11 | Junos: with Windows line endings the subnets of the VLANs were lost. | Line endings are removed by the reader. |
| B12 | Junos: `port-mode trunk` (switches without ELS) gave an access port on the first VLAN. | `port-mode` is read like `interface-mode`. |
| B13 | Junos: `protocols rstp interface all` created a port named `all`. | `all` applies the setting to every port. |
| B14 | Junos: a port without VLAN had no network. | It is in the `default` network (VLAN 1). |
| B15 | Junos: DHCP snooping was not seen on a VLAN whose `dhcp-security` had an option (`arp-inspection`, `group ... overrides trusted`...). | Any `dhcp-security` statement of a VLAN enables it. |
| B16 | Junos: the server lists of `access profile <name> radius` were not read. A server listed as `accounting-server` was not an accounting server unless it had `accounting-port`. | When the file has an access profile, its lists say which server is used for what. |
| C3 | Two files that named the same VLAN id differently left a port usage pointing to a network that did not exist. | A VLAN id has one network, named by the first file that names it. The other names are listed in a warning. |
| C4 | Two files that used the same VLAN name for different ids kept one of the two VLANs only. | Both are kept. The second one gets the id in its name (`users-vl20`). |
| C5 | Port usage names kept characters such as `+`, `/`, `.`, `(`. | Names only have lower case letters, digits and `_`, plus `-` before a number that tells two usages apart. |
| C6 | An Aruba AOS-CX configuration was detected as Cisco and converted to nothing. | It is recognised, and converted by its own extractor (`extractors/aruba_cx.ts`). |
| C7 | A file without hostname created a switch rule with an empty name. | The rule is named after the file, with a warning. |
| C8 | The member ports of a link aggregation left an unused port usage in the template. | Members get the port usage of their link aggregation and create none. |
| C9 | Log lines about the VLANs of a Cisco file did not name that file. | Every message about a file carries its name, and its line numbers when it has some. |

## Golden files

Each directory under `__fixtures__` holds one or more input files and `expected.json`,
the full result of converting them together. `expected.json` records what the converter
does **today**. Its job is to show the whole effect of a change:

1. change the converter,
2. run `npm test -- -u`,
3. review the diff of the `expected.json` files like any other code.

To add a fixture, create a directory with the input files (`*.txt`, `*.cfg` or
`*.config`) and run `npm test -- -u`. The invariants and the privacy checks pick it up
on their own.

## Invariants

`invariants.test.ts` lists rules that hold for any valid template. A rule that a fixture
breaks because of a known defect is listed in `KNOWN_VIOLATIONS` with the id of that
defect. The list is empty at the moment.
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
