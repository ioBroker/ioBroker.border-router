/**
 * Helpers for the Thread operational dataset and the node information of otbr-agent.
 *
 * The dataset is handled as TLV hex string (what `GET /node/dataset/active` returns with `Accept: text/plain`).
 * It contains the network key: only the public fields are decoded here, the key itself never leaves this module
 * other than inside the hex string.
 */

/** MeshCoP TLV types (Thread specification, chapter 8.10) */
const TLV_CHANNEL = 0;
const TLV_PAN_ID = 1;
const TLV_EXT_PAN_ID = 2;
const TLV_NETWORK_NAME = 3;
const TLV_NETWORK_KEY = 5;
const TLV_MESH_LOCAL_PREFIX = 7;
const TLV_ACTIVE_TIMESTAMP = 14;

/** The public part of an operational dataset */
export interface DatasetInfo {
    channel?: number;
    panId?: number;
    /** 16 hex digits, upper case */
    extPanId?: string;
    networkName?: string;
    /** e.g. `fd11:2233:4455:6677::/64` */
    meshLocalPrefix?: string;
    /** seconds of the active timestamp */
    activeTimestamp?: number;
    hasNetworkKey: boolean;
}

/** The node information of `GET /node`, independent of the key format of the OTBR build */
export interface NodeInfo {
    role: ThreadRole;
    networkName?: string;
    /** 16 hex digits, upper case */
    extPanId?: string;
    /** e.g. `0x6c00` */
    rloc16?: string;
    routers?: number;
    /** Border agent ID, 32 hex digits */
    borderAgentId?: string;
    extAddress?: string;
}

export type ThreadRole = 'disabled' | 'detached' | 'child' | 'router' | 'leader' | 'unknown';

const ROLES: ThreadRole[] = ['disabled', 'detached', 'child', 'router', 'leader'];

/** Channels between the most used Wi-Fi channels 1, 6 and 11 */
const PREFERRED_CHANNELS = [25, 15, 20];

export function isHex(text: string): boolean {
    return /^([0-9a-fA-F]{2})+$/.test(text);
}

/** Decode the public fields of an operational dataset in TLV format */
export function parseDataset(hex: string): DatasetInfo {
    const clean = hex.trim();
    if (!isHex(clean)) {
        throw new Error('The dataset is not a hex string');
    }
    const bytes = Buffer.from(clean, 'hex');
    const info: DatasetInfo = { hasNetworkKey: false };
    let pos = 0;
    while (pos + 2 <= bytes.length) {
        const type = bytes[pos];
        let length = bytes[pos + 1];
        pos += 2;
        if (length === 0xff) {
            // extended TLV: 16-bit length
            if (pos + 2 > bytes.length) {
                break;
            }
            length = bytes.readUInt16BE(pos);
            pos += 2;
        }
        if (pos + length > bytes.length) {
            throw new Error(`TLV ${type} exceeds the dataset`);
        }
        const value = bytes.subarray(pos, pos + length);
        pos += length;

        switch (type) {
            case TLV_CHANNEL:
                // channel page (1 byte) + channel (2 bytes)
                if (length >= 3) {
                    info.channel = value.readUInt16BE(1);
                }
                break;
            case TLV_PAN_ID:
                if (length >= 2) {
                    info.panId = value.readUInt16BE(0);
                }
                break;
            case TLV_EXT_PAN_ID:
                info.extPanId = value.toString('hex').toUpperCase();
                break;
            case TLV_NETWORK_NAME:
                info.networkName = value.toString('utf8');
                break;
            case TLV_NETWORK_KEY:
                info.hasNetworkKey = length === 16;
                break;
            case TLV_MESH_LOCAL_PREFIX:
                if (length === 8) {
                    const groups: string[] = [];
                    for (let i = 0; i < 8; i += 2) {
                        groups.push(value.readUInt16BE(i).toString(16));
                    }
                    info.meshLocalPrefix = `${groups.join(':')}::/64`;
                }
                break;
            case TLV_ACTIVE_TIMESTAMP:
                // 48 bits of seconds, 15 bits of ticks, 1 bit "authoritative"
                if (length >= 6) {
                    info.activeTimestamp = value.readUIntBE(0, 6);
                }
                break;
            default:
                break;
        }
    }
    return info;
}

/** Map the role of `/node` or `/node/state` (string, or a number on old builds) to a name */
export function roleName(state: unknown): ThreadRole {
    if (typeof state === 'number') {
        return ROLES[state] ?? 'unknown';
    }
    if (typeof state === 'string') {
        const lower = state.trim().toLowerCase();
        if ((ROLES as string[]).includes(lower)) {
            return lower as ThreadRole;
        }
        // "offline" is used by some builds for a disabled stack
        if (lower === 'offline') {
            return 'disabled';
        }
    }
    return 'unknown';
}

/**
 * Builds before 2024 answer with PascalCase keys (`NetworkName`), newer ones with camelCase (`networkName`).
 * Bring them to camelCase.
 */
export function normalizeKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(normalizeKeys);
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
            const normalized = key === 'BaId' ? 'baId' : key.charAt(0).toLowerCase() + key.slice(1);
            out[normalized] = normalizeKeys(v);
        }
        return out;
    }
    return value;
}

function hexText(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value.toUpperCase() : undefined;
}

/** Convert the answer of `GET /node` */
export function parseNode(body: unknown): NodeInfo {
    const node = normalizeKeys(body) as Record<string, unknown> | null;
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        throw new Error('/node did not return an object');
    }
    const routers = node.numOfRouter ?? node.routerCount;
    let rloc16: string | undefined;
    if (typeof node.rloc16 === 'number') {
        rloc16 = `0x${node.rloc16.toString(16).padStart(4, '0')}`;
    } else if (typeof node.rloc16 === 'string' && node.rloc16) {
        rloc16 = node.rloc16.toLowerCase();
    }
    return {
        role: roleName(node.state),
        networkName: typeof node.networkName === 'string' ? node.networkName : undefined,
        extPanId: hexText(node.extPanId),
        rloc16,
        routers: typeof routers === 'number' ? routers : undefined,
        borderAgentId: hexText(node.baId),
        extAddress: hexText(node.extAddress),
    };
}

/** A network name has at most 16 bytes (UTF-8) */
export function isValidNetworkName(name: string): boolean {
    return !!name && Buffer.byteLength(name, 'utf8') <= 16;
}

export function isValidChannel(channel: number): boolean {
    return Number.isInteger(channel) && channel >= 11 && channel <= 26;
}

/**
 * Choose a Thread channel: one between the Wi-Fi channels 1, 6 and 11 that no Zigbee network on this
 * installation uses. Thread and Zigbee share the same 2.4 GHz channels 11 to 26.
 */
export function chooseChannel(usedChannels: number[]): number {
    return PREFERRED_CHANNELS.find(ch => !usedChannels.includes(ch)) ?? PREFERRED_CHANNELS[0];
}

/** A random network name like `ioBroker-3fa2` */
export function defaultNetworkName(randomHex: string): string {
    return `ioBroker-${randomHex.slice(0, 4).toLowerCase()}`;
}
