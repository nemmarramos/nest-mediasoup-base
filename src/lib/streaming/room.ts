import config from 'config';
import io from 'socket.io';

import { types as mediasoupTypes } from 'mediasoup';
import { Logger } from '@nestjs/common';
import {
    ConsumerLayers,
    ConsumerScore,
    Producer,
    RouterOptions,
    Worker,
} from 'mediasoup/lib/types';
import { EnhancedEventEmitter } from 'mediasoup/lib/EnhancedEventEmitter';

import {
    IClientProfile,
    IMediasoupClient,
    IPeerConsumerTransport,
    IProducerConnectorTransport,
    IProduceTrack,
    IRoom,
    IRoomClient,
} from './interfaces';

const mediasoupSettings = config.get<IMediasoupSettings>('MEDIASOUP_SETTINGS');
type TPeer = 'producer' | 'consumer';

export class Room extends EnhancedEventEmitter implements IRoom {
    public readonly clients: Map<string, IRoomClient> = new Map();
    public router: mediasoupTypes.Router;
    public audioLevelObserver: mediasoupTypes.AudioLevelObserver;
    private logger: Logger = new Logger('Room');
    private host: IRoomClient;

    constructor(
        private worker: Worker,
        public workerIndex: number,
        public readonly name: string,
        private readonly socketServer: io.Server,
    ) {
        super();
    }

    private async configureWorker() {
        try {
            // Stringify and parse JSON to bypass object read-only error
            this.router = await this.worker.createRouter({
                mediaCodecs: JSON.parse(JSON.stringify(mediasoupSettings.router.mediaCodecs)),
            } as RouterOptions);

            this.audioLevelObserver = await this.router.createAudioLevelObserver({
                maxEntries: 1,
                threshold: -80,
                interval: 800,
            });

            this.audioLevelObserver.on(
                'volumes',
                (volumes: Array<{ producer: mediasoupTypes.Producer; volume: number }>) => {
                    this.socketServer.to(this.name).emit('mediaActiveSpeaker', {
                        peerId: (volumes[0].producer.appData as { peerId: string }).peerId,
                        volume: volumes[0].volume,
                    });
                },
            );
            this.audioLevelObserver.on('silence', () => {
                this.socketServer.to(this.name).emit('mediaActiveSpeaker', {
                    peerId: null,
                });
            });
        } catch (error) {
            console.error(error);
            this.logger.error(error.message, error.stack, 'Room - configureWorker');
        }
    }

    // private getHostMediaClient(): IMediasoupClient {
    //   const hostClient = this.clients.get(this.host.id)
    //   // console.log('hostClient', hostClient)
    //   // this.logger.debug('getHostMediaClient hostClient', JSON.stringify(hostClient))
    //   return hostClient && hostClient.media
    // }

    public async createWebRtcTransport(data: { type: TPeer }, peerId: string): Promise<object> {
        try {
            this.logger.log(`room ${this.name} createWebRtcTransport - ${data.type}`);
            const user = this.clients.get(peerId);
            if (this.router.closed) {
                await this.configureWorker();
            }

            const { initialAvailableOutgoingBitrate } = mediasoupSettings.webRtcTransport;

            const transport = await this.router.createWebRtcTransport({
                listenIps: mediasoupSettings.webRtcTransport.listenIps,
                enableUdp: true,
                enableSctp: true,
                enableTcp: true,
                initialAvailableOutgoingBitrate,
                appData: { peerId, type: data.type },
            });

            switch (data.type) {
                case 'producer':
                    user.media.producerTransport = transport;
                    break;
                case 'consumer':
                    user.media.consumerTransport = transport;
                    break;
            }

            //   await this.updateMaxIncomingBitrate();

            return {
                params: {
                    id: transport.id,
                    iceParameters: transport.iceParameters,
                    iceCandidates: transport.iceCandidates,
                    dtlsParameters: transport.dtlsParameters,
                },
                type: data.type,
            };
        } catch (error) {
            console.error(error);
            this.logger.error(
                error.message,
                error.stack,
                'MediasoupHelper - createWebRtcTransport',
            );
        }
    }

