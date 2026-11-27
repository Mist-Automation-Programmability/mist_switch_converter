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
