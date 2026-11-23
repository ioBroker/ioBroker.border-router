import { readdir, readFile, realpath } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

/** What is known about a stick, recognized by its name below /dev/serial/by-id */
export interface StickHint {
    name: string;
    /** Baud rate of the usual OpenThread RCP firmware; undefined if it depends on the firmware */
    baudRate?: number;
    /** Hardware flow control of the usual OpenThread RCP firmware */
    flowControl?: boolean;
    /** The stick cannot be used, or only with restrictions */
    warning?: string;
}

interface StickPattern extends StickHint {
    pattern: RegExp;
}

/**
 * Sticks seen in the field. The settings are those of the usual OpenThread RCP builds (Nabu Casa for the
 * ZBT sticks, darkxst for Sonoff), other firmware may differ: the firmware notes win.
 */
const STICKS: StickPattern[] = [
    {
        pattern: /SkyConnect|Connect_ZBT-1/i,
        name: 'Home Assistant Connect ZBT-1 / SkyConnect (EFR32MG21)',
        baudRate: 460800,
        flowControl: true,
    },
    { pattern: /ZBT-2/i, name: 'Home Assistant Connect ZBT-2 (EFR32MG24)' },
    {
        pattern: /Dongle_Plus_V2/i,
        name: 'Sonoff ZBDongle-E (EFR32MG21)',
        baudRate: 460800,
        flowControl: false,
    },
    { pattern: /MG24/i, name: 'EFR32MG24 stick' },
    { pattern: /SLZB-07/i, name: 'SMLIGHT SLZB-07 (EFR32)' },
    {
        pattern: /Dongle_Plus/i,
        name: 'Sonoff ZBDongle-P (TI CC2652P)',
        warning: 'TI CC2652 sticks are not supported as Thread radio, use a Silicon Labs EFR32 or nRF52840 stick',
    },
    { pattern: /nRF528|OpenThread_Device/i, name: 'Nordic nRF52840 (USB CDC)', baudRate: 115200, flowControl: false },
    { pattern: /Espressif/i, name: 'Espressif ESP32-H2/C6', baudRate: 460800, flowControl: false },
];

export function describeStick(path: string): StickHint | undefined {
    const stick = STICKS.find(s => s.pattern.test(path));
    if (!stick) {
        return undefined;
    }
    const { pattern: _pattern, ...hint } = stick;
    return hint;
}

export interface SerialPortEntry {
    value: string;
    label: string;
}

const BY_ID = '/dev/serial/by-id';

/**
 * Serial ports of this host: the stable names below /dev/serial/by-id first, then the kernel names.
 * Only on Linux; elsewhere (and inside a container without /dev) the list is empty.
 */
export async function listSerialPorts(): Promise<SerialPortEntry[]> {
    const result: SerialPortEntry[] = [];
    const covered = new Set<string>();
    try {
        for (const name of (await readdir(BY_ID)).sort()) {
            const path = join(BY_ID, name).replace(/\\/g, '/');
            let target = '';
            try {
                target = await realpath(path);
                covered.add(target);
            } catch {
                // dangling link
            }
            const stick = describeStick(name);
            result.push({
                value: path,
                label: `${stick ? `${stick.name}: ` : ''}${name}${target ? ` (${target})` : ''}`,
            });
        }
    } catch {
        // no USB serial devices or not Linux
    }
    try {
        for (const name of (await readdir('/dev')).sort()) {
            if (/^tty(ACM|USB|AMA)\d+$/.test(name) && !covered.has(`/dev/${name}`)) {
                result.push({ value: `/dev/${name}`, label: `/dev/${name}` });
            }
        }
    } catch {
        // not Linux
    }
    return result;
}

/**
 * docker separates the host path and the container path of a device mapping with ':'. Names below
 * /dev/serial/by-path contain ':' and cannot be used.
 */
export function isUsableDevicePath(path: string): boolean {
    return path.startsWith('/') && !path.includes(':') && !/\s/.test(path);
}

/** The interface of the default route in /proc/net/route, the LAN of this host */
export function detectDefaultInterface(routeTable: string): string | undefined {
    let best: { iface: string; metric: number } | undefined;
    for (const line of routeTable.split('\n').slice(1)) {
        const [iface, destination, , flags, , , metric] = line.trim().split(/\s+/);
        if (!iface || destination !== '00000000' || !(parseInt(flags, 16) & 1)) {
            continue;
        }
        if (/^(docker|veth|br-|wpan|lo|tun|wg)/.test(iface)) {
            continue;
        }
        const m = parseInt(metric, 10) || 0;
        if (!best || m < best.metric) {
            best = { iface, metric: m };
        }
    }
    return best?.iface;
}

export async function readDefaultInterface(): Promise<string | undefined> {
    try {
        return detectDefaultInterface(await readFile('/proc/net/route', 'utf8'));
    } catch {
        return undefined;
    }
}

/** Interfaces of this host with an address, for the selection in the settings */
export function listInterfaces(): SerialPortEntry[] {
    const result: SerialPortEntry[] = [];
    for (const [name, addresses] of Object.entries(networkInterfaces())) {
        if (!addresses || /^(docker|veth|br-|wpan|lo)/.test(name) || addresses.every(a => a.internal)) {
            continue;
        }
        const ipv4 = addresses.find(a => a.family === 'IPv4')?.address;
        result.push({ value: name, label: ipv4 ? `${name} (${ipv4})` : name });
    }
    return result;
}

/**
 * Check the kernel settings that a border router needs on the LAN interface. Returns the problems found
 * (empty if all is fine or the values cannot be read, e.g. not on Linux).
 */
export async function checkHostSettings(
    iface: string,
    read: (path: string) => Promise<string> = path => readFile(path, 'utf8'),
): Promise<string[]> {
    const problems: string[] = [];
    const value = async (path: string): Promise<number | undefined> => {
        try {
            return parseInt((await read(path)).trim(), 10);
        } catch {
            return undefined;
        }
    };
    const forwarding = await value('/proc/sys/net/ipv6/conf/all/forwarding');
    if (forwarding === 0) {
        problems.push('net.ipv6.conf.all.forwarding=1');
    }
    const acceptRa = await value(`/proc/sys/net/ipv6/conf/${iface}/accept_ra`);
    if (acceptRa !== undefined && acceptRa !== 2) {
        problems.push(`net.ipv6.conf.${iface}.accept_ra=2`);
    }
    const rtInfo = await value(`/proc/sys/net/ipv6/conf/${iface}/accept_ra_rt_info_max_plen`);
    if (rtInfo !== undefined && rtInfo < 64) {
        problems.push(`net.ipv6.conf.${iface}.accept_ra_rt_info_max_plen=64`);
    }
    return problems;
}
