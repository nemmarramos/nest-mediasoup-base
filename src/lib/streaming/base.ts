import {
    MessageBody,
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import io, { Socket, Server } from 'socket.io';
import * as mediasoup from 'mediasoup';
import { WorkerSettings } from 'mediasoup/lib/types';
import { Worker } from 'mediasoup/lib/types';

import {
    IPeerConnection,
    IProducerConnectorTransport,
    IPeerTransport,
    IProduceTrack,
    IRoomMessageWrapper,
    IClientProfile,
    IConsumePeerTransport,
} from './interfaces';
import { throwRoomNotFound } from '../../common/errors';
import { IRoom } from './interfaces';

@WebSocketGateway()
export abstract class BaseGateway<T extends IRoom>
    implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    protected server: Server;

    protected rooms: Map<string, T> = new Map();

    private baseLogger: Logger = new Logger('BaseGateway');
    protected workers: {
        [index: number]: { clientsCount: number; roomsCount: number; pid: number; worker: Worker };
    };

    constructor(mediasoupSettings: IMediasoupSettings, private roomType) {
        this.baseLogger.debug('mediasoupSettings', mediasoupSettings);

        this.createWorkers(mediasoupSettings);
    }

    private async createWorkers(mediasoupSettings: IMediasoupSettings): Promise<void> {
        const promises = [];
        for (let i = 0; i < mediasoupSettings.workerPool; i++) {
            promises.push(mediasoup.createWorker(mediasoupSettings.worker as WorkerSettings));
        }

        this.workers = (await Promise.all(promises)).reduce((acc, worker, index) => {
            acc[index] = {
                clientsCount: 0,
                roomsCount: 0,
                pid: worker.pid,
                worker: worker,
            };

            return acc;
        }, {});
    }

    // private getClientQuery(client: io.Socket): IClientQuery {
    //   return client.handshake.query as unknown as IClientQuery;
    // }

    protected getOptimalWorkerIndex(): number {
        return parseInt(
            Object.entries(this.workers).reduce((prev, curr) => {
                if (prev[1].clientsCount < curr[1].clientsCount) {
                    return prev;
                }
                return curr;
            })[0],
            10,
        );
    }

    protected async loadRoom(peerConnection: IPeerConnection, socket: io.Socket): Promise<boolean> {
        try {
            const { peerId, room: roomName, userProfile } = peerConnection;
            this.baseLogger.debug('peerConnection', JSON.stringify(peerConnection));
            let room = this.rooms.get(roomName);
            this.baseLogger.log('Checking room status');
            this.baseLogger.log('isLoaded', Boolean(room));
            if (!room) {
                const index = this.getOptimalWorkerIndex();
                room = new this.roomType(this.workers[index].worker, index, roomName, this.server);

                await room.load();

                room.setHost({ io: socket, id: peerId, userProfile, media: {} });
                this.rooms.set(roomName, room);

                this.baseLogger.log(`room ${roomName} created`);
            }

            socket.on('disconnect', u => {
                this.baseLogger.log('user disconnected', u);
                room.onPeerSocketDisconnect(peerId);
            });

            await room.addClient(peerId, socket, userProfile);
            return true;
        } catch (error) {
            this.baseLogger.error(error.message, error.stack, 'BaseGateway - handleConnection');
        }
    }

    @SubscribeMessage('joinRoom')
    async joinRoom(
        @MessageBody() data: IPeerConnection,
        @ConnectedSocket() socket: Socket,
    ): Promise<boolean> {
        return this.loadRoom(data, socket);
    }

    @SubscribeMessage('getParticipants')
    async getParticipants(@MessageBody() data: IPeerConnection): Promise<IClientProfile[]> {
        const room = this.rooms.get(data.room);
        if (!room) return throwRoomNotFound(null);
        return room.participants();
    }

    @SubscribeMessage('leaveRoom')
    async leaveRoom(@MessageBody() data: IPeerConnection): Promise<void> {
        const room = this.rooms.get(data.room);
        if (!room) return throwRoomNotFound(null);
        return room.leave(data.peerId);
    }

    @SubscribeMessage('createWebRTCTransport')
    async createWebRTCTransport(@MessageBody() data: IPeerTransport): Promise<any> {
        const room = this.rooms.get(data.room);
        if (!room) return throwRoomNotFound(null);
        return room.createWebRtcTransport({ type: data.type }, data.peerId);
    }

    @SubscribeMessage('getRtpCapabilities')
    async getRtpCapabilities(@MessageBody() data: IPeerTransport): Promise<any> {
        const room = this.rooms.get(data.room);
        if (!room) return throwRoomNotFound(null);
        return room.getRouterRtpCapabilities();
    }

    @SubscribeMessage('sendMessage')
    async onNewMessage(
        @MessageBody() data: IRoomMessageWrapper,
        @ConnectedSocket() socket: Socket,
    ): Promise<any> {
        const room = this.rooms.get(data.room);
        if (!room) return throwRoomNotFound(null);
        return room.broadcast(socket, 'newMessage', {
            ...data.message,
            room: data.room,
        });
    }

    @SubscribeMessage('consume')
    async consume(@MessageBody() data: IConsumePeerTransport): Promise<any> {
        const room = this.rooms.get(data.room);
        if (!room) return throwRoomNotFound(null);
        return room.consume(data);
    }

    @SubscribeMessage('connectWebRTCTransport')
    async connectWebRTCTransport(@MessageBody() data: IProducerConnectorTransport): Promise<any> {
        const room = this.rooms.get(data.room);
        if (!room) return throwRoomNotFound(null);
        return room.connectWebRTCTransport(data);
    }

    @SubscribeMessage('produce')
    produce(@MessageBody() data: IProduceTrack): Promise<string> {
        const room = this.rooms.get(data.room);
        if (room) return room.produce(data as IProduceTrack);
        return Promise.resolve(null);
    }

    @SubscribeMessage('unpublishRoom')
    unpublishRoom(@MessageBody() data: any): Promise<void> {
        this.baseLogger.log('unpublishRoom', data);
        const room = this.rooms.get(data.room);
        if (room) return room.close();
        return Promise.resolve();
    }

    afterInit() {
        this.baseLogger.log('Init');
    }

    @SubscribeMessage('identity')
    async identity(@MessageBody() data: number): Promise<number> {
        return data;
    }

    handleDisconnect(client: Socket) {
        this.baseLogger.log(`Client disconnected: ${client.id}`);
    }

    handleConnection(client: io.Socket) {
        this.baseLogger.log(`Client connected: ${client.id}`);
    }
}
