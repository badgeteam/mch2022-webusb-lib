/**
 * @author Nicolai Electronics
 * @author Reinier van der Leer
 */

import { concatBuffers, seekUint32, seekUint8 } from "./lib/buffers";
import { crc32FromArrayBuffer } from "./lib/crc32";
import Queue, { QToken } from "./lib/queue";
import DeferredPromise from "./lib/deferred-promise";
import FancyError from "fancy-error";

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
    static readonly PROTOCOL_COMMAND_SYNC                        = this._encodeCommand("SYNC");
    static readonly PROTOCOL_COMMAND_PING                        = this._encodeCommand("PING");
    static readonly PROTOCOL_COMMAND_FILESYSTEM_LIST             = this._encodeCommand("FSLS");
    static readonly PROTOCOL_COMMAND_FILESYSTEM_EXISTS           = this._encodeCommand("FSEX");
    static readonly PROTOCOL_COMMAND_FILESYSTEM_CREATE_DIRECTORY = this._encodeCommand("FSMD");
    static readonly PROTOCOL_COMMAND_FILESYSTEM_REMOVE           = this._encodeCommand("FSRM");
    static readonly PROTOCOL_COMMAND_FILESYSTEM_STATE            = this._encodeCommand("FSST");
    static readonly PROTOCOL_COMMAND_FILESYSTEM_FILE_WRITE       = this._encodeCommand("FSFW");
    static readonly PROTOCOL_COMMAND_FILESYSTEM_FILE_READ        = this._encodeCommand("FSFR");
    static readonly PROTOCOL_COMMAND_FILESYSTEM_FILE_CLOSE       = this._encodeCommand("FSFC");
    static readonly PROTOCOL_COMMAND_TRANSFER_CHUNK              = this._encodeCommand("CHNK");
    static readonly PROTOCOL_COMMAND_APP_LIST                    = this._encodeCommand("APPL");
    static readonly PROTOCOL_COMMAND_APP_READ                    = this._encodeCommand("APPR");
    static readonly PROTOCOL_COMMAND_APP_WRITE                   = this._encodeCommand("APPW");
    static readonly PROTOCOL_COMMAND_APP_REMOVE                  = this._encodeCommand("APPD");
    static readonly PROTOCOL_COMMAND_APP_RUN                     = this._encodeCommand("APPX");
    static readonly PROTOCOL_COMMAND_CONFIGURATION_LIST          = this._encodeCommand("NVSL");
    static readonly PROTOCOL_COMMAND_CONFIGURATION_READ          = this._encodeCommand("NVSR");
    static readonly PROTOCOL_COMMAND_CONFIGURATION_WRITE         = this._encodeCommand("NVSW");
    static readonly PROTOCOL_COMMAND_CONFIGURATION_REMOVE        = this._encodeCommand("NVSD");

    // Firmware error markers
    static readonly FIRMWARE_ERR_MAGIC_START = 0x1B5B303B;   // \x1B[0;
    static readonly FIRMWARE_ERR_MAGIC_END   = 0x1B5B306D;   // \x1B[0m

    public debug = {
        rx: false,
        tx: false,
    };
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
                throw new Error(`Sync failed after ${n - 1} tries`);
            }
            console.debug('Connecting: syncing bus: attempt', n);
            await badge.sync().then(v => protocolVersion = v).catch(() => {});

        } while (protocolVersion == undefined)

        console.timeEnd('Connecting: bus synchronized');
        console.debug(`Connecting: bus synchronized in ${n} attempts`);
        console.debug('Protocol version:', protocolVersion);

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

    private _onConnectionLost?: (err?: Error) => void;
    private _onDisconnect?: () => void;

    set onConnectionLost(callback: (err?: Error) => void) {
        this._onConnectionLost = callback;
    }

    set onDisconnect(callback: () => void) {
        this._onDisconnect = callback;
    }

    get connectionStats() {
        return {
            txPackets: this.txPacketCount,
            rxPackets: this.rxPacketCount,
            crcErrors: this.crcMismatchCount,
            transactions: this.nextTransactionID,
            timesOutOfSync: this.resyncCount,
            queuedTransactions: this.queuedTransactionCount,
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

    controlSetState(state: BadgeUSBState) {
        return this._controlTransferOut(
            BadgeUSB.REQUEST_STATE,
            state == BadgeUSBState.WebUSB ? BadgeUSBState.WebUSB : BadgeUSBState.CDC,
        );
    }

    controlReset(bootloaderMode = false) {
        return this._controlTransferOut(BadgeUSB.REQUEST_RESET, bootloaderMode ? 0x01 : 0x00);
    }

    controlSetBaudrate(baudrate: number) {
        return this._controlTransferOut(BadgeUSB.REQUEST_BAUDRATE, Math.floor(baudrate / 100));
    }

    controlSetMode(mode: number) {
        return this._controlTransferOut(BadgeUSB.REQUEST_MODE, mode);
    }

    async controlGetMode() {
        let result = await this._controlTransferIn(BadgeUSB.REQUEST_MODE_GET, 1);
        return result.getUint8(0);
    }

    async controlGetFirmwareVersion() {
        let result = await this._controlTransferIn(BadgeUSB.REQUEST_FW_VERSION_GET, 1);
        return result.getUint8(0);
    }

    private inSync = false;
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

    /** Can be used in multi-transaction functions to block other transactions */
    public transactionQueue = new Queue();

    private nextTransactionID: number = 0;
    private transactions: TransactionPromise[] = [];

    async transaction(
        command: number,
        payload: ArrayBuffer | null,
        timeout = 0,
        queueToken?: QToken
    ): Promise<ArrayBuffer> {
        const transaction = new TransactionPromise();
        const commandCode = BadgeUSB._decodeCommand(command);
        const transactionID = this.nextTransactionID;
        this.nextTransactionID = (this.nextTransactionID + 1) & 0xFFFFFFFF;

        console.debug(`queueing transaction`, transactionID, `(${commandCode})`);
        let token = await this.transactionQueue.waitTurn({
            token: queueToken,
            turnTimeout: timeout > 0 ? timeout + 500 : undefined,
        });

        this.transactions[transactionID] = transaction;
        console.debug(
            'starting transaction', transactionID, `(${commandCode});`,
            'queue length:', this.transactionQueue.length,
        );

        if (timeout > 0) {
            const error = new TimeoutError(
                `${commandCode} with ID ${transactionID} timed out after ${timeout} ms`
            );
            transaction.timeout = setTimeout(() => {
                try {
                    transaction.reject(error);
                } catch (error) {
                    if (!(error instanceof TimeoutError)) throw error;
                }
                if (payload) console.debug(
                    `payload for failed ${commandCode}:`,
                    payload, BadgeUSB.textDecoder.decode(payload)
                );

                delete this.transactions[transactionID];
                this.inSync = false;
            }, timeout);
        }

        await this._sendPacket(transactionID, command, payload);

        let response: TransactionResponse;
        try {
            response = await transaction;
        } catch (error) {
            if (error instanceof TimeoutError) throw error;
            throw new RXError(
                `Transaction ${transactionID} (${commandCode}) failed`,
                error, undefined, false
            );
        } finally {
            if (queueToken == undefined) this.transactionQueue.release(token);
        }
        console.debug('finshed transaction', transactionID, `(${commandCode})`);

        if (response.type !== command) {
            let error = new BadgeUSBError(response.typeCode);
            console.warn(error);
            throw error;
        }
        return response.payload.buffer;
    }

    get queuedTransactionCount(): number {
        return this.transactionQueue.length;
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
                this._handleData(result.buffer);
            }
        } catch (error) {
            console.error('FATAL Error while listening for data:', error);
            console.warn('Connection lost. If this was not intentional, try reconnecting.');

            this.listening = false;
            if (this._onConnectionLost) this._onConnectionLost(error);
        }
    }

    private async _stopListening() {
        if (!this.listening) return;
        this.listening = false;
        await this._sendPacket(0, BadgeUSB.PROTOCOL_COMMAND_SYNC);
    }

    private _controlTransferOut(request: number, value: number): Promise<USBOutTransferResult> {
        return this.device.controlTransferOut({
            requestType: 'class',
            recipient: 'interface',
            request: request,
            value: value,
            index: this.interfaceIndex
        });
    }

    private async _controlTransferIn(request: number, length = 1): Promise<DataView> {
        let result = await this.device.controlTransferIn({
            requestType: 'class',
            recipient: 'interface',
            request: request,
            value: 0,
            index: this.interfaceIndex
        }, length);

        if (!result.data) {
            throw new RXError("Control request failed: no data received");
        }
        return result.data;
    }

    private _dataTransferOut(data: BufferSource): Promise<USBOutTransferResult> {
        return this.device.transferOut(this.endpoints.out.endpointNumber, data);
    }

    private async _dataTransferIn(length = 64): Promise<DataView> {
        let result = await this.device.transferIn(this.endpoints.in.endpointNumber, length);
        if (!result.data) {
            throw new RXError("Data transfer failed: no data received");
        }
        return result.data;
    }

    private txPacketCount = 0;
    private async _sendPacket(id: number, command: number, payload: ArrayBuffer | null = null) {
        payload ??= new ArrayBuffer(0);

        let header = new ArrayBuffer(20);
        let dataView = new DataView(header);
        dataView.setUint32(0, BadgeUSB.PROTOCOL_MAGIC, true);
        dataView.setUint32(4, id, true);
        dataView.setUint32(8, command, true);
        dataView.setUint32(12, payload.byteLength, true);
        dataView.setUint32(16, payload.byteLength > 0 ? crc32FromArrayBuffer(payload) : 0, true);

        if (this.debug.tx) console.debug(`TX packet ${id}:`, { header, payload });
        let packet = concatBuffers(header, payload);
        let result = await this._dataTransferOut(packet);
        if (this.debug.tx) console.debug(`TX packet ${id} transfer result:`, result);

        this.txPacketCount++;
    }

    private dataBuffer = new ArrayBuffer(0);
    private async _handleData(buffer: ArrayBuffer) {
        if (this.debug.rx) console.debug('RX data:', buffer);
        this.dataBuffer = concatBuffers(this.dataBuffer, buffer);
        if (this.debug.rx) console.debug('RX buffer:', this.dataBuffer.slice(0));

        while (this.dataBuffer.byteLength >= 20) {
            let dataView = new DataView(this.dataBuffer);

            let magic = dataView.getUint32(0, true);
            if (magic == BadgeUSB.PROTOCOL_MAGIC) {
                let payloadLength = dataView.getUint32(12, true);

                if (this.dataBuffer.byteLength >= 20 + payloadLength) {
                    this._handlePacket(this.dataBuffer.slice(0, 20 + payloadLength));
                    this.dataBuffer = this.dataBuffer.slice(20 + payloadLength);
                } else {
                    return; // Wait for more data
                }

            } else if (dataView.getUint32(0, false) == BadgeUSB.FIRMWARE_ERR_MAGIC_START) {
                // example: \x1B[0;31mE (158018) vfs_fat: open: no free file descriptors\x1B[0m\r\n\r
                let startPos = seekUint8(dataView, 0x20) + 1;   // find space = start of message
                let endPos = seekUint32(dataView, BadgeUSB.FIRMWARE_ERR_MAGIC_END, false);

                if (endPos == -1) {
                    if (this.debug.rx) console.debug(
                        'RX: received partial firmware error:',
                        BadgeUSB.textDecoder.decode(this.dataBuffer.slice(startPos)),
                    );
                    return; // wait for end of error / more data
                }
                console.warn(
                    'RX: received firmware error:',
                    BadgeUSB.textDecoder.decode(this.dataBuffer.slice(startPos, endPos)),
                );
                this.dataBuffer = this.dataBuffer.slice(endPos + 4);

            } else {
                let magicPos = seekUint32(dataView, BadgeUSB.PROTOCOL_MAGIC);
                if (magicPos == -1) return; // wait for more data

                const errMessage = BadgeUSB.textDecoder.decode(this.dataBuffer.slice(0, magicPos));
                this.dataBuffer = this.dataBuffer.slice(magicPos);
                if (this.inSync && errMessage.trim().length > 0)    // ignore noise & whitespace
                    console.warn(`RX: unexpected non-magic data: '${errMessage}'`);
            }
        }
    }

    private rxPacketCount = 0;
    private crcMismatchCount = 0;
    private async _handlePacket(buffer: ArrayBuffer) {
        let dataView = new DataView(buffer);
        let magic            = dataView.getUint32(0, true);
        let id               = dataView.getUint32(4, true);
        let responseType     = dataView.getUint32(8, true);
        let responseTypeCode = BadgeUSB._decodeCommand(responseType);
        let payloadLength    = dataView.getUint32(12, true);
        let payloadCRC       = dataView.getUint32(16, true);
        if (this.debug.rx) console.debug('RX packet', id, 'header:', {
            id, type: responseTypeCode,
            payloadLength, payloadCRC,
            magic: magic.toString(0x10),
            buffer: buffer.slice(0, 20),
        });

        let payload = new ArrayBuffer(0);
        if (payloadLength > 0) {
            payload = buffer.slice(20);
            if (this.debug.rx) console.debug('RX packet', id, 'payload:', payload.slice(0));

            if (crc32FromArrayBuffer(payload) !== payloadCRC) {
                console.debug('RX CRC mismatch; mismatches so far:', ++this.crcMismatchCount);

                if (id in this.transactions) {
                    const transaction = this.transactions[id];

                    if (transaction !== null) {
                        clearTimeout(transaction.timeout);
                    }
                    try {
                        transaction.reject({
                            error: transaction.amendError(new RXError("CRC verification of RX packet failed")),

                            id, dataView, magic,
                            type:     responseType,
                            typeCode: responseTypeCode,
                            payload: {
                                buffer: payload,
                                crc: payloadCRC,
                                declaredLength: payloadLength,
                            },
                        });
                    } catch (error) {
                        if (!(error instanceof RXError)) throw error;
                    }
                    delete this.transactions[id];
                } else {
                    console.error("Found no transaction for", id, responseTypeCode);
                }
                return;
            }
        }

        if (id in this.transactions) {
            clearTimeout(this.transactions[id].timeout);
            this.transactions[id].resolve({
                id, dataView, magic,
                type:     responseType,
                typeCode: responseTypeCode,
                payload: {
                    buffer: payload,
                    crc: payloadCRC,
                    declaredLength: payloadLength,
                },
            });
            delete this.transactions[id];
            this.rxPacketCount++;
        } else {
            console.error("Found no transaction for", id, responseType);
        }
    }

    private static _decodeCommand(cmd: number): string {
        const dataView = new DataView(new ArrayBuffer(4));
        dataView.setUint32(0, cmd, true);
        return this.textDecoder.decode(dataView.buffer);
    }

    private static _encodeCommand(cmd: string): number {
        return new DataView(this.textEncoder.encode(cmd).buffer)
        .getUint32(0, true);
    }
}

