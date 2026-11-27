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
   - `indented_blocks.ts`: commands nested by indentation, as in Cisco IOS.
   - `ios_capture.ts`: what people save from a Cisco terminal (prompts, `show vlan`,
     `show running-config`, commands typed in configuration mode).
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
  second is left out with a warning.
- **DHCP snooping trust.** `allow_dhcpd` is written only when the source says
  something. Junos and Mist agree on the rest: a trunk is trusted, an access port is
  not. A Cisco switch trusts no port by default, so with DHCP snooping a Cisco trunk
  without `ip dhcp snooping trust` becomes `allow_dhcpd: false`, with a warning.

## Adding a command

Find the rule table of the place where the command lives (`portRules` in
`extractors/cisco_ios.ts`, `interfaceRules` or `globalRules` in `extractors/junos.ts`)
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
