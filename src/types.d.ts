declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** Run otbr-agent in Docker (docker-compose.yaml) */
            dockerEnabled: boolean;
            /** Missing: the image of the compose file, tested with this version of the adapter */
            dockerImage?: string;
            dockerAutoImageUpdate: boolean;
            dockerStopOnUnload: boolean;
            /** e.g. `/dev/serial/by-id/usb-Nabu_Casa_SkyConnect_v1.0_...-if00-port0` */
            serialPort: string;
            baudRate: number;
            /** '' or '&uart-flow-control', appended to the radio URL */
            flowControl: '' | '&uart-flow-control';
            /** LAN interface of the Docker host, detected on the first start */
            infraInterface: string;
            /** Set IPv6 forwarding and router advertisement settings of the host from the container */
            prepareHost: boolean;
            /** Log level of otbr-agent, 0 (emergency) to 7 (debug) */
            otLogLevel: number;
            restBind: string;
            restPort: number;
            webBind: string;
            webPort: number;
            /** REST API of a border router that is not managed by this adapter, e.g. `http://192.168.1.20:8081` */
            externalUrl: string;
            /** seconds */
            pollInterval: number;
            autoCreateNetwork: boolean;
            joinExistingNetwork: boolean;
            networkName: string;
            /** 0 = choose automatically */
            channel: number;
            /** e.g. `matter.0`, empty: do not hand the credentials to ioBroker.matter */
            matterInstance: string;
        }
    }
}

export {};
