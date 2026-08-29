import os from "node:os";
import { describe, expect, test } from "vitest";
import {
  classifyInterface,
  selectPreferredNetworkAddress,
} from "../../src/local-files/NetworkAddressSelector.js";

describe("selectPreferredNetworkAddress", () => {
  test("prefers wired connections over Wi-Fi and VPN connections", () => {
    const selected = selectPreferredNetworkAddress(interfaces({
      "Tailscale VPN": [ipv4("100.70.0.2")],
      "Wi-Fi": [ipv4("192.168.10.8")],
      "Ethernet 2": [ipv4("10.20.30.40")],
    }));

    expect(selected).toEqual({
      address: "10.20.30.40",
      interfaceName: "Ethernet 2",
      kind: "wired",
    });
  });

  test("uses Wi-Fi before an unclassified interface or VPN", () => {
    const selected = selectPreferredNetworkAddress(interfaces({
      utun4: [ipv4("10.8.0.2")],
      en0: [ipv4("172.20.1.5")],
      WLAN: [ipv4("192.168.1.20")],
    }));

    expect(selected).toMatchObject({
      address: "192.168.1.20",
      interfaceName: "WLAN",
      kind: "wifi",
    });
  });

  test("uses an unclassified physical interface before VPN as a cross-platform fallback", () => {
    const selected = selectPreferredNetworkAddress(interfaces({
      utun4: [ipv4("10.8.0.2")],
      en0: [ipv4("192.168.2.15")],
    }));

    expect(selected).toMatchObject({
      address: "192.168.2.15",
      interfaceName: "en0",
      kind: "other",
    });
  });

  test("ignores virtual, loopback, link-local, and unusable addresses", () => {
    const selected = selectPreferredNetworkAddress(interfaces({
      "vEthernet (Default Switch)": [ipv4("172.24.0.1")],
      "VMware Network Adapter": [ipv4("192.168.200.1")],
      lo: [ipv4("127.0.0.1", true)],
      Ethernet: [ipv4("169.254.20.1"), ipv4("192.168.50.12")],
    }));

    expect(selected).toMatchObject({
      address: "192.168.50.12",
      interfaceName: "Ethernet",
      kind: "wired",
    });
  });

  test("recognizes common localized and platform interface names", () => {
    expect(classifyInterface("以太网 3")).toBe("wired");
    expect(classifyInterface("无线局域网")).toBe("wifi");
    expect(classifyInterface("enp5s0")).toBe("wired");
    expect(classifyInterface("wlp2s0")).toBe("wifi");
    expect(classifyInterface("WireGuard Tunnel")).toBe("vpn");
  });
});

function interfaces(
  value: Record<string, os.NetworkInterfaceInfo[]>,
): ReturnType<typeof os.networkInterfaces> {
  return value;
}

function ipv4(address: string, internal = false): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:11:22:33:44:55",
    internal,
    cidr: `${address}/24`,
    scopeid: 0,
  };
}
