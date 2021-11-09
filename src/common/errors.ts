import { HttpException, HttpStatus } from '@nestjs/common';

export const throwRoomNotFound = (msg: string | null = null) => {
    throw new HttpException(
        {
            status: HttpStatus.BAD_REQUEST,
            error: msg || 'Room not found',
        },
        HttpStatus.BAD_REQUEST,
    );
};