    public async consume(data: IPeerConsumerTransport): Promise<Object> {
        try {
            const { peerId } = data;
            this.logger.log(`consumer requested by ${peerId}`);
            this.logger.log(
                `room-${this.name} | consumer-peerId ${data.peerId} | producer-peerId:${
                    data.toConsumePeerId
                }`,
            );
            const user = this.clients.get(data.peerId);
            const userToConsume = this.clients.get(data.toConsumePeerId);
            let fromProducer: Producer;

            // this.logger.log('hostClient', hostClient.media.producerVideo)
            this.logger.log('data.kind', data.kind);
            this.logger.log('this.host.id', this.host.id);

            if (data.kind === 'video') {
                fromProducer = userToConsume.media.producerVideo;
            }

            if (data.kind === 'audio') {
                fromProducer = userToConsume.media.producerAudio;
            }
            this.logger.log(`userToConsume: ${userToConsume.userProfile.identifier}`);
            this.logger.log(`fromProducer.id: ${fromProducer && fromProducer.id}`);

            const { rtpCapabilities } = this.router;

            this.logger.log('userToConsume', userToConsume.userProfile.identifier);

            if (
                !fromProducer ||
                !rtpCapabilities ||
                !this.router.canConsume({
                    producerId: fromProducer.id,
                    rtpCapabilities,
                })
            ) {
                throw new Error(
                    `Couldn't consume ${data.kind} with 'peerId'=${user.id} and 'room_id'=${
                        this.name
                    }`,
                );
            }

            const transport = user.media.consumerTransport;

            const consumer = await transport.consume({
                producerId: fromProducer.id,
                rtpCapabilities,
                paused: data.kind === 'video',
                appData: {
                    peerId,
                    kind: data.kind,
                    producer_identifier: userToConsume.userProfile.identifier,
                },
            });

            switch (data.kind) {
                case 'video':
                    if (!user.media.consumersVideo) {
                        user.media.consumersVideo = new Map();
                    }

                    user.media.consumersVideo.set(data.peerId, consumer);

                    consumer.on('transportclose', async () => {
                        this.logger.debug('transportclose');
                        consumer.close();
                        user.media.consumersVideo.delete(data.peerId);
                    });

                    consumer.on('producerclose', async () => {
                        this.logger.debug('producerclose');
                        user.io.emit('mediaProducerClose', {
                            peerId: data.peerId,
                            kind: data.kind,
                        });
                        consumer.close();
                        user.media.consumersVideo.delete(data.peerId);
                    });
                    break;
                case 'audio':
                    if (!user.media.consumersAudio) {
                        user.media.consumersAudio = new Map();
                    }

                    user.media.consumersAudio.set(data.peerId, consumer);

                    consumer.on('transportclose', async () => {
                        consumer.close();
                        user.media.consumersAudio.delete(data.peerId);
                    });

                    consumer.on('producerclose', async () => {
                        user.io.emit('mediaProducerClose', {
                            peerId: data.peerId,
                            kind: data.kind,
                        });
                        consumer.close();
                        user.media.consumersAudio.delete(data.peerId);
                    });
                    break;
            }

            consumer.on('producerpause', async () => {
                await consumer.pause();
                user.io.emit('mediaProducerPause', { peerId, kind: data.kind });
            });

            consumer.on('producerresume', async () => {
                await consumer.resume();
                user.io.emit('mediaProducerResume', { peerId, kind: data.kind });
            });

            consumer.on('score', (score: ConsumerScore) => {
                this.logger.debug(
                    `room ${this.name} user ${peerId} consumer ${data.kind} score ${JSON.stringify(
                        score,
                    )}`,
                );
            });

            consumer.on('debug', (layers: ConsumerLayers | null) => {
                this.logger.debug(
                    `room ${this.name} user ${peerId} consumer ${
                        data.kind
                    } layerschange ${JSON.stringify(layers)}`,
                );
            });

            if (consumer.kind === 'video') {
                await consumer.resume();
            }

            return {
                producerId: fromProducer.id,
                id: consumer.id,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
                type: consumer.type,
                producerPaused: consumer.producerPaused,
            };
        } catch (error) {
            this.logger.error(error.message, error.stack, 'MediasoupHelper - consume');
        }
    }

