/**
 * @author Renze Nicolai
 * @author Reinier van der Leer
 */

import { crc32FromArrayBuffer } from "./lib/crc32";
import { concatBuffers } from "./lib/buffers";

export enum BadgeUSBState {
    CDC    = 0x00,
    WebUSB = 0x01,
}

export class BadgeUSB {
    static filters: USBDeviceFilter[] = [
        { vendorId: 0x16d0, productId: 0x0f9a } // MCH2022 badge
    ];

    static textEncoder = new TextEncoder();
    static textDecoder = new TextDecoder();

    static readonly defaultInterfaceIndex: number | null = 4;  // Defined in the USB descriptor for MCH2022 badge, set to NULL to automatically find the first vendor interface
    static readonly defaultConfiguration = 1;

    // USB control transfer requests
    static readonly REQUEST_STATE          = 0x22;
    static readonly REQUEST_RESET          = 0x23;
    static readonly REQUEST_BAUDRATE       = 0x24;
    static readonly REQUEST_MODE           = 0x25;
    static readonly REQUEST_MODE_GET       = 0x26;
    static readonly REQUEST_FW_VERSION_GET = 0x27;

    // ESP32 firmware boot modes
    static readonly MODE_NORMAL        = 0x00;
    static readonly MODE_WEBUSB_LEGACY = 0x01;
    static readonly MODE_FPGA_DOWNLOAD = 0x02;
    static readonly MODE_WEBUSB        = 0x03;

    // Protocol
    static readonly PROTOCOL_MAGIC                               = 0xFEEDF00D;
    static readonly PROTOCOL_COMMAND_SYNC                        = new DataView(this.textEncoder.encode("SYNC").buffer).getUint32(0, true);
    static readonly PROTOCOL_COMMAND_PING                        = new DataView(this.textEncoder.encode("PING").buffer).getUint32(0, true);
    static readonly PROTOCOL_COMMAND_FILESYSTEM_LIST             = new DataView(this.textEncoder.encode("FSLS").buffer).getUint32(0, true);
    static readonly PROTOCOL_COMMAND_FILESYSTEM_EXISTS           = new DataView(this.textEncoder.encode("FSEX").buffer).getUint32(0, true);
    static readonly PROTOCOL_COMMAND_FILESYSTEM_CREATE_DIRECTORY = new DataView(this.textEncoder.encode("FSMD").buffer).getUint32(0, true);
    static readonly PROTOCOL_COMMAND_FILESYSTEM_REMOVE           = new DataView(this.textEncoder.encode("FSRM").buffer).getUint32(0, true);
    static readonly PROTOCOL_COMMAND_FILESYSTEM_STATE            = new DataView(this.textEncoder.encode("FSST").buffer).getUint32(0, true);
    static readonly PROTOCOL_COMMAND_FILESYSTEM_FILE_WRITE       = new DataView(this.textEncoder.encode("FSFW").buffer).getUint32(0, true);
    static readonly PROTOCOL_COMMAND_FILESYSTEM_FILE_READ        = new DataView(this.textEncoder.encode("FSFR").buffer).getUint32(0, true);
    static readonly PROTOCOL_COMMAND_FILESYSTEM_FILE_CLOSE       = new DataView(this.textEncoder.encode("FSFC").buffer).getUint32(0, true);
    static readonly PROTOCOL_COMMAND_TRANSFER_CHUNK              = new DataView(this.textEncoder.encode("CHNK").buffer).getUint32(0, true);
    static readonly PROTOCOL_COMMAND_APP_LIST                    = new DataView(this.textEncoder.encode("APPL").buffer).getUint32(0, true);
    static readonly PROTOCOL_COMMAND_APP_READ                    = new DataView(this.textEncoder.encode("APPR").buffer).getUint32(0, true);
    static readonly PROTOCOL_COMMAND_APP_WRITE                   = new DataView(this.textEncoder.encode("APPW").buffer).getUint32(0, true);
    static readonly PROTOCOL_COMMAND_APP_REMOVE                  = new DataView(this.textEncoder.encode("APPD").buffer).getUint32(0, true);
    static readonly PROTOCOL_COMMAND_APP_RUN                     = new DataView(this.textEncoder.encode("APPX").buffer).getUint32(0, true);
    static readonly PROTOCOL_COMMAND_CONFIGURATION_LIST          = new DataView(this.textEncoder.encode("NVSL").buffer).getUint32(0, true);
    static readonly PROTOCOL_COMMAND_CONFIGURATION_READ          = new DataView(this.textEncoder.encode("NVSR").buffer).getUint32(0, true);
    static readonly PROTOCOL_COMMAND_CONFIGURATION_WRITE         = new DataView(this.textEncoder.encode("NVSW").buffer).getUint32(0, true);
    static readonly PROTOCOL_COMMAND_CONFIGURATION_REMOVE        = new DataView(this.textEncoder.encode("NVSD").buffer).getUint32(0, true);

