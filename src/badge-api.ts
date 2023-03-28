/**
 * @author Renze Nicolai
 * @author Reinier van der Leer
 */

import { BadgeFilesystemAPI } from "./api/filesystem";
import { BadgeAppFSApi } from "./api/appfs";
import { BadgeNVSApi } from "./api/nvs";
import { BadgeUSB } from "./badge-usb";

export type ProgressCallback = (status: string, progressPercent: number) => void;

export class BadgeAPI {
    public badge?: BadgeUSB;

    textEncoder = new TextEncoder();
    textDecoder = new TextDecoder();

    async connect() {
        this.badge = await BadgeUSB.connect();
    }

    async disconnect(reset = false) {
        await this.syncConnection();
        await this.badge!.disconnect(reset);
        delete this.badge;
    }

    get hasConnectedBadge() {
        return this.badge !== undefined && this.badge.isConnected;
    }

    assertConnected(badge?: BadgeUSB): asserts badge is BadgeUSB {
        if (!this.badge) {
            throw new Error("not connected to a badge");
        }
        this.badge.assertConnected();
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
    public filesystem = new BadgeFilesystemAPI(this.transaction);

    /*** AppFS API ***/
    public appfs = new BadgeAppFSApi(
        this.filesystem,
        this.disconnect,
        this.transaction,
    );

    /*** NVS Config API */
    public nvs = new BadgeNVSApi(this.transaction);
}
