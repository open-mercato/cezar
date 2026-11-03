import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

export type AddressClass = 'public' | 'private' | 'denied';
const v4 = (address: string) => address.split('.').reduce((value, octet) => (value * 256) + Number(octet), 0);
const in4 = (address: number, network: string, bits: number) => Math.floor(address / 2 ** (32 - bits)) === Math.floor(v4(network) / 2 ** (32 - bits));
function classify4(address: string): AddressClass {
  const value = v4(address);
  if ([['0.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]].some(([network, bits]) => in4(value, network as string, bits as number))) return 'denied';
  if ([['10.0.0.0', 8], ['127.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]].some(([network, bits]) => in4(value, network as string, bits as number))) return 'private';
  return 'public';
}
function ipv6(address: string): bigint {
  let value = address.toLowerCase();
  if (value.includes('.')) {
    const colon = value.lastIndexOf(':'); const tail = v4(value.slice(colon + 1));
    value = value.slice(0, colon + 1) + Math.floor(tail / 65536).toString(16) + ':' + (tail % 65536).toString(16);
  }
  const [left = '', right] = value.split('::');
  const a = left ? left.split(':') : []; const b = right ? right.split(':') : [];
  const words = right === undefined ? a : [...a, ...Array<string>(8 - a.length - b.length).fill('0'), ...b];
  return words.reduce((result, word) => (result << 16n) + BigInt(`0x${word}`), 0n);
}
const in6 = (address: bigint, network: string, bits: number) => (address >> BigInt(128 - bits)) === (ipv6(network) >> BigInt(128 - bits));
export function classifyAddress(input: string): AddressClass {
  const address = input.replace(/^\[|\]$/g, '');
  if (address.includes('%')) return 'denied';
  if (isIP(address) === 4) return classify4(address);
  if (isIP(address) !== 6) return 'denied';
  const value = ipv6(address);
  if (value === 0n || value === ipv6('fd00:ec2::254')) return 'denied';
  if (value === 1n) return 'private';
  if (in6(value, '::ffff:0:0', 96) || in6(value, '::', 96)) {
    const embedded = Number(value & 0xffffffffn);
    return classify4([24, 16, 8, 0].map(shift => (embedded >>> shift) & 255).join('.'));
  }
  if (in6(value, 'fc00::', 7)) return 'private';
  if (!in6(value, '2000::', 3) || in6(value, '2001::', 23) || in6(value, '2001:db8::', 32) || in6(value, '2002::', 16) || in6(value, '3fff::', 20)) return 'denied';
  return 'public';
}
export class DestinationPolicyError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'DestinationPolicyError'; }
}
export interface DestinationPolicy { mode: 'local' | 'hosted'; allowLocalNetwork: boolean; serverPorts: readonly number[] }
export type Lookup = (hostname: string) => Promise<{ address: string; family: number }[]>;
export interface ValidatedDestination { url: URL; hostname: string; address: string; family: 4 | 6; private: boolean }
export async function validateDestination(input: string, policy: DestinationPolicy, lookup: Lookup = hostname => dnsLookup(hostname, { all: true, verbatim: true })): Promise<ValidatedDestination> {
  let url: URL;
  try { url = new URL(input); } catch { throw new DestinationPolicyError('invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || input.includes('#')) throw new DestinationPolicyError('invalid_url');
  if (policy.mode === 'hosted' && url.protocol !== 'https:') throw new DestinationPolicyError('https_required');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (policy.serverPorts.includes(port)) throw new DestinationPolicyError('server_port');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (['metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal'].includes(hostname)) throw new DestinationPolicyError('metadata_hostname');
  const family = isIP(hostname);
  let answers: Awaited<ReturnType<Lookup>>;
  try { answers = family ? [{ address: hostname, family }] : await lookup(hostname); }
  catch (error) {
    if (['ENOTFOUND', 'ENODATA'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new DestinationPolicyError('dns_not_found');
    throw new Error('dns_temporarily_unavailable');
  }
  if (!answers.length || answers.length > 64) throw new DestinationPolicyError('invalid_dns');
  const classes = answers.map(answer => classifyAddress(answer.address));
  if (classes.includes('denied') || answers.some(answer => answer.family !== isIP(answer.address))) throw new DestinationPolicyError('denied_address');
  if (new Set(classes).size !== 1) throw new DestinationPolicyError('mixed_dns');
  const isPrivate = classes[0] === 'private';
  if (isPrivate && policy.mode === 'hosted') throw new DestinationPolicyError('public_destination_required');
  if (isPrivate && !policy.allowLocalNetwork) throw new DestinationPolicyError('local_consent_required');
  return { url, hostname, address: answers[0]!.address, family: answers[0]!.family as 4 | 6, private: isPrivate };
}
export function maskDestination(input: string): string {
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol)) return 'Invalid destination';
    return `${url.protocol}//${url.host}/…`.slice(0, 300);
  } catch { return 'Invalid destination'; }
}
