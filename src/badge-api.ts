/**
 * @author Nicolai Electronics
 * @author Reinier van der Leer
 */

import { BadgeUSB, TransactionArgs } from "./badge-usb";
import { BadgeFileSystemApi } from "./api/filesystem";
import { BadgeAppFSApi } from "./api/appfs";
import { BadgeNVSApi } from "./api/nvs";

export type ProgressCallback = (status: string, progressPercent: number) => void;

export class BadgeAPI {
    public badge?: BadgeUSB;

    textEncoder = new TextEncoder();
    textDecoder = new TextDecoder();

    async connect() {
        this.badge = await BadgeUSB.connect();
        this.badge.onConnectionLost = () => delete this.badge;

        if (this._onConnectionLost) this._onConnectionLost();
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

    set onConnectionLost(callback: () => void) {
        this._onConnectionLost = callback;
    }

    private _onConnectionLost?: () => void;

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
        (...args: TransactionArgs) => this.transaction(...args),
    );

    /*** AppFS API ***/
    public appFS = new BadgeAppFSApi(
        this.fileSystem,
        this.disconnect,
        (...args: TransactionArgs) => this.transaction(...args),
    );

    /*** NVS API */
    public nvs = new BadgeNVSApi(
        (...args: TransactionArgs) => this.transaction(...args),
    );
}
