import os from "node:os";

export type NetworkConnectionKind = "wired" | "wifi" | "other" | "vpn";

export interface PreferredNetworkAddress {
  address: string;
  interfaceName: string;
  kind: NetworkConnectionKind;
}

type NetworkInterfaces = ReturnType<typeof os.networkInterfaces>;

const KIND_PRIORITY: Record<NetworkConnectionKind, number> = {
  wired: 0,
  wifi: 1,
  other: 2,
  vpn: 3,
};

const VIRTUAL_INTERFACE = /(?:loopback|hyper[- ]?v|vEthernet|vmware|virtualbox|docker|wsl|bluetooth|npcap|container|\bbridge\b|^br[-_]|^virbr|^veth|^awdl|^llw)/iu;
const VPN_INTERFACE = /(?:\bvpn\b|wireguard|tailscale|zerotier|hamachi|nordlynx|openvpn|anyconnect|fortinet|globalprotect|^utun\d*$|^tun\d*$|^tap\d*$|^wg\d*$|^ppp\d*$|^ipsec\d*$)/iu;
const WIFI_INTERFACE = /(?:wi-?fi|wireless|wlan|airport|无线|^wl[a-z0-9_-]*)/iu;
const WIRED_INTERFACE = /(?:ethernet|以太网|local area connection|本地连接|\blan\b|^(?:eth|enp|ens|eno|enx)[a-z0-9_-]*)/iu;

export function selectPreferredNetworkAddress(
  interfaces: NetworkInterfaces = os.networkInterfaces(),
): PreferredNetworkAddress | undefined {
  const candidates: Array<PreferredNetworkAddress & { privateAddress: boolean }> = [];

  for (const [interfaceName, addresses] of Object.entries(interfaces)) {
    if (!addresses || isExcludedInterface(interfaceName)) continue;
    const kind = classifyInterface(interfaceName);
    for (const address of addresses) {
      if (address.internal || address.family !== "IPv4" || !isUsableIpv4(address.address)) continue;
      candidates.push({
        address: address.address,
        interfaceName,
        kind,
        privateAddress: isPrivateIpv4(address.address),
      });
    }
  }

  candidates.sort((left, right) => {
    const kindDifference = KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind];
    if (kindDifference !== 0) return kindDifference;
    if (left.privateAddress !== right.privateAddress) return left.privateAddress ? -1 : 1;
    const interfaceDifference = compareText(left.interfaceName, right.interfaceName);
    return interfaceDifference !== 0 ? interfaceDifference : compareIpv4(left.address, right.address);
  });

  const selected = candidates[0];
  return selected
    ? { address: selected.address, interfaceName: selected.interfaceName, kind: selected.kind }
    : undefined;
}

export function classifyInterface(interfaceName: string): NetworkConnectionKind {
  if (VPN_INTERFACE.test(interfaceName)) return "vpn";
  if (WIFI_INTERFACE.test(interfaceName)) return "wifi";
  if (WIRED_INTERFACE.test(interfaceName)) return "wired";
  return "other";
}

function isExcludedInterface(interfaceName: string): boolean {
  return /^lo\d*$/iu.test(interfaceName) || VIRTUAL_INTERFACE.test(interfaceName);
}

function isUsableIpv4(address: string): boolean {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [first, second] = parts;
  return first !== 0
    && first !== 127
    && first < 224
    && !(first === 169 && second === 254);
}

function isPrivateIpv4(address: string): boolean {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [first, second] = parts;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127);
}

function ipv4Parts(address: string): [number, number, number, number] | undefined {
  const values = address.split(".").map((part) => Number(part));
  if (values.length !== 4 || values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return undefined;
  }
  return values as [number, number, number, number];
}

function compareText(left: string, right: string): number {
  const normalizedLeft = left.toLocaleLowerCase("en-US");
  const normalizedRight = right.toLocaleLowerCase("en-US");
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
}

function compareIpv4(left: string, right: string): number {
  const leftParts = ipv4Parts(left) ?? [0, 0, 0, 0];
  const rightParts = ipv4Parts(right) ?? [0, 0, 0, 0];
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}
