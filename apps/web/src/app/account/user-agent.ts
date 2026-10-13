/**
 * A signed-in device as a person reads it: "Chrome 155 on macOS" instead of
 * the raw `User-Agent` header (issue #159). Only the browser's major version;
 * an agent it does not recognise keeps the raw header for the tooltip.
 */
export interface DeviceName {
  label: string;
  /** Phone or tablet: the card shows a phone icon. */
  mobile: boolean;
}

/** Order matters: Edge and Opera also say "Chrome", and Chrome also says "Safari". */
const BROWSERS: readonly [name: string, pattern: RegExp][] = [
  ['Edge', /\b(?:Edg|EdgA|EdgiOS)\/(\d+)/],
  ['Opera', /\b(?:OPR|OPiOS)\/(\d+)/],
  ['Samsung Internet', /\bSamsungBrowser\/(\d+)/],
  ['Firefox', /\b(?:Firefox|FxiOS)\/(\d+)/],
  ['Headless Chrome', /\bHeadlessChrome\/(\d+)/],
  ['Chrome', /\b(?:Chrome|CriOS)\/(\d+)/],
  ['Safari', /\bVersion\/(\d+)(?:[.\d]*)? (?:Mobile\/\S+ )?Safari\//],
];

const SYSTEMS: readonly [name: string, pattern: RegExp][] = [
  ['iPadOS', /\biPad\b/],
  ['iOS', /\b(?:iPhone|iPod)\b/],
  ['Android', /\bAndroid\b/],
  ['ChromeOS', /\bCrOS\b/],
  ['Windows', /\bWindows\b/],
  ['macOS', /\bMac OS X\b|\bMacintosh\b/],
  ['Linux', /\bLinux\b/],
];

/** Command-line clients a person may sign in with. */
const TOOLS: readonly [name: string, pattern: RegExp][] = [
  ['curl', /^curl\/(\d+)/i],
  ['AgentDock CLI', /^agentdock\/(\d+)/i],
];

export function parseUserAgent(raw: string | null): DeviceName {
  const ua = raw?.trim() ?? '';
  if (!ua) return { label: 'Unknown device', mobile: false };
  for (const [name, pattern] of TOOLS) {
    const match = pattern.exec(ua);
    if (match) return { label: `${name} ${match[1]}`, mobile: false };
  }
  const browser = BROWSERS.find(([, pattern]) => pattern.test(ua));
  const system = SYSTEMS.find(([, pattern]) => pattern.test(ua))?.[0];
  const mobile = /\bMobi|\biPad\b|\bAndroid\b/.test(ua);
  if (!browser) {
    return {
      label: system ? `Unknown browser on ${system}` : 'Unknown device',
      mobile,
    };
  }
  const [name, pattern] = browser;
  const version = pattern.exec(ua)?.[1];
  const label = version ? `${name} ${version}` : name;
  return { label: system ? `${label} on ${system}` : label, mobile };
}
