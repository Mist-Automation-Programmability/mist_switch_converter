# The converter

`convert(files)` in `convert.ts` turns switch configuration files into one Mist switch
template. It is a plain function: it runs where it is called, in the browser of the
user, and reads nothing but its arguments. It has no access to the network, to storage
or to the page, so **a configuration file never leaves the computer of the user**.
Keep it that way: nothing under this folder may import Angular, `fetch`, or anything
that sends data.

```ts
const result = convert([{ name: 'sw1.txt', text }]);
result.template;     // the Mist template
result.files;        // what happened to each file
result.ports;        // every converted port, its port usage and its source lines
result.diagnostics;  // what was left out or guessed, with file and line numbers
```

## Three stages

```
 file ──► reader ──► statements ──► extractor ──► Device ──► template builder ──► Mist template
          readers/                  extractors/   model.ts   template/
```

1. **Readers** (`readers/`) know how a family of configuration languages is laid out
   and nothing about what the commands mean.
   - `indented_blocks.ts`: commands nested by indentation, as in Cisco IOS and in
     Aruba AOS-CX, where a block can hold another one.
   - `ios_capture.ts`: what people save from a Cisco terminal (prompts, `show vlan`,
     `show running-config`, commands typed in configuration mode). An AOS-CX terminal
     has the same prompts and the same header.
   - `set_lines.ts`: Junos `display set` lines, with `deactivate` and applied groups.
2. **Extractors** (`extractors/`, one per vendor) say what each command means, in rule
   tables, and fill a vendor-neutral `Device` (`model.ts`): VLANs by id, ports, servers.
3. **The template builder** (`template/`) is shared by all vendors. It names the
   networks, groups the ports that have the same settings into port usages, names
   them, and writes one switch rule per device.

`detect.ts` tells which extractor reads a file. `report.ts` collects the diagnostics.

### The names of the port usages

Ports with the same converted settings share one port usage, in one file or across
files. `template/port_usages.ts` names it, in this order:

1. after the interface ranges of its ports (Junos);
2. after the description of its ports, when more than half of them have one: the
   description itself when there is only one, or the words that more than half of
   the descriptions share (`desk` for "Desk 12" and "Desk 13"), with a warning;
3. after its settings: `access_users`, `access_users_voip_dot1x`, `trunk_all`,
   `trunk_12_vlans`, `disabled_access_users`.

Two port usages that would get the same name get the words that tell them apart,
and only those: `printer_floor1` and `printer_floor2`, `access_users` and
`access_users_qos_nopoe`. A number (`desk-0004`) is the last resort, when they
differ on a setting that has no short word. A name has at most 31 characters.

### Settings that do not map one to one

- **Storm control.** Mist has one level per port usage, in percent, and says which
  kinds of traffic it applies to (`storm_control`). A Junos storm control profile
  maps directly; without a level it is 80 %. A Cisco switch has one level per kind of
  traffic: the highest one is kept, with a warning when they differ, and a kind of
  traffic without a level is turned off in Mist. A level in bits or packets per
  second is left out with a warning. Aruba AOS-CX is read like Cisco (`rate-limit
  <traffic> <rate> percent`), and its limit of multicast also limits the broadcast.
- **DHCP snooping trust.** `allow_dhcpd` is written only when the source says
  something. Junos and Mist agree on the rest: a trunk is trusted, an access port is
  not. A Cisco switch trusts no port by default, so with DHCP snooping a Cisco trunk
  without `ip dhcp snooping trust` becomes `allow_dhcpd: false`, with a warning.
  The same goes for an Aruba trunk without `dhcpv4-snooping trust`.

- **SNMP.** A Mist template describes SNMP as Junos does (`snmp_config`), so Junos
  statements are copied field by field (`extractors/junos_snmp.ts`). Cisco says some
  things differently (`extractors/cisco_snmp.ts`): the standard access list of a
  community becomes a client list (`acl_<name>`); `snmp-server host` becomes a trap
  group for versions 1 and 2c (`traps_v1`, `traps_v2`) and a target with its
  parameters for version 3; the kinds of `snmp-server enable traps` become Junos
  categories; a version 3 group without a read view reads `v1default`, which is added
  as a view of everything. The community of a Cisco host line is not kept: Junos sends
  the name of the trap group. A template has one SNMP configuration: what several
  files define under the same name comes from the first one, and location, contact
  and description are written only when the files agree. What belongs to one switch
  (`snmp name`, a local engine id, the source of the traps) is not converted.
  Aruba AOS-CX (`extractors/aruba_cx_snmp.ts`) has hosts like Cisco, with the kinds
  of notifications on the host line. It has no views and no groups: its version 3
  users are put in the group `snmpv3_ro`, which reads the view `all`. The access
  list of a community is not converted, and a warning says that every station can
  use the community.

