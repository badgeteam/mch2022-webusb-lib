import { assertNumber, assertString, assertInstanceOf } from "../lib/assert-type";
import { BadgeFileSystemApi } from "./filesystem";
import { ProgressCallback } from "../badge-api";
import { concatBuffers } from "../lib/buffers";
import { BadgeUSB } from "../badge-usb";

export type AppListing = {
    name: string,
    title: string,
    version: number,
    /** size in bytes */
    size: number,
}

export class BadgeAppFSApi {
    constructor(
        private fs: BadgeFileSystemApi,
        private disconnect: BadgeUSB['disconnect'],
        private transaction: BadgeUSB['transaction'],
    ) {}

    textEncoder = new TextEncoder();
    textDecoder = new TextDecoder();

    /** Lists the apps in the AppFS */
    async list(): Promise<AppListing[]> {
        let data = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_APP_LIST, null, 4000);

        let result: AppListing[] = [];
        while (data.byteLength > 0) {
            let dataView = new DataView(data);

            let nameLength  = dataView.getUint16(0, true);
            let name        = this.textDecoder.decode(data.slice(2, 2 + nameLength));
            let titleLength = dataView.getUint16(2 + nameLength, true);
            let title       = this.textDecoder.decode(data.slice(2 + nameLength + 2, 2 + nameLength + 2 + titleLength));
            let version     = dataView.getUint16(2 + nameLength + 2 + titleLength, true);
            let size        = dataView.getUint32(2 + nameLength + 2 + titleLength + 2, true);
            result.push({ name, title, version, size });

            data = data.slice(2 + nameLength + 2 + titleLength + 2 + 4);
        }
        return result;
    }

    /** @returns an `ArrayBuffer` containing the app binary */
    async read(name: string): Promise<ArrayBuffer> {
        assertString('name', name);

        let result = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_APP_READ, this.textEncoder.encode(name), 4000);
        if (new DataView(result).getUint8(0) !== 1) {
            throw new Error(`Failed to open app file '${name}'`);
        }

        let chunkSize = new ArrayBuffer(4);
        new DataView(chunkSize).setUint32(0, 64, true);

        let parts = [];
        while (true) {
            let part = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_TRANSFER_CHUNK, chunkSize, 4000);
            if (part === null || part.byteLength < 1) break;
            parts.push(part);
        }
        await this.fs.closeFile(); // This also works on appfs "files"
        return concatBuffers(...parts);
    }

    /** @returns whether writing the app to AppFS succeeded */
    async write(name: string, title: string, version: number, data: ArrayBuffer, progressCallback?: ProgressCallback): Promise<boolean> {
        assertString('name', name, 1, 47);
        assertString('title', title, 1, 63);
        assertNumber('version', version);
        assertInstanceOf(ArrayBuffer, 'data', data);

        let request = new Uint8Array(10 + name.length + title.length);
        let dataView = new DataView(request.buffer);
        request.set([name.length],                  0);
        request.set(this.textEncoder.encode(name),  1);
        request.set([title.length],                 1 + name.length);
        request.set(this.textEncoder.encode(title), 2 + name.length);
        dataView.setUint32(2 + name.length + title.length,      data.byteLength, true);
        dataView.setUint16(2 + name.length + title.length + 4,  version, true);

        progressCallback?.("Allocating...", 0);
        let result = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_APP_WRITE, request.buffer, 10000);
        if (new DataView(result).getUint8(0) !== 1) {
            throw new Error("Failed to allocate app");
        }

        let total = data.byteLength;
        let position = 0;
        while (data.byteLength > 0) {
            progressCallback?.("Writing...", Math.round((position * 100) / total));
            let part = data.slice(0, 1024);
            if (part.byteLength < 1) break;

            let result = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_TRANSFER_CHUNK, part, 4000);
            let written = new DataView(result).getUint32(0, true);
            if (written < 1) throw new Error("Write failed");

            position += written;
            data = data.slice(written);
        }
        progressCallback?.("Closing...", 100);
        await this.fs.closeFile();
        return (position == total);
    }

    /** @returns whether deleting the app succeeded */
    async delete(name: string) {
        assertString('name', name);

        let result = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_APP_REMOVE, this.textEncoder.encode(name), 4000);
        return (new DataView(result).getUint8(0) == 1);
    }

    /**
     * Reboots the badge into the given app
     * @returns whether the operation succeeded
     */
    async run(appName: string): Promise<boolean> {
        assertString('appName', appName);

        let result = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_APP_RUN, this.textEncoder.encode(appName), 4000);
        let success = (new DataView(result).getUint8(0) == 1);
        if (success) {
            this.disconnect(false);
        }
        return success;
    }
}
