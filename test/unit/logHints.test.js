const assert = require('node:assert/strict');
const { analyzeLog } = require('../../build/lib/logHints');

describe('log hints', () => {
    it('finds nothing in a healthy log', () => {
        assert.equal(
            analyzeLog([
                'Starting otbr-agent...',
                'otbr-agent[123]: [NOTE]-AGENT---: Thread version: 1.4.0',
                'otbr-agent[123]: 00:00:01.234 [N] Mle-----------: Role disabled -> detached',
            ]),
            null,
        );
    });

    it('recognizes a stick that does not answer', () => {
        const problem = analyzeLog([
            'Starting otbr-agent...',
            'otbr-agent[95]: 49d.17:41:18.374 [C] Platform------: HandleRcpTimeout() at radio_spinel.cpp:2104: RadioSpinelNoResponse',
            'otbr-agent exited with code 1 (by signal 0).',
        ]);
        assert.equal(problem.code, 'noResponse');
        assert.match(problem.line, /RadioSpinelNoResponse/);
    });

    it('recognizes a missing device before anything else', () => {
        const problem = analyzeLog([
            'otbr-agent[95]: [C] Platform------: Init() at hdlc_interface.cpp:178: No such file or directory',
            'otbr-agent[95]: [C] P-RadioSpinel-: Failed to communicate with RCP - no response from RCP during initialization',
        ]);
        assert.equal(problem.code, 'device');
    });

    it('recognizes an incompatible firmware', () => {
        const problem = analyzeLog([
            'otbr-agent[95]: [C] P-RadioSpinel-: RCP API Version 9 is not in the supported range [11-11]',
        ]);
        assert.equal(problem.code, 'incompatible');
    });
});
