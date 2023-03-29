# MCH2022 WebUSB API library

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
