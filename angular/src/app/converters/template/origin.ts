/**
 * Where a part of the template comes from: the files and lines it was read from, and,
 * for a part the converter names (a network, a port usage, a switch rule), why it has
 * that name. This is what the page shows under "Detected" and "Decided".
 */
export interface OriginSource {
  file: string;
  /** Lines of the file (1-based), in the order of the file. */
  lines: number[];
  /** The interfaces of the file that the part configures, for a port usage or a switch rule. */
  ports?: string[];
}

export interface Origin {
  /**
   * The part of the template, as a path: "networks.users", "port_usages.desk",
   * "switch_matching.rules.sw1", "radius_config", "ntp_servers".
   */
  path: string;
  sources: OriginSource[];
  /** Why the part has its name, in a sentence. Only for the parts the converter names. */
  naming?: string;
}