    dataBuffer = new ArrayBuffer(0);

    inSync = false;
    nextTransactionID: number = 0;
    transactionPromises: { [key: number]: TransactionPromise } = {};

    _onConnectionLost?: () => void;
    _onDisconnect?: () => void;

    private listening = false;
    private connected = false;

    constructor(
        private device: USBDevice,
        private interfaceIndex: number,
        private endpoints: {
            in: USBEndpoint,
            out: USBEndpoint,
        },
    ) {}

    static async connect(): Promise<BadgeUSB> {
        if (!navigator.usb) {
            throw new Error("Browser does not support WebUSB");
        }

        console.debug('Requesting device from user agent...');
        const usbDevice = await navigator.usb.requestDevice({
            filters: this.filters
        });
        console.log('Selected device:', usbDevice);

        await usbDevice.open();
        await usbDevice.selectConfiguration(this.defaultConfiguration);

        let interfaceIndex = this.defaultInterfaceIndex;
        if (interfaceIndex === null) {  // Optional automatic discovery of the interface index
            try {
                interfaceIndex = this._findInterfaceIndex(usbDevice);
            } catch(error) {
                throw new Error("Connecting: interface scan failed: " + error.message);
            }
        }
        await usbDevice.claimInterface(interfaceIndex);
        const endpoints = this._findEndpoints(usbDevice, interfaceIndex);

        const badge = new BadgeUSB(usbDevice, interfaceIndex, endpoints);

        console.debug('Connecting: requesting device to enter WebUSB mode...');
        await badge.controlSetState(BadgeUSBState.WebUSB);
        await badge.controlSetBaudrate(921600);

        let currentMode = await badge.controlGetMode();
        if (currentMode != BadgeUSB.MODE_WEBUSB) {
            await badge.controlSetMode(BadgeUSB.MODE_WEBUSB);
            await badge.controlReset(false);
        }

        badge._listen();
        console.debug('Connecting: started listening for incoming data');

        console.time('Connecting: bus synchronized');

        let protocolVersion: number | undefined;
        let n = 0;
        do {
            if (++n > 100) {
                throw new Error(`Sync failed after ${n} tries`);
            }
            console.debug('Connecting: syncing bus: attempt', n);
            await badge.sync().then(v => protocolVersion = v).catch(() => {});

        } while (protocolVersion == undefined)

        console.timeEnd('Connecting: bus synchronized');
        console.debug(`Connecting: bus synchronized in ${n} attempts`);
        console.debug(`Protocol version: ${protocolVersion}`);

        if (protocolVersion < 2) {
            throw new Error("Protocol version not supported");
        }

        badge.connected = true;
        console.log('Connected to badge! 🎉');

        return badge;
    }

    get isConnected() {
        return this.connected;
    }

    assertConnected() {
        if (!this.connected)
        throw new Error("Assertion failed: badge not connected");
    }

