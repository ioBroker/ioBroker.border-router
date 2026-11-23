/** The parts of an instance object that are looked at */
export interface InstanceLike {
    _id: string;
    common?: { enabled?: boolean };
    native?: Record<string, unknown>;
}

function containsPath(value: unknown, paths: string[], depth: number): boolean {
    if (typeof value === 'string') {
        return paths.includes(value.trim());
    }
    if (depth <= 0 || !value || typeof value !== 'object') {
        return false;
    }
    return Object.values(value as Record<string, unknown>).some(v => containsPath(v, paths, depth - 1));
}

/**
 * Find the enabled instances that use the same serial port (e.g. a Zigbee adapter). A stick can only be
 * opened by one program; Zigbee and Thread on the same stick (multiprotocol) is not supported.
 *
 * @param instances all instance objects (`system.adapter.*`)
 * @param paths the configured path and the device it resolves to, e.g. `/dev/serial/by-id/usb-...` and `/dev/ttyUSB0`
 * @param ownId `system.adapter.border-router.0`
 * @returns the IDs of the other instances, e.g. `zigbee.0`
 */
export function findPortUsers(instances: InstanceLike[], paths: string[], ownId: string): string[] {
    const wanted = paths.filter(Boolean);
    if (!wanted.length) {
        return [];
    }
    return instances
        .filter(obj => obj._id !== ownId && obj.common?.enabled && containsPath(obj.native, wanted, 3))
        .map(obj => obj._id.replace(/^system\.adapter\./, ''));
}

/** Channels of the Zigbee networks of this installation, to choose a different one for Thread */
export function zigbeeChannels(instances: InstanceLike[]): number[] {
    const channels: number[] = [];
    for (const obj of instances) {
        if (!/^system\.adapter\.zigbee\.\d+$/.test(obj._id)) {
            continue;
        }
        const raw = obj.native?.channel;
        const channel = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) : NaN;
        if (channel >= 11 && channel <= 26) {
            channels.push(channel);
        }
    }
    return channels;
}
