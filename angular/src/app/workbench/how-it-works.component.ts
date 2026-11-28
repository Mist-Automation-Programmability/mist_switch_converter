import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, EventEmitter, Input, Output, ViewChild } from '@angular/core';
import { supportedCommands, SupportedPlatform } from '../converters/supported';

/**
 * How the page works, the platforms and the commands to save on each, and what is
 * converted. Opens from the header at any time. The list of every supported command
 * is read from the rule tables of the converter, so it is the one that is applied.
 */
@Component({
  selector: 'app-how-it-works',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <div class="overlay" (click)="close.emit()"></div>
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="how-title" #dialog tabindex="-1">
      <div class="dialog-head">
        <h1 id="how-title">How it works</h1>
        <button type="button" class="secondary-button" (click)="close.emit()">Close</button>
      </div>

      <ol class="steps">
        <li>
          <span class="step-number" aria-hidden="true">1</span>
          <span><strong>Add the files</strong><span class="muted">One text file per switch. Each file is read in this browser and its vendor is recognised. You can add more files at any time.</span></span>
        </li>
        <li>
          <span class="step-number" aria-hidden="true">2</span>
          <span><strong>Check the result</strong><span class="muted">See the template as JSON, what the converter decided, and the lines each part comes from.</span></span>
        </li>
        <li>
          <span class="step-number" aria-hidden="true">3</span>
          <span><strong>Download the template</strong><span class="muted">One JSON file, to import as a switch template in Mist.</span></span>
        </li>
      </ol>

      <section>
        <h2>Supported platforms, and the commands to save</h2>
        <div class="cards">
          <div class="card">
            <span class="card-title"><span class="vendor-square cisco" aria-hidden="true"></span>Cisco IOS and IOS-XE</span>
            <code>terminal length 0</code>
            <code>show vlan brief</code>
            <code>show running-config</code>
            <span class="muted small">Both outputs in one file. Without the VLAN list, networks are named after their ids.</span>
          </div>
          <div class="card">
            <span class="card-title"><span class="vendor-square juniper" aria-hidden="true"></span>Juniper Junos</span>
            <code>set cli screen-length 0</code>
            <code>show configuration | display inheritance | display set</code>
            <span class="muted small">Interface ranges name the port profiles.</span>
          </div>
          <div class="card">
            <span class="card-title"><span class="vendor-square aruba" aria-hidden="true"></span>Aruba AOS-CX</span>
            <code>show running-config</code>
            <span class="muted small">Keep the indentation of the blocks.</span>
          </div>
        </div>
        <p class="muted small">Cisco NX-OS is not supported.</p>
      </section>

      <section>
        <h2>What is converted</h2>
        <div class="cards">
          <div class="card"><strong>VLANs</strong><span class="muted small">Ids and names, subnets, DHCP snooping.</span></div>
          <div class="card wide"><strong>Ports</strong><span class="muted small">Access or trunk, VLANs and voice VLAN, speed and duplex, 802.1X and MAC authentication with their VLANs, MAC limit, persistent MAC, MTU, QoS, PoE, storm control, DHCP trust, STP edge, admin status.</span></div>
          <div class="card"><strong>Authentication</strong><span class="muted small">RADIUS servers and CoA, TACACS+ servers.</span></div>
          <div class="card"><strong>System</strong><span class="muted small">NTP, DNS, syslog, SNMP v2c and v3, login banner.</span></div>
        </div>
        <p class="muted small">
          Ports with the same settings share one port profile, across switches and vendors. Anything else, such as routed ports or access lists, is listed in the logs with its file and its line numbers.
          RADIUS and TACACS+ keys are replaced by to_be_replaced. SNMP communities too, unless you choose to copy the ones in clear text.
        </p>
        <button type="button" class="link-button" [attr.aria-expanded]="showCommands" (click)="showCommands = !showCommands">{{ showCommands ? 'Hide' : 'See' }} every supported command, per platform</button>
        @if (showCommands) {
          <div class="commands">
            @for (platform of platforms; track platform.name) {
              <h3>{{ platform.name }}</h3>
              @for (place of platform.places; track place.place) {
                @if (place.converted.length > 0) {
                  <details>
                    <summary>{{ place.place }} <span class="muted">{{ place.converted.length }} converted, {{ place.ignored }} read and not needed</span></summary>
                    <ul>
                      @for (pattern of place.converted; track pattern) {
                        <li><code>{{ pattern }}</code></li>
                      }
                    </ul>
                  </details>
                }
              }
            }
            <p class="muted small">&lt;name&gt; stands for one word, &lt;name...&gt; for the rest of the line, ... for anything.</p>
          </div>
        }
      </section>

      <section class="about">
        <p class="muted small">Your configuration files are not sent anywhere: the conversion runs in this browser.</p>
        @if (disclaimer) {
          <p class="muted small">{{ disclaimer }}</p>
        }
        @if (githubUrl || dockerUrl) {
          <p class="links">
            @if (githubUrl) {
              <a [href]="githubUrl" target="_blank" rel="noopener">Source code on GitHub</a>
            }
            @if (dockerUrl) {
              <a [href]="dockerUrl" target="_blank" rel="noopener">Docker image</a>
            }
          </p>
        }
      </section>
    </div>
  `,
})
export class HowItWorksComponent implements AfterViewInit {
  @Input() githubUrl = '';
  @Input() dockerUrl = '';
  @Input() disclaimer = '';
  @Output() close = new EventEmitter<void>();
  @ViewChild('dialog') dialog: ElementRef<HTMLElement>;

  showCommands = false;
  readonly platforms: SupportedPlatform[] = supportedCommands();

  ngAfterViewInit(): void {
    this.dialog.nativeElement.focus();
  }
}
