"use strict";
/**
 * Recognize the usual problems in the log of the otbr container and translate them into a hint for the user.
 * The patterns follow the messages of otbr-agent / OpenThread posix; they are heuristics, not an API.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeLog = analyzeLog;
const RULES = [
    {
        code: 'device',
        pattern: /(hdlc_interface|uart|ttyRCP|OpenFile|Open\(\)).*(No such file or directory|Permission denied|No such device)/i,
        text: 'The serial port of the stick cannot be opened. Is the stick plugged in and the port in the settings correct?',
    },
    {
        code: 'incompatible',
        pattern: /RadioSpinelIncompatible|RCP API Version|not in the supported range|Unsupported spinel/i,
        text: 'The firmware of the stick does not fit to this version of otbr-agent. Update the OpenThread RCP firmware of the stick (or use an older image).',
    },
    {
        code: 'noResponse',
        pattern: /RadioSpinelNoResponse|no response from RCP|Failed to communicate with RCP|RCP failure|co-processor.*(failed|timeout)|Wait for response timeout/i,
        text: 'The stick does not answer. It probably still has Zigbee firmware (flash the OpenThread RCP firmware), or the baud rate or flow control does not match the firmware.',
    },
    {
        code: 'infraInterface',
        pattern: /(infra|backbone).*(No such device|not found|Invalid)|InfraIf.*(Failure|Invalid)/i,
        text: 'The network interface for the LAN does not exist on the Docker host. Check "Network interface" in the settings.',
    },
];
/** The most important problem of the given log lines (the newest match wins within one kind) */
function analyzeLog(lines) {
    for (const rule of RULES) {
        for (let i = lines.length - 1; i >= 0; i--) {
            if (rule.pattern.test(lines[i])) {
                return { code: rule.code, text: rule.text, line: lines[i].trim() };
            }
        }
    }
    return null;
}
//# sourceMappingURL=logHints.js.map