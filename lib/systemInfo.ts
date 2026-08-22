// Best-effort, honest device telemetry. Every field is either a real value
// the browser exposes, or null — nothing here is a plausible-looking fake.

interface NetworkInformation {
  downlink?: number;
  effectiveType?: string;
}

interface NavigatorExtras {
  deviceMemory?: number;
  connection?: NetworkInformation;
  getBattery?: () => Promise<BatteryManagerLike>;
}

interface BatteryManagerLike {
  level: number;
  charging: boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface StaticDeviceInfo {
  cpuCores: number | null;
  deviceMemoryGB: number | null;
  downlinkMbps: number | null;
  effectiveType: string | null;
}

export function readStaticDeviceInfo(): StaticDeviceInfo {
  const nav = navigator as Navigator & NavigatorExtras;
  return {
    cpuCores: nav.hardwareConcurrency ?? null,
    deviceMemoryGB: nav.deviceMemory ?? null,
    downlinkMbps: nav.connection?.downlink ?? null,
    effectiveType: nav.connection?.effectiveType ?? null,
  };
}

export interface BatteryReading {
  level: number; // 0..1
  charging: boolean;
}

/** Subscribes to real battery level/charging changes where the (increasingly rare) API exists. */
export function watchBattery(onChange: (reading: BatteryReading | null) => void): () => void {
  const nav = navigator as Navigator & NavigatorExtras;
  if (!nav.getBattery) {
    onChange(null);
    return () => {};
  }

  let battery: BatteryManagerLike | null = null;
  const report = () => battery && onChange({ level: battery.level, charging: battery.charging });

  nav
    .getBattery()
    .then((b) => {
      battery = b;
      report();
      b.addEventListener("levelchange", report);
      b.addEventListener("chargingchange", report);
    })
    .catch(() => onChange(null));

  return () => {
    battery?.removeEventListener("levelchange", report);
    battery?.removeEventListener("chargingchange", report);
  };
}

export interface AudioDeviceLabels {
  mic: string | null;
  speaker: string | null;
}

/** Device labels are blank until mic/output permission has been granted at least once — that's the browser, not a bug here. */
export async function readAudioDeviceLabels(): Promise<AudioDeviceLabels> {
  if (!navigator.mediaDevices?.enumerateDevices) return { mic: null, speaker: null };
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      mic: devices.find((d) => d.kind === "audioinput" && d.label)?.label ?? null,
      speaker: devices.find((d) => d.kind === "audiooutput" && d.label)?.label ?? null,
    };
  } catch {
    return { mic: null, speaker: null };
  }
}