    public async broadcast(client: io.Socket, event: string, msg: object): Promise<boolean> {
        try {
            this.logger.debug('name', this.name);
            this.logger.debug('event', event);
            this.logger.debug('msg', msg);
            return client.broadcast.to(this.name).emit(event, msg);
        } catch (error) {
            this.logger.error(error.message, error.stack, 'Room - broadcast');
        }
    }

    public broadcastToHost(event: string, msg: object): boolean {
        try {
            return this.socketServer.to(this.host.io.id).emit(event, msg);
        } catch (error) {
            this.logger.error(error.message, error.stack, 'Room - broadcastAll');
        }
    }

    public broadcastAll(event: string, msg: object): void {
        try {
            this.logger.log(`Broadcast all to room: ${this.name}, msg: ${JSON.stringify(msg)}`);
            this.socketServer.to(this.name).emit(event, msg);
        } catch (error) {
            this.logger.error(error.message, error.stack, 'Room - broadcastAll');
        }
    }

    public onPeerSocketDisconnect(peerId: string) {
        this.logger.log('Room peer disconnected', peerId);

        const isHost = this.host.id === peerId;
        const user = this.clients.get(peerId);

        if (isHost) {
            // this.logger.log('room host left')
            // this.broadcastAll('roomClosed', null)
            // this.close()
        }

        if (!user) return;
        this.logger.log(`Room peer user ${JSON.stringify(user.userProfile)}`);
        const { io: client, media } = user;
        if (client) {
            this.broadcast(client, 'userDisconnected', user.userProfile);

            this.closeMediaClient(media);
            client.leave(peerId);
        }
        this.clients.delete(peerId);
    }

    private closeMediaClient(mediaClient: IMediasoupClient): boolean {
        try {
            if (mediaClient.producerVideo && !mediaClient.producerVideo.closed) {
                mediaClient.producerVideo.close();
            }
            if (mediaClient.producerAudio && !mediaClient.producerAudio.closed) {
                mediaClient.producerAudio.close();
            }
            if (mediaClient.producerTransport && !mediaClient.producerTransport.closed) {
                mediaClient.producerTransport.close();
            }
            if (mediaClient.consumerTransport && !mediaClient.consumerTransport.closed) {
                mediaClient.consumerTransport.close();
            }

            return true;
        } catch (error) {
            this.logger.error(error.message, error.stack, 'Room - closeMediaClient');
        }
    }

    public async connectWebRTCTransport(data: IProducerConnectorTransport) {
        try {
            const user = this.clients.get(data.peerId);
            this.logger.log('<----connectWebRTCTransport-----');
            this.logger.log(`data.room: ${data.room}`);
            this.logger.log(`data.peerId: ${data.peerId}`);
            this.logger.log(`data.type: ${data.type}`);
            this.logger.debug(`data.dtlsParameters: ${JSON.stringify(data.dtlsParameters)}`);

            if (data.type === 'producer') {
                this.logger.debug(
                    `user.media.producerTransport.closed: ${user.media.producerTransport.closed}`,
                );
                await user.media.producerTransport.connect({ dtlsParameters: data.dtlsParameters });
            }

            if (data.type === 'consumer') {
                this.logger.debug(
                    `user.media.consumerTransport.closed: ${user.media.consumerTransport.closed}`,
                );
                await user.media.consumerTransport.connect({ dtlsParameters: data.dtlsParameters });
            }
            this.logger.log('-----connectWebRTCTransport---->');

            return true;
        } catch (error) {
            this.logger.log('-----connectWebRTCTransport---->');
            this.logger.error(
                error.message,
                error.stack,
                'MediasoupHelper - connectProducerTransport',
            );
        }
    }

