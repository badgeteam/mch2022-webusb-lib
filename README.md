# MCH2022 WebUSB API library
![latest NPM release](https://img.shields.io/npm/v/@badge.team/badge-webusb?style=flat-square)
![bundle size](https://img.shields.io/bundlephobia/min/@badge.team/badge-webusb?style=flat-square)
![license](https://img.shields.io/github/license/badgeteam/mch2022-webusb-lib?style=flat-square)

This library allows easy WebUSB communication with the MCH2022 badge, and possibly
more badges in the future.

## Endpoints
```TS
interface BadgeAPI {
    connect()
    disconnect(reset)
    syncConnection()
    assertConnected()

    hasConnectedBadge

    transaction(cmd, payload, timeout)

    fileSystem: {
        state()
        list(path)
        mkdir(path)
        exists(path)
        delete(path)
        readFile(path)
        writeFile(path, bin)
        closeFile()
    }

    appFS: {
        list()
        run(name)
        read(name)
        write(name, title, version, bin)
        delete(name)
    }

    nvs: {
        list(ns)
        read(ns, key, type)
        write(ns, key, type, value)
        delete(ns, key)
    }
}
```
TODO: auto generated docs :)

## Credits
* Renze Nicolai (@renzenicolai): WebUSB implementation (firmware + JS client)
* Reinier van der Leer (@Pwuts): TypeScript conversion & documentation

## References
* [WebUSB implementation] in the MCH2022 badge firmware
* [MDN WebUSB API spec](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API)

[WebUSB implementation]: https://github.com/badgeteam/mch2022-firmware-esp32/blob/master/main/webusb.c