    async disconnect(reset = true) {
        this.assertConnected();
        this.connected = false;
        try {
            this._stopListening();

            if (reset) {
                console.debug('Disconnecting: requesting device to reset...');
                await this.controlReset(false);
            } else {
                console.debug('Disconnecting: requesting device to exit WebUSB mode...');
                await this.controlSetMode(BadgeUSB.MODE_NORMAL);
            }

            console.debug('Disconnecting: resetting and releasing device USB interface...');
            await this.controlSetState(BadgeUSBState.CDC);
            await this.device.releaseInterface(this.interfaceIndex);
        } catch (error) {
            // Ignore errors
        }
        await this.device.close();
        console.log('Disconnecting: done');
        console.log('Session stats:', this.connectionStats);

        if (this._onDisconnect) this._onDisconnect();
    }

    set onConnectionLost(callback: () => void) {
        this._onConnectionLost = callback;
    }

    set onDisconnect(callback: () => void) {
        this._onDisconnect = callback;
    }

    get connectionStats() {
        return {
            rxPackets: this.rxPacketCount,
            txPackets: this.txPacketCount,
            timesOutOfSync: this.resyncCount,
            transactions: this.nextTransactionID,
            pendingTransactions: Object.keys(this.transactionPromises).length,
        };
    }

    get manufacturerName() {
        this.assertConnected();
        return this.device.manufacturerName;
    }

    get productName() {
        this.assertConnected();
        return this.device.productName;
    }

    get serialNumber() {
        this.assertConnected();
        return this.device.serialNumber;
    }

    async controlSetState(state: BadgeUSBState) {
        await this._controlTransferOut(
            BadgeUSB.REQUEST_STATE,
            state == BadgeUSBState.WebUSB ? BadgeUSBState.WebUSB : BadgeUSBState.CDC,
        );
    }

    async controlReset(bootloaderMode = false) {
        await this._controlTransferOut(BadgeUSB.REQUEST_RESET, bootloaderMode ? 0x01 : 0x00);
    }

    async controlSetBaudrate(baudrate: number) {
        await this._controlTransferOut(BadgeUSB.REQUEST_BAUDRATE, Math.floor(baudrate / 100));
    }

    async controlSetMode(mode: number) {
        await this._controlTransferOut(BadgeUSB.REQUEST_MODE, mode);
    }

    async controlGetMode() {
        let result = await this._controlTransferIn(BadgeUSB.REQUEST_MODE_GET, 1);
        return result.getUint8(0);
    }

    async controlGetFirmwareVersion() {
        let result = await this._controlTransferIn(BadgeUSB.REQUEST_FW_VERSION_GET, 1);
        return result.getUint8(0);
    }

    /**
     * @returns the protocol version number
     * @throws an error if sync fails
     **/
    async sync(): Promise<number | undefined> {
        this.dataBuffer = new ArrayBuffer(0);   // reset buffer

        let result = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_SYNC, new ArrayBuffer(0), 100)
        .catch(e => { if (e?.message != 'timeout') throw e });

        if (result === undefined) return;

