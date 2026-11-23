![Logo](admin/border-router.svg)

# ioBroker.border-router

Runs the [OpenThread Border Router](https://openthread.io/guides/border-router) (OTBR, `ot-br-posix`) in Docker with a
USB stick, manages its Thread network and hands the network credentials to
[ioBroker.matter](https://github.com/ioBroker/ioBroker.matter), so that Matter devices with Thread can be added
without a border router of Apple, Google or Amazon.

The container is managed by the [docker plugin](https://github.com/ioBroker/plugin-docker) of ioBroker, defined in
[docker-compose.yaml](docker-compose.yaml).

## Requirements

- Linux host with Docker 20.10+ (amd64, arm64 or armv7, e.g. a Raspberry Pi 4/5). Windows and macOS cannot run a
  border router: `otbr-agent` needs the network stack of Linux.
- js-controller 7+, admin 8+
- A USB stick with **OpenThread RCP firmware** (radio co-processor), not used by any other program.

Without Docker, the adapter can also connect to an existing border router (e.g. the OpenThread Border Router add-on
of Home Assistant) via its REST API: switch off Docker in the settings and enter the URL.

## The stick and its firmware

Most sticks come with **Zigbee** firmware. A border router needs the **OpenThread RCP** firmware instead. Zigbee and
Thread on the same stick at the same time (multiprotocol) is not supported: use one stick per network.

| Stick                                         | Chip      | RCP firmware                                                                                         | Baud / flow control |
|-----------------------------------------------|-----------|------------------------------------------------------------------------------------------------------|---------------------|
| Home Assistant Connect ZBT-1 (SkyConnect)     | EFR32MG21 | [NabuCasa/silabs-firmware-builder](https://github.com/NabuCasa/silabs-firmware-builder) (`openthread_rcp`) | 460800 / hardware   |
| Home Assistant Connect ZBT-2                  | EFR32MG24 | NabuCasa (`openthread_rcp`)                                                                         | see firmware notes  |
| Sonoff ZBDongle-E                             | EFR32MG21 | [darkxst/silabs-firmware-builder](https://github.com/darkxst/silabs-firmware-builder) (`ot-rcp`)      | 460800 / off        |
| Nordic nRF52840 Dongle                        | nRF52840  | `ot-rcp` of the nRF Connect SDK / OpenThread                                                         | USB CDC             |
| Espressif ESP32-H2 / ESP32-C6                 | ESP32-H2  | `ot_rcp` example of ESP-IDF                                                                          | 460800 / off        |
| Sonoff ZBDongle-P (TI CC2652P)                | CC2652P   | not supported                                                                                        |                     |

The baud rate and flow control **must match the firmware**. "Check the port" in the settings recognizes the known
sticks and shows their usual settings.

Flashing is not done by the adapter yet. Use for Silicon Labs sticks e.g.
[universal-silabs-flasher](https://github.com/NabuCasa/universal-silabs-flasher) or the web flasher of the firmware
project, for nRF52840 `nrfutil`, for ESP32 `esptool`.

**The firmware has to fit to the version of `otbr-agent` in the image** (Spinel/RCP API version). An outdated firmware
is reported in `info.problem`. Therefore the adapter uses a fixed, tested release of the official image
`openthread/border-router` (currently `v2026.11.0`, pinned by its digest) that changes only with a new version of the
adapter. Another image can be entered in the settings (tab Docker); only then the automatic image update is offered.

## Setup

1. Flash the OpenThread RCP firmware and plug the stick in.
2. Install the adapter, select the stick in the tab "Stick" (use the name below `/dev/serial/by-id`) and press
   "Check the port".
3. Save. The adapter detects the network interface of the LAN, pulls the image `openthread/border-router` and starts the
   container `iob_border_router_0_otbr`.
4. On the first start the adapter creates a Thread network (random network key, channel 25, 15 or 20 - not the channel
   of a Zigbee instance) and starts it.
5. Select your matter instance in the tab "Matter": the network credentials (dataset) are handed to its controller.
   Then add Thread devices in ioBroker.matter as usual (Bluetooth is needed for commissioning).

## What the container does on the host

The container runs with `network_mode: host` and `privileged: true`, because `otbr-agent`

- creates the interface `wpan0` and routes between it and the LAN,
- sets up `ip6tables`/`ipset` rules (removed again when the container stops),
- sends router advertisements and publishes the services of Thread devices via mDNS (its own mDNS implementation).

With "Prepare the host" (default) the container also sets on the Docker host (like `setup-host` of ot-br-posix; lost
on reboot, set again on every start of the container):

```
net.ipv6.conf.all.forwarding = 1
net.ipv4.ip_forward = 1
net.ipv6.conf.<lan>.accept_ra = 2
net.ipv6.conf.<lan>.accept_ra_rt_info_max_plen = 64
```

The data of the border router (dataset with the network key, SRP registrations) is in the Docker volume
`iob_border_router_0_otbr_data`, which is included in the ioBroker backup.

### Ports

| Port | Default             | Purpose                                                                    |
|------|---------------------|----------------------------------------------------------------------------|
| 8091 | `127.0.0.1` only    | REST API of `otbr-agent` (OTBR uses 8081 by default, which is ioBroker admin) |
| 8092 | `127.0.0.1` only    | Web interface of OTBR                                                      |

The REST API has no authentication and returns the network key. Open it to the network only if another system needs it.

## States

| State                      | Description                                                  |
|----------------------------|--------------------------------------------------------------|
| `info.connection`          | REST API of the border router reachable                      |
| `info.container`           | Status of the Docker container                               |
| `info.problem`             | Current problem, e.g. "The stick does not answer"            |
| `info.coprocessorVersion`  | Firmware version of the stick                                |
| `thread.enabled`           | Thread network running; writable to start/stop it            |
| `thread.role`              | `disabled`, `detached`, `child`, `router`, `leader`          |
| `thread.networkName`, `thread.channel`, `thread.panId`, `thread.extPanId`, `thread.meshLocalPrefix` | Public parameters of the network |
| `thread.routers`, `thread.rloc16`, `thread.borderAgentId` | Node information                   |

The network key is not written into any state.

## Messages

| Command            | Message                          | Answer                                                    |
|--------------------|----------------------------------|-----------------------------------------------------------|
| `getDataset`       | -                                | `{ result: { dataset, networkName, channel, panId, extPanId, meshLocalPrefix } }` - contains the network key! |
| `createNetwork`    | `{ networkName?, channel? }`     | only if the border router has no network yet              |
| `handOverToMatter` | `{ instance: 'matter.0' }`       | puts the dataset into the controller settings of ioBroker.matter |
| `checkPort`        | `{ serialPort }`                 | stick recognized, port used by another instance?          |
| `listSerialPorts`, `listInterfaces` | -               | lists for the settings dialog                             |

```js
sendTo('border-router.0', 'getDataset', {}, res => log(res.result.dataset));
```

## Hand-over to ioBroker.matter

The adapter writes the network name and the dataset into `matter.X.controller` (via the message
`updateControllerSettings` of ioBroker.matter, or directly into the object if the instance is not running). If the
default Thread network there was entered by hand, it is kept and this network is added to the additional Thread
credentials under the ID `border-router.0`.

## Roadmap

- Flash the RCP firmware from the adapter (flasher container with `universal-silabs-flasher`)
- Test each monthly release of ot-br-posix with the supported firmwares and pin it in a new version of the adapter
- Network sticks (SLZB-06M/07 via TCP)
- Topology and diagnostics of the Thread network

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

## Changelog
### 0.0.1 (2026-11-23)
- (@GermanBluefox) Initial release

## License

MIT License

Copyright (c) 2026 bluefox <dogafox@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
