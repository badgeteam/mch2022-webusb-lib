import { assertNumber, assertBigint, assertString, assertInstanceOf } from "../lib/assert-type";
import { concatBuffers } from "../lib/buffers";
import { BadgeUSB } from "../badge-usb";

export enum NVSType {
    Uint8  = 0x01,
    Int8   = 0x11,
    Uint16 = 0x02,
    Int16  = 0x12,
    Uint32 = 0x04,
    Int32  = 0x14,
    Uint64 = 0x08,
    Int64  = 0x18,
    String = 0x21,
    Blob   = 0x42,
}

export type NVSNumberType = NVSType.Int8 | NVSType.Int16 | NVSType.Int32 | NVSType.Uint8 | NVSType.Uint16 | NVSType.Uint32;
export type NVSBigintType = NVSType.Int64 | NVSType.Uint64;

export class BadgeNVSApi {
    constructor(
        private transaction: BadgeUSB['transaction'],
    ) {}

    textEncoder = new TextEncoder();
    textDecoder = new TextDecoder();

    /**
     * Lists the settings in the given `namespace`
     * @param namespace default: `''` (root namespace)
     */
    async list(namespace = '') {
        assertString('namespace', namespace);
        const namespaceEncoded = this.textEncoder.encode(namespace);

        let data = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_CONFIGURATION_LIST, namespaceEncoded, 4000);
        let result = [];
        while (data.byteLength > 0) {
            let dataView = new DataView(data);
            let namespaceLength = dataView.getUint16(0, true);
            let namespace       = this.textDecoder.decode(data.slice(2, 2 + namespaceLength));
            data = data.slice(2 + namespaceLength);

            dataView = new DataView(data);
            let keyLength = dataView.getUint16(0, true);
            let key       = this.textDecoder.decode(data.slice(2, 2 + keyLength));
            data = data.slice(2 + keyLength);

            dataView = new DataView(data);
            let type = dataView.getUint8(0);
            let size = dataView.getUint32(0, true);
            data = data.slice(5);

            result.push({ namespace, key, type, size });
        }
        return result;
    }

    /**
     * Retrieves an entry from NVS
     * @returns the stored value, or `null` if the entry does not exist
     */
    async read(namespace: string, key: string, type: NVSType.String): Promise<string | null>
    async read(namespace: string, key: string, type: NVSNumberType):  Promise<number | null>
    async read(namespace: string, key: string, type: NVSBigintType):  Promise<bigint | null>
    async read(namespace: string, key: string, type: NVSType.Blob):   Promise<ArrayBuffer | null>
    async read(namespace: string, key: string, type: NVSType):        Promise<string | number | bigint | ArrayBuffer | null>

    async read(namespace: string, key: string, type: NVSType): Promise<string | number | bigint | ArrayBuffer | null> {
        if (typeof type === "string") type = nvsTypeStringToNumber(type);

        assertString('namespace', namespace, 1, 16);
        assertString('key', key, 1, 16);
        assertNumber('type', type);

        let request = new Uint8Array(3 + namespace.length + key.length);
        request.set([namespace.length], 0);
        request.set(this.textEncoder.encode(namespace), 1);
        request.set([key.length], 1 + namespace.length);
        request.set(this.textEncoder.encode(key), 2 + namespace.length);
        request.set([type], 2 + namespace.length + key.length);

        let result = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_CONFIGURATION_READ, request.buffer, 4000);
        return this.decodeNVSData(type, result);
    }

    /** @returns whether writing the entry to NVS succeeded */
    async write(namespace: string, key: string, type: NVSType.String, value: string):      Promise<boolean>
    async write(namespace: string, key: string, type: NVSNumberType,  value: number):      Promise<boolean>
    async write(namespace: string, key: string, type: NVSBigintType,  value: bigint):      Promise<boolean>
    async write(namespace: string, key: string, type: NVSType.Blob,   value: ArrayBuffer): Promise<boolean>
    async write(namespace: string, key: string, type: NVSType, value: string | number | bigint | ArrayBuffer): Promise<boolean>

    async write(namespace: string, key: string, type: NVSType, value: string | number | bigint | ArrayBuffer): Promise<boolean> {
        if (typeof type === "string") type = nvsTypeStringToNumber(type);

        assertString('namespace', namespace, 1, 16);
        assertString('key', key, 1, 16);
        assertNumber('type', type);

        let header = new Uint8Array(3 + namespace.length + key.length);
        header.set([namespace.length],                  0);
        header.set(this.textEncoder.encode(namespace),  1);
        header.set([key.length],                        1 + namespace.length);
        header.set(this.textEncoder.encode(key),        2 + namespace.length);
        header.set([type],                              2 + namespace.length + key.length);
        const request = concatBuffers(header.buffer, this.encodeNVSData(type, value));

        let result = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_CONFIGURATION_WRITE, request, 4000);
        return (new DataView(result).getUint8(0) == 1);
    }

    /** @returns whether deleting the entry succeeded */
    async delete(namespace: string, key: string): Promise<boolean> {
        assertString('key', key, 1, 16);
        assertString('namespace', namespace, 1, 16);

        let request = new Uint8Array(2 + namespace.length + key.length);
        request.set([namespace.length],                 0);
        request.set(this.textEncoder.encode(namespace), 1);
        request.set([key.length],                       1 + namespace.length);
        request.set(this.textEncoder.encode(key),       2 + namespace.length);

        const result = await this.transaction(BadgeUSB.PROTOCOL_COMMAND_CONFIGURATION_REMOVE, request.buffer, 4000);
        return (new DataView(result).getUint8(0) == 1);
    }

    private decodeNVSData(type: NVSType.String, data: ArrayBuffer): string | null
    private decodeNVSData(type: NVSNumberType,  data: ArrayBuffer): number | null
    private decodeNVSData(type: NVSBigintType,  data: ArrayBuffer): bigint | null
    private decodeNVSData(type: NVSType.Blob,   data: ArrayBuffer): ArrayBuffer | null
    private decodeNVSData(type: NVSType, data: ArrayBuffer): string | number | bigint | ArrayBuffer

    private decodeNVSData(type: NVSType, data: ArrayBuffer): string | number | bigint | ArrayBuffer | null {
        if (data.byteLength == 0) return null;

        let dataView = new DataView(data);
        if (type == 0x01) return dataView.getUint8(0);
        if (type == 0x11) return dataView.getInt8(0);
        if (type == 0x02) return dataView.getUint16(0, true);
        if (type == 0x12) return dataView.getInt16(0, true);
        if (type == 0x04) return dataView.getUint32(0, true);
        if (type == 0x14) return dataView.getInt32(0, true);
        if (type == 0x08) return dataView.getBigUint64(0, true);
        if (type == 0x18) return dataView.getBigInt64(0, true);
        if (type == 0x21) return this.textDecoder.decode(data);
        if (type == 0x42) return data;
        throw new Error("Invalid configuration type");
    }

    private encodeNVSData(type: NVSType.String, data: string):      ArrayBuffer
    private encodeNVSData(type: NVSNumberType,  data: number):      ArrayBuffer
    private encodeNVSData(type: NVSBigintType,  data: bigint):      ArrayBuffer
    private encodeNVSData(type: NVSType.Blob,   data: ArrayBuffer): ArrayBuffer
    private encodeNVSData(type: NVSType, data: string | number | bigint | ArrayBuffer): ArrayBuffer

    private encodeNVSData(type: NVSType, data: string | number | bigint | ArrayBuffer): ArrayBuffer {
        function _assertNumber(_data: typeof data): asserts _data is number {
            assertNumber(`Setting 0x${type.toString(0x10)}`, data);
        }
        function _assertString(_data: typeof data): asserts _data is string {
            assertString(`Setting 0x${type.toString(0x10)}`, data);
        }
        function _assertBigint(_data: typeof data): asserts _data is bigint {
            assertBigint(`Setting 0x${type.toString(0x10)}`, data);
        }
        function _assertBuffer(_data: typeof data): asserts _data is ArrayBuffer {
            assertInstanceOf(ArrayBuffer, `Setting 0x${type.toString(0x10)}`, data);
        }

        let buffer: ArrayBuffer;
        let dataView: DataView;
        switch (type) {
        case NVSType.Uint8:
            _assertNumber(data);
            buffer = new ArrayBuffer(1);
            dataView = new DataView(buffer);
            dataView.setUint8(0, data);
            return buffer;

        case NVSType.Int8:
            _assertNumber(data);
            buffer = new ArrayBuffer(1);
            dataView = new DataView(buffer);
            dataView.setInt8(0, data);
            return buffer;

        case NVSType.Uint16:
            _assertNumber(data);
            buffer = new ArrayBuffer(2);
            dataView = new DataView(buffer);
            dataView.setUint16(0, data, true);
            return buffer;

        case NVSType.Int16:
            _assertNumber(data);
            buffer = new ArrayBuffer(2);
            dataView = new DataView(buffer);
            dataView.setInt16(0, data, true);
            return buffer;

        case NVSType.Uint32:
            _assertNumber(data);
            buffer = new ArrayBuffer(4);
            dataView = new DataView(buffer);
            dataView.setUint32(0, data, true);
            return buffer;

        case NVSType.Int32:
            _assertNumber(data);
            buffer = new ArrayBuffer(4);
            dataView = new DataView(buffer);
            dataView.setInt32(0, data, true);
            return buffer;

        case NVSType.Uint64:
            _assertBigint(data);
            buffer = new ArrayBuffer(8);
            dataView = new DataView(buffer);
            dataView.setBigUint64(0, data, true);
            return buffer;

        case NVSType.Int64:
            _assertBigint(data);
            buffer = new ArrayBuffer(8);
            dataView = new DataView(buffer);
            dataView.setBigInt64(0, data, true);
            return buffer;

        case NVSType.String:
            _assertString(data);
            return this.textEncoder.encode(data);

        case NVSType.Blob:
            _assertBuffer(data);
            return data;

        default:
            throw new Error("Invalid configuration type");
        }
    }
}

export function nvsTypeStringToNumber(type: string): NVSType {
    switch(type) {
        case "u8":     return NVSType.Uint8;
        case "i8":     return NVSType.Int8;
        case "u16":    return NVSType.Uint16;
        case "i16":    return NVSType.Int16;
        case "u32":    return NVSType.Uint32;
        case "i32":    return NVSType.Int32;
        case "u64":    return NVSType.Uint64;
        case "i64":    return NVSType.Int64;
        case "string": return NVSType.String;
        case "blob":   return NVSType.Blob;
        default: throw new Error("Invalid configuration type");
    }
}

export function nvsTypeToString(type: NVSType) {
    switch(type) {
        case NVSType.Uint8:  return "u8";
        case NVSType.Int8:   return "i8";
        case NVSType.Uint16: return "u16";
        case NVSType.Int16:  return "i16";
        case NVSType.Uint32: return "u32";
        case NVSType.Int32:  return "i32";
        case NVSType.Uint64: return "64";
        case NVSType.Int64:  return "i64";
        case NVSType.String: return "string";
        case NVSType.Blob:   return "blob";
        default: throw new Error("Invalid configuration type");
    }
}