        this.inSync = true;
        return new DataView(result).getUint16(0, true);
    }

    private resyncCount = 0;
    async syncIfNeeded(): Promise<void> {
        if (!this.inSync) this.resyncCount++;

        while (!this.inSync) {
            await this.sync().catch(() => {});
        }
    }

    async transaction(command: number, payload: ArrayBuffer | null, timeout = 0): Promise<ArrayBuffer> {
        let transaction = new TransactionPromise();
        let identifier = this.nextTransactionID;
        this.nextTransactionID = (this.nextTransactionID + 1) & 0xFFFFFFFF;
        this.transactionPromises[identifier] = transaction;

        if (timeout > 0) {
            transaction.timeout = setTimeout(() => {
                transaction.reject(new Error("timeout"));
                delete this.transactionPromises[identifier];
                this.inSync = false;
            }, timeout);
        }

        await this._sendPacket(identifier, command, payload);

        const response = await transaction;
        if (response.type !== command) {
            console.error("Badge reports error " + response.responseText);
            throw new Error("Error response " + response.responseText);
        }
        return response.payload.buffer;
    }


    private static _getInterface(device: USBDevice, index: number): USBInterface {
        if (!device.configuration) {
            throw new Error("no configuration selected on device");
        }
        return device.configuration.interfaces[index];
    }

    private static _findInterfaceIndex(device: USBDevice, firstInterfaceIndex = 0): number {
        const USB_CLASS_VENDOR = 0xFF;

        if (!device.configuration) {
            throw new Error("no configuration selected on device");
        }

        for (let i = firstInterfaceIndex; i < device.configuration.interfaces.length; i++) {
            if (BadgeUSB._getInterface(device, i)!.alternate.interfaceClass == USB_CLASS_VENDOR) {
                return i;
            }
        }
        throw new Error("no compatible interface on device");
    }

    private static _findEndpoints(device: USBDevice, interfaceIndex: number) {
        let endpoints = BadgeUSB._getInterface(device, interfaceIndex).alternate.endpoints;
        const endpointIn = endpoints.find(e => e.direction == 'in');
        const endpointOut = endpoints.find(e => e.direction == 'out');
        return { in: endpointIn!, out: endpointOut! }
    }

    private async _listen() {
        if (this.listening) return;
        this.listening = true;
        try {
            while (this.listening) {
                let result = await this._dataTransferIn();
                if (!this.listening) break; // FIXME redundant?
                await this._handleData(result.buffer);
            }
        } catch (error) {
            console.error('FATAL Error while listening for data:', error);
            console.warn('Connection lost. If this was not intentional, try reconnecting.');

            this.listening = false;
            if (this._onConnectionLost) this._onConnectionLost();
        }
    }

    private async _stopListening() {
        if (!this.listening) return;
        this.listening = false;
        await this._sendPacket(0, BadgeUSB.PROTOCOL_COMMAND_SYNC);
    }

    private async _controlTransferOut(request: number, value: number) {
        await this.device.controlTransferOut({
            requestType: 'class',
            recipient: 'interface',
            request: request,
            value: value,
            index: this.interfaceIndex
        });
    }

    private async _controlTransferIn(request: number, length = 1) {
        let result = await this.device.controlTransferIn({
            requestType: 'class',
            recipient: 'interface',
            request: request,
            value: 0,
            index: this.interfaceIndex
        }, length);

        if (!result.data) {
            throw new Error("Control request failed: no data received");
        }
        return result.data;
    }

    private async _dataTransferOut(data: BufferSource) {
        await this.device.transferOut(this.endpoints.out.endpointNumber, data);
    }

    private async _dataTransferIn(length = 64) {
        let result = await this.device.transferIn(this.endpoints.in.endpointNumber, length);//20 + 8192);
        if (!result.data) {
            throw new Error("Data request failed: no data received");
        }
        return result.data;
    }

    private txPacketCount = 0;
    private async _sendPacket(identifier: number, command: number, payload: ArrayBuffer | null = null) {
        if (payload === null) payload = new ArrayBuffer(0);

        let header = new ArrayBuffer(20);
        let dataView = new DataView(header);
        dataView.setUint32(0, BadgeUSB.PROTOCOL_MAGIC, true);
        dataView.setUint32(4, identifier, true);
        dataView.setUint32(8, command, true);
        dataView.setUint32(12, payload.byteLength, true);
        dataView.setUint32(16, payload.byteLength > 0 ? crc32FromArrayBuffer(payload) : 0, true);

        let packet = concatBuffers([header, payload]);
        await this._dataTransferOut(packet);

        this.txPacketCount++;
    }

    private async _handleData(buffer: ArrayBuffer) {
        this.dataBuffer = concatBuffers([this.dataBuffer, buffer]);

        while (this.dataBuffer.byteLength >= 20) {
            let dataView = new DataView(this.dataBuffer);
            let magic = dataView.getUint32(0, true);
            if (magic == BadgeUSB.PROTOCOL_MAGIC) {
                let payloadLength = dataView.getUint32(12, true);
                if (this.dataBuffer.byteLength >= 20 + payloadLength) {
                    await this._handlePacket(this.dataBuffer.slice(0, 20 + payloadLength));
                    this.dataBuffer = this.dataBuffer.slice(20 + payloadLength);
                } else {
                    return; // Wait for more data
                }
            } else {
                this.dataBuffer = this.dataBuffer.slice(1); // Shift buffer
            }
        }
    }

    private rxPacketCount = 0;
    private crcMismatchCount = 0;
    private async _handlePacket(buffer: ArrayBuffer) {
        let dataView = new DataView(buffer);
        let magic = dataView.getUint32(0, true);
        let identifier = dataView.getUint32(4, true);
        let responseType = dataView.getUint32(8, true);
        let payloadLength = dataView.getUint32(12, true);
        let payloadCRC = dataView.getUint32(16, true);

        let payload = new ArrayBuffer(0);
        if (payloadLength > 0) {
            payload = buffer.slice(20);
            if (crc32FromArrayBuffer(payload) !== payloadCRC) {
                console.debug('CRC mismatch; mismatches so far:', ++this.crcMismatchCount);

                if (identifier in this.transactionPromises) {
                    if (this.transactionPromises[identifier].timeout !== null) {
                        clearTimeout(this.transactionPromises[identifier].timeout);
                    }
                    this.transactionPromises[identifier].reject({
                        error: new Error("CRC"),

                        dataView, identifier, magic,
                        type: responseType,
                        payload: {
                            buffer: payload,
                            crc: payloadCRC,
                            declaredLength: payloadLength,
                        },
                        responseText: BadgeUSB.textDecoder.decode(new Uint8Array(buffer.slice(8,12))),
                    });
                    delete this.transactionPromises[identifier];
                } else {
                    console.error("Found no transaction for", identifier, responseType);
                }
                return;
            }
        }

        if (identifier in this.transactionPromises) {
            if (this.transactionPromises[identifier].timeout !== null) {
                clearTimeout(this.transactionPromises[identifier].timeout);
            }
            this.transactionPromises[identifier].resolve({
                dataView, identifier, magic,
                type: responseType,
                payload: {
                    buffer: payload,
                    crc: payloadCRC,
                    declaredLength: payloadLength,
                },
                responseText: BadgeUSB.textDecoder.decode(new Uint8Array(buffer.slice(8,12))),
            });
            delete this.transactionPromises[identifier];
            this.rxPacketCount++;
        } else {
            console.error("Found no transaction for", identifier, responseType);
        }
    }
}

export type TransactionArgs = Parameters<BadgeUSB['transaction']>;

class TransactionPromise extends Promise<TransactionResponse> {
    resolve: (value: TransactionResponse | PromiseLike<TransactionResponse>) => void;
    reject: (reason: TransactionResponse | Error) => void;

    timeout?: number;

    constructor(executor: ConstructorParameters<typeof Promise<TransactionResponse>>[0] = () => {}) {
        let resolver: (value: TransactionResponse | PromiseLike<TransactionResponse>) => void;
        let rejector: (reason: TransactionResponse | Error) => void;

        super((resolve, reject) => {
            resolver = resolve;
            rejector = reject;
            return executor(resolve, reject);   // Promise magic: this line is essential but idk why
        });

        this.resolve = resolver!;
        this.reject = rejector!;
    }
};

export type TransactionResponse = Readonly<{
    identifier: number,
    dataView: DataView,
    type: number,   // command
    magic: number,
    responseText: String,

    payload: Readonly<{
        crc: number,
        buffer: ArrayBuffer,
        declaredLength: number,
    }>,

    error?: Error,
}>;
