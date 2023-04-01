/**
 * @author Nicolai Electronics
 * @author Reinier van der Leer
 */

import { BadgeUSB } from "./badge-usb";
import { BadgeNVSApi } from "./api/nvs";
import { BadgeAppFSApi } from "./api/appfs";
import { BadgeFileSystemApi } from "./api/filesystem";


export type ProgressCallback = (status: string, progressPercent: number) => void;

export class BadgeAPI {
    public badge?: BadgeUSB;

    textEncoder = new TextEncoder();
    textDecoder = new TextDecoder();

    async connect(): Promise<boolean> {
        this.badge = await BadgeUSB.connect();
        this.badge.onConnectionLost = (err?: Error) => {
            delete this.badge;
            this._onConnectionLost.forEach(cb => { try { cb() } catch (e) {} });
        }

        this._onConnect.forEach(cb => { try { cb(this) } catch (e) {} });

        return true;
    }

    async disconnect(reset = false) {
        await this.syncConnection();
        await this.badge!.disconnect(reset);
        delete this.badge;
    }

    get hasConnectedBadge() {
        return this.badge !== undefined && this.badge.isConnected;
    }

    assertConnected(badge = this.badge): asserts badge is BadgeUSB {
        if (!badge) {
            throw new Error("no connected badge");
        }
        badge.assertConnected();
    }

    private _onConnect: ((api: BadgeAPI) => void)[] = [];
    private _onConnectionLost:  (() => void)[] = [];

    onConnect(callback: (api: BadgeAPI) => void) {
        this._onConnect.push(callback);
    }

    onConnectionLost(callback: (err?: Error) => void) {
        this._onConnectionLost.push(callback);
    }

    async syncConnection(): Promise<void> {
        try {
            this.assertConnected(this.badge);
        } catch (error) {
            throw new Error("Sync failed: " + error.message);
        }
        await this.badge.syncIfNeeded();
    }

    async transaction(...args: Parameters<BadgeUSB['transaction']>): Promise<ArrayBuffer> {
        this.syncConnection();
        return this.badge!.transaction(...args);
    }


    /*** Filesystem API ***/
    public fileSystem = new BadgeFileSystemApi(
        this.transaction.bind(this),
    );

    /*** AppFS API ***/
    public appFS = new BadgeAppFSApi(
        this.fileSystem,
        this.disconnect.bind(this),
        this.transaction.bind(this),
    );

    /*** NVS API */
    public nvs = new BadgeNVSApi(
        this.transaction.bind(this),
    );
}
