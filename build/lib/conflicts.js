"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findPortUsers = findPortUsers;
exports.zigbeeChannels = zigbeeChannels;
function containsPath(value, paths, depth) {
    if (typeof value === 'string') {
        return paths.includes(value.trim());
    }
    if (depth <= 0 || !value || typeof value !== 'object') {
        return false;
    }
    return Object.values(value).some(v => containsPath(v, paths, depth - 1));
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
function findPortUsers(instances, paths, ownId) {
    const wanted = paths.filter(Boolean);
    if (!wanted.length) {
        return [];
    }
    return instances
        .filter(obj => obj._id !== ownId && obj.common?.enabled && containsPath(obj.native, wanted, 3))
        .map(obj => obj._id.replace(/^system\.adapter\./, ''));
}
/** Channels of the Zigbee networks of this installation, to choose a different one for Thread */
function zigbeeChannels(instances) {
    const channels = [];
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
//# sourceMappingURL=conflicts.js.map