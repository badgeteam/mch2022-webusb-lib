import { assertString, assertInstanceOf } from "../lib/assert-type";
import { ProgressCallback } from "../badge-api";
import { concatBuffers } from "../lib/buffers";
import { BadgeUSB } from "../badge-usb";

export type FileListing = {
    type: "dir" | "file",
    name: string,
    stat: {
        size: number,
        modified: bigint,
    } | null
}

export class BadgeFileSystemApi {
    constructor(
        private transaction: BadgeUSB['transaction'],
    ) {}

    textEncoder = new TextEncoder();
    textDecoder = new TextDecoder();

    /** Lists entries in the folder given by `path` */
    async list(path: string): Promise<FileListing[]> {
        let pathEncoded = this.textEncoder.encode(path);
        let data: ArrayBuffer = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_FILESYSTEM_LIST, pathEncoded, 4000);

        let result: FileListing[] = [];
        while (data.byteLength > 0) {
            let dataView = new DataView(data);
            let itemType = dataView.getUint8(0);
            let itemNameLength = dataView.getUint32(1, true);
            let itemName = this.textDecoder.decode(data.slice(5, 5 + itemNameLength));
            data = data.slice(5 + itemNameLength);
            dataView = new DataView(data);
            let stat = dataView.getInt32(0, true);  // only works for files
            let itemSize = dataView.getUint32(4, true);
            let itemModified = dataView.getBigUint64(8, true);
            data = data.slice(16);
            result.push({
                type: itemType === 2 ? "dir" : "file",
                name: itemName,
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

        let result = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_FILESYSTEM_FILE_READ, this.textEncoder.encode(filePath), 4000);
        if (new DataView(result).getUint8(0) !== 1) {
            throw new Error(`Failed to open file '${filePath}'`);
        }

        let parts = [];
        let requested_size = new ArrayBuffer(4);
        new DataView(requested_size).setUint32(0, 512, true);
        while (true) {
            let part = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_TRANSFER_CHUNK, requested_size, 4000);
            if (part === null || part.byteLength < 1) break;
            parts.push(part);
        }
        await this.closeFile();
        return concatBuffers(parts);
    }

    /** @returns whether the operation succeeded */
    async writeFile(filePath: string, data: ArrayBuffer, progressCallback?: ProgressCallback) {
        assertString('filePath', filePath);
        assertInstanceOf(ArrayBuffer, 'data', data);

        if (progressCallback) {
            progressCallback("Creating...", 0);
        }
        let result = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_FILESYSTEM_FILE_WRITE, this.textEncoder.encode(filePath), 4000);
        if (new DataView(result).getUint8(0) !== 1) {
            throw new Error(`Failed to open file '${filePath}'`);
        }

        let total = data.byteLength;
        let position = 0;
        while (data.byteLength > 0) {
            if (progressCallback) {
                progressCallback("Writing...", Math.round((position * 100) / total));
            }
            let part = data.slice(0, 512);
            if (part.byteLength < 1) break;
            let result = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_TRANSFER_CHUNK, part, 4000);
            let written = new DataView(result).getUint32(0, true);
            if (written < 1) throw new Error("Write failed");
            position += written;
            data = data.slice(written);
        }
        if (progressCallback) {
            progressCallback("Closing...", 100);
        }
        await this.closeFile();
        return (position == total);
    }

    /** @returns whether the operation succeeded */
    async closeFile(): Promise<boolean> {
        let result = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_FILESYSTEM_FILE_CLOSE, null, 4000);
        return (new DataView(result).getUint8(0) == 1);
    }
}
