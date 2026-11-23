const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const ioPackage = require('../../io-package.json');
const compose = readFileSync(join(__dirname, '..', '..', 'docker-compose.yaml'), 'utf8');
const jsonConfig = require('../../admin/jsonConfig.json');

describe('docker-compose.yaml', () => {
    it('is registered for the docker plugin', () => {
        assert.deepEqual(ioPackage.common.plugins.docker.iobDockerComposeFiles, ['docker-compose.yaml']);
    });

    it('runs on the host network, privileged, with the stick as device', () => {
        assert.match(compose, /^\s+network_mode: host$/m);
        assert.match(compose, /^\s+privileged: true$/m);
        assert.ok(compose.includes("- '${config.serialPort}:/dev/ttyRCP'"));
        assert.ok(compose.includes('spinel+hdlc+uart:///dev/ttyRCP?uart-baudrate='));
    });

    it('waits for the adapter, is opt-in and keeps running without the instance', () => {
        assert.ok(compose.includes("'iobWaitForReady=true'"));
        assert.ok(compose.includes("'iobEnabled=${config.dockerEnabled:-false}'"));
        assert.ok(compose.includes("'iobStopOnUnload=${config.dockerStopOnUnload:-false}'"));
        assert.equal(ioPackage.native.dockerStopOnUnload, false);
    });

    it('stores the Thread network in a backed up volume', () => {
        assert.ok(compose.includes("'iobBackup=otbr_data'"));
        assert.ok(compose.includes("'otbr_data:/data'"));
    });

    it('only references existing native settings', () => {
        const refs = [...compose.matchAll(/\$\{config\.([a-zA-Z]+)/g)].map(m => m[1]);
        assert.ok(refs.length > 0);
        for (const ref of refs.filter(r => r !== 'dockerImage')) {
            assert.ok(Object.hasOwn(ioPackage.native, ref), `native.${ref} is missing`);
        }
    });

    it('pins the image to a release of openthread/border-router by digest', () => {
        const match = compose.match(/image: '\$\{config\.dockerImage:-([^}]+)\}'/);
        assert.ok(match, 'image line not found');
        assert.match(match[1], /^openthread\/border-router:v\d{4}\.\d{2}\.\d+@sha256:[0-9a-f]{64}$/);
        // only a missing value takes the default of the compose file, an empty string would be used as image
        assert.ok(!Object.hasOwn(ioPackage.native, 'dockerImage'), 'native.dockerImage must not be set');
    });

    it('has no ${...} that the docker plugin would take for an unknown template', () => {
        const templates = [...compose.matchAll(/\$\{([^}]*)\}/g)].map(m => m[1]);
        for (const template of templates) {
            assert.match(template, /^config\.[a-zA-Z]+(:-.*)?$/, `\${${template}} is not a config template`);
        }
    });

    it('keeps /init (s6-overlay) as PID 1 after preparing the host', () => {
        assert.ok(compose.includes('exec /init'));
        assert.ok(compose.includes('"$IOB_PREPARE_HOST" = "true"'));
    });

    it('does not use the port of ioBroker admin for the REST API', () => {
        assert.notEqual(ioPackage.native.restPort, 8081);
        assert.equal(ioPackage.native.restBind, '127.0.0.1');
    });

    it('offers only the flow control values the radio URL understands', () => {
        const options = jsonConfig.items._radio.items.flowControl.options.map(o => o.value);
        assert.deepEqual(options, ['', '&uart-flow-control']);
        assert.ok(options.includes(ioPackage.native.flowControl));
    });
});

describe('io-package.json', () => {
    it('has a translated title, description and news', () => {
        const languages = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
        for (const lang of languages) {
            assert.ok(ioPackage.common.titleLang[lang], `titleLang.${lang}`);
            assert.ok(ioPackage.common.desc[lang], `desc.${lang}`);
            assert.ok(ioPackage.common.news[ioPackage.common.version][lang], `news.${lang}`);
        }
    });

    it('has the same version as package.json', () => {
        assert.equal(ioPackage.common.version, require('../../package.json').version);
    });

    it('creates all states the adapter writes', () => {
        const ids = ioPackage.instanceObjects.map(o => o._id);
        const main = readFileSync(join(__dirname, '..', '..', 'src', 'main.ts'), 'utf8');
        const written = [...main.matchAll(/setState(?:ChangedAsync)?\(\s*'([a-zA-Z.]+)'/g)].map(m => m[1]);
        assert.ok(written.length > 5);
        for (const id of new Set(written)) {
            assert.ok(ids.includes(id), `${id} is not in instanceObjects`);
        }
    });
});