    public async produce(data: IProduceTrack): Promise<string> {
        try {
            this.logger.log('wss:produce');
            this.logger.log('clientCount', this.clientCount);
            const user = this.clients.get(data.peerId);

            if (user && this.clientCount < 2) {
                this.host = user;
            }
            const transport = user.media.producerTransport;
            if (!transport) {
                throw new Error(
                    `Couldn't find producer transport with 'peerId'=${data.peerId} and 'room_id'=${
                        this.name
                    }`,
                );
            }
            const producer = await transport.produce({
                ...data,
                appData: { peerId: data.peerId, kind: data.kind },
            });
            this.logger.log('data.kind', data.kind);

            if (data.kind === 'video') {
                this.logger.log('video produce');

                user.media.producerVideo = producer;
            }
            if (data.kind === 'audio') {
                user.media.producerAudio = producer;
                await this.audioLevelObserver.addProducer({ producerId: producer.id });
            }

            return producer.id;
        } catch (error) {
            this.logger.log('Error', error);
            return Promise.resolve(null);
        }
    }

    public async close(): Promise<void> {
        try {
            this.clients.forEach(user => {
                const { io: client, media, id } = user;

                if (client) {
                    client.broadcast.to(this.name).emit('mediaDisconnectMember', { id });
                    client.leave(this.name);
                }

                if (media) {
                    this.closeMediaClient(media);
                }
            });

            var params = {
                DelaySeconds: 1,
                MessageBody: this.name,
                QueueUrl:
                    process.env.STREAM_ENDED_EVENT_QUEUE ||
                    'http://0.0.0.0:9324/queue/StreamEndedEventQueue',
            };
            this.logger.debug(`sqs params => ${JSON.stringify(params)}`);

            this.clients.clear();
            this.audioLevelObserver.close();
            this.router.close();

            this.logger.debug(`room ${this.name} closed`);
        } catch (error) {
            this.logger.log('Error', error);
        }
    }

    public leave(peerId: string): void {
        return this.onPeerSocketDisconnect(peerId);
    }

    public async load(): Promise<void> {
        try {
            await this.configureWorker();
        } catch (error) {
            this.logger.log('Error', error);
        }
    }

    public setHost(user: IRoomClient) {
        this.host = user;
    }

    get clientCount(): number {
        return this.clients.size;
    }

    get clientsIds(): string[] {
        return Array.from(this.clients.keys());
    }

    public participants(): IClientProfile[] {
        return Array.from(this.clients.values()).map(({ userProfile }) => userProfile);
    }

    get audioProducerIds(): string[] {
        return Array.from(this.clients.values())
            .filter(c => {
                if (c.media && c.media.producerAudio && !c.media.producerAudio.closed) {
                    return true;
                }

                return false;
            })
            .map(c => c.id);
    }

    get videoProducerIds(): string[] {
        return Array.from(this.clients.values())
            .filter(c => {
                if (c.media && c.media.producerVideo && !c.media.producerVideo.closed) {
                    return true;
                }

                return false;
            })
            .map(c => c.id);
    }

    get producerIds(): string[] {
        return Array.from(this.clients.values())
            .filter(c => {
                if (c.media) {
                    if (c.media.producerVideo || c.media.producerAudio) {
                        return true;
                    } else {
                        return false;
                    }
                } else {
                    return false;
                }
            })
            .map(c => c.id);
    }

    public getRouterRtpCapabilities(): mediasoupTypes.RtpCapabilities {
        return this.router.rtpCapabilities;
    }

    public async addClient(
        peerId: string,
        client: io.Socket,
        userProfile: IClientProfile,
    ): Promise<boolean> {
        try {
            this.logger.debug(`${peerId} connected to room ${this.name}`);
            this.logger.debug(`${peerId} profile ${JSON.stringify(userProfile)}`);
            this.clients.set(peerId, { io: client, id: peerId, userProfile, media: {} });

            client.join(this.name);
            this.logger.debug('room', this.name, 'Room - addClient');
            this.logger.debug('peerId', peerId, 'Room - addClient');

            await this.broadcast(client, 'userJoined', userProfile);

            return true;
        } catch (error) {
            this.logger.error(error.message, error.stack, 'Room - addClient');
        }
    }

    get stats() {
        const clientsArray = Array.from(this.clients.values());

        return {
            id: this.name,
            worker: this.workerIndex,
            clients: clientsArray.map(c => ({
                id: c.id,
                produceAudio: c.media.producerAudio ? true : false,
                produceVideo: c.media.producerVideo ? true : false,
            })),
        };
    }
}
