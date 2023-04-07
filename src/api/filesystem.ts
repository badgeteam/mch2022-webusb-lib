import { assertString, assertInstanceOf } from "../lib/assert-type";
import { ProgressCallback } from "../badge-api";
import { concatBuffers } from "../lib/buffers";
import Queue, { QToken } from "../lib/queue";
import { BadgeUSB } from "../badge-usb";

type _FSListing = {
    name: string,
    path: string,
    type: "dir" | "file",
    stat: {
        size: number,
        modified: bigint,
    } | null
}
export type DirListing = _FSListing & { type: 'dir' };
export type FileListing = _FSListing & { type: 'file' };
export type FSListing = DirListing | FileListing;

export class BadgeFileSystemApi {
    constructor(
        private transaction: BadgeUSB['transaction'],
        private transactionQueue: Queue,
    ) {}

    textEncoder = new TextEncoder();
    textDecoder = new TextDecoder();

    /**
     * Lists entries in the folder given by `path`
     * @param path default: `/internal`
     */
    async list(path: string = '/internal'): Promise<FSListing[]> {
        if (path == '') {
            throw Error('Path must not be empty');
        }
        let pathEncoded = this.textEncoder.encode(path);
        let data: ArrayBuffer = await this.transaction(
            BadgeUSB.PROTOCOL_COMMAND_FILESYSTEM_LIST,
            pathEncoded, 2000,
        );

        let result: FSListing[] = [];
        while (data.byteLength > 0) {
            let dataView = new DataView(data);
            let itemType       = dataView.getUint8(0);
            let itemNameLength = dataView.getUint32(1, true);
            let itemName       = this.textDecoder.decode(data.slice(5, 5 + itemNameLength));
            data = data.slice(5 + itemNameLength)

            dataView = new DataView(data);
            let stat         = dataView.getInt32(0, true);  // only works for files
            let itemSize     = dataView.getUint32(4, true);
            let itemModified = dataView.getBigUint64(8, true);
            data = data.slice(16);

            result.push({
                name: itemName,
                path: `${path}/${itemName}`,
                type: itemType === 2 ? "dir" : "file",
                stat: stat === 0 ? {
                    size: itemSize,
                    modified: itemModified
                } : null
            });
        }
        return result;
    }

    /** @returns whether a file or folder exists at `path` */
    async exists(path: string): Promise<boolean> {
        assertString('path', path);

        let result = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_FILESYSTEM_EXISTS, this.textEncoder.encode(path), 4000);
        return (new DataView(result).getUint8(0) == 1);
    }

    /**
     * Creates a folder at the given `path`
     * @returns whether the operation succeeded
     */
    async mkdir(path: string): Promise<boolean> {
        assertString('path', path);

        let result = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_FILESYSTEM_CREATE_DIRECTORY, this.textEncoder.encode(path), 4000);
        return (new DataView(result).getUint8(0) == 1);
    }

    /** @returns whether deleting the file/folder succeeded */
    async delete(path: string): Promise<boolean> {
        assertString('path', path);

        let result = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_FILESYSTEM_REMOVE, this.textEncoder.encode(path), 4000);
        return (new DataView(result).getUint8(0) == 1);
    }

    /** @returns an object indicating the size and free space of the device's filesystems */
    async state() {
        let result = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_FILESYSTEM_STATE, null, 4000);
        let dataView = new DataView(result);
        return {
            internal: {
                size: dataView.getBigUint64(0, true),
                free: dataView.getBigUint64(8, true)
            },
            sd: {
                size: dataView.getBigUint64(16, true),
                free: dataView.getBigUint64(24, true)
            },
            app: {
                size: dataView.getBigUint64(32, true),
                free: dataView.getBigUint64(40, true)
            }
        };
    }

    /** @returns an `ArrayBuffer` containing the file's contents */
    async readFile(filePath: string): Promise<ArrayBuffer> {
        assertString('filePath', filePath);

        const parts: ArrayBuffer[] = [];
        const queueToken = await this.transactionQueue.waitTurn();
        try {
            let result = await this.transaction(
                BadgeUSB.PROTOCOL_COMMAND_FILESYSTEM_FILE_READ,
                this.textEncoder.encode(filePath), 4000, queueToken,
            );
            if (new DataView(result).getUint8(0) !== 1) {
                throw new Error(`Failed to open file '${filePath}'`);
            }

            const chunkSize = 512;
            let chunkSizeField = new ArrayBuffer(4);
            new DataView(chunkSizeField).setUint32(0, chunkSize, true);

            let part: ArrayBuffer;
            do {
                part = await this.transaction(
                    BadgeUSB.PROTOCOL_COMMAND_TRANSFER_CHUNK,
                    chunkSizeField, 4000, queueToken,
                );
                if (part === null) break;
                parts.push(part);
            } while (part.byteLength == chunkSize)

        } finally {
            await this.closeFile(queueToken);
            this.transactionQueue.release(queueToken);
        }
        return concatBuffers(...parts);
    }

    /** @returns whether the operation succeeded */
    async writeFile(filePath: string, data: ArrayBuffer, progressCallback?: ProgressCallback) {
        assertString('filePath', filePath);
        assertInstanceOf(ArrayBuffer, 'data', data);

        progressCallback?.("Creating...", 0);

        const total = data.byteLength;
        let position = 0;

        const queueToken = await this.transactionQueue.waitTurn();
        try {
            let result = await this.transaction(
                BadgeUSB.PROTOCOL_COMMAND_FILESYSTEM_FILE_WRITE,
                this.textEncoder.encode(filePath), 4000, queueToken,
            );
            if (new DataView(result).getUint8(0) !== 1) {
                throw new Error(`Failed to open file '${filePath}'`);
            }

            while (data.byteLength > 0) {
                progressCallback?.("Writing...", Math.round((position * 100) / total));

                let part = data.slice(0, 512);
                if (part.byteLength < 1) break;
                let result = await this.transaction(
                    BadgeUSB.PROTOCOL_COMMAND_TRANSFER_CHUNK,
                    part, 4000, queueToken,
                );

                let written = new DataView(result).getUint32(0, true);
                if (written < 1) throw new Error("Write failed");
                position += written;
                data = data.slice(written);
            }
        } finally {
            progressCallback?.("Closing...", 100);
            await this.closeFile(queueToken);
            this.transactionQueue.release(queueToken);
        }
        return (position == total);
    }

    /** @returns whether the operation succeeded */
    async closeFile(queueToken: QToken): Promise<boolean> {
        let result = await this.transaction(
            BadgeUSB.PROTOCOL_COMMAND_FILESYSTEM_FILE_CLOSE,
            null, 4000, queueToken,
        );
        return (new DataView(result).getUint8(0) == 1);
    }
}