export type TransactionArgs = Parameters<BadgeUSB['transaction']>;

export type TransactionResponse = Readonly<{
    id: number,
    dataView: DataView,
    magic: number,
    type: number,   // command or error code
    typeCode: string,

    payload: Readonly<{
        crc: number,
        buffer: ArrayBuffer,
        declaredLength: number,
    }>,

    error?: Error,
}>;

class TransactionPromise extends DeferredPromise<TransactionResponse> {
    timeout?: number;
};

export class BadgeUSBError extends FancyError {
    static readonly codeMap: { [c: string]: string } = {
        'ERR1': "Declared payload length of received packet exceeds max payload size",
        'ERR2': "CRC verification of received payload failed",
        'ERR3': "Unknown command",
        'ERR4': "Out of memory",
        'ERR5': "No such file or directory",
        'ERR6': "No file open",
        'ERR7': "Data sent while reading",
        'ERR8': "Cannot allocate app",
        'ERR9': "Payload length out of bounds",
        'ERRA': "Text parameter 1 out of bounds",
        'ERRB': "Text parameter 2 out of bounds",
        'ERRC': "Response length exceeds max payload size",
    };

    readonly code: string;

    constructor(errorCode: string) {
        super("Badge returned error: " + (BadgeUSBError.codeMap[errorCode] ?? `${errorCode} (unknown error code)`));
        this.code = errorCode;
    }
}

class RXError extends FancyError {}
class TimeoutError extends FancyError {}