### Aruba AOS-CX

`extractors/aruba_cx.ts` reads the output of `show running-config`. What it has to
work out, because the configuration does not say it:

- **What a port is when its block says nothing.** A running configuration only shows
  what differs from the defaults of the switch, and the defaults depend on its model.
  A file with a `no routing` line is the file of a switch whose ports are routed
  unless they say so: there, a port without VLAN and without `no routing` is a routed
  port, and is left out. A file with a `no shutdown` line is the file of a switch
  whose ports are shut down unless they say so: there, a port without `no shutdown`
  is disabled. A port with a VLAN, or in a link aggregation, is always a switch port.
- **The position of a port.** `member/slot/port` becomes `ge-<member-1>/<slot-1>/<port-1>`.
  The name does not say the speed of the port, so every port is `ge`.
- **Voice.** AOS-CX has no voice VLAN on a port. A trunk with a native VLAN and
  exactly one other VLAN, marked `voice` in its VLAN block, is converted as an access
  port with a voice VLAN.
- **Ranges of VLANs.** A trunk can only allow VLANs that the switch has, and the file
  lists them: `vlan trunk allowed 20-30` gives the VLANs of the file between 20 and 30.
  In a file without any VLAN, a range is taken as written.
- **Roles.** `port-access role` blocks are not converted. They are read for the VLAN
  of the `critical-role` (`server_fail_network`; without a VLAN, the clients are let
  in on the VLAN of the port) and of the `reject-role` (`server_reject_network`) of a port.
- **Links of a stack.** The ports of `vsf member <n>` / `link` are left out.

The lines of a block that is nested in an interface (`aaa authentication port-access
dot1x authenticator`, `mac-auth`, `port-access port-security`) have their own rule
tables: `authMethodRules`, `portSecurityRules`.

### Secrets

No secret of a file is written in a diagnostic, ever: messages give keywords and line
numbers. In the template, RADIUS and TACACS+ keys are `to_be_replaced`.

SNMP communities are passwords in clear text. By default each one becomes
`to_be_replaced_<n>`, the same number for the same community in every file, and a
message gives its line. With `convert(files, { copyClearTextSecrets: true })` (the
checkbox "Copy the SNMP secrets that are in clear text" of the page) the communities
are copied, and so are the passwords of SNMP version 3 users that a file has in clear
text (a configuration script, or `plaintext` on Aruba; a running configuration only has keys). A warning says
how many secrets were copied. What a file has encrypted or hashed is never copied.

## Adding a command

Find the rule table of the place where the command lives (`portRules` in
`extractors/cisco_ios.ts` or `extractors/aruba_cx.ts`, `interfaceRules` or `globalRules`
in `extractors/junos.ts`)
and add one line, written like the command:

```ts
rule('switchport access vlan <id>', withVlan((draft, id) => (draft.accessVlan = id))),
```

`<id>` is one word, `<text...>` is the rest of the line, a trailing `...` accepts
anything. A command that has no place in a Mist template goes into the `ignore(...)`
list of the table. A command with no rule is never dropped silently: it is reported as
"Not converted", once per command, with its line numbers. Only the first keywords of a
command are ever written to the report, because the rest can be a secret.

If the command needs a setting that the model does not have yet, add it to `Port` or
`System` in `model.ts` and map it to its Mist field in `template/port_usages.ts` or
`template/build.ts`. Then add a test in `__tests__/`.

## Adding a vendor

1. Reuse a reader, or write one that returns `Statement`s.
2. Write `extractors/<vendor>.ts`: rule tables and a function
   `(file: SourceFile, report: Report) => Device`. `extractors/common.ts`,
   `extractors/values.ts` and `extractors/rules.ts` hold what vendors share.
3. Add the vendor to `Vendor` in `model.ts`, to `detect.ts`, and to `EXTRACTORS` in
   `convert.ts`.

The template builder needs no change: it only sees `Device`s.

## Tests

`npm test` runs everything under `__tests__/` in Node, without a browser. See
`__tests__/README.md`.
