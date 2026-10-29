import Foundation
import Network

/// Binds the bundled, production web app to an ephemeral loopback-only HTTP port.
/// The listener never binds to a LAN interface and only serves files inside ZunoWeb.
final class ZunoLocalWebServer: ObservableObject {
    @Published private(set) var entryURL: URL?
    @Published private(set) var errorMessage: String?

    private let queue = DispatchQueue(label: "com.zuno.local-web-server")
    private var listener: NWListener?
    private var rootURL: URL?
    private var started = false

    func start() {
        guard !started else { return }
        started = true
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("ZunoWeb", isDirectory: true),
              FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path) else {
            DispatchQueue.main.async { self.errorMessage = "The ZUNO web bundle is missing. Rebuild the iOS app with the web assets step enabled." }
            return
        }
        rootURL = root.standardizedFileURL
        do {
            let parameters = NWParameters.tcp
            parameters.allowLocalEndpointReuse = true
            parameters.requiredLocalEndpoint = .hostPort(
                host: .ipv4(IPv4Address("127.0.0.1")!),
                port: .any
            )
            let listener = try NWListener(using: parameters)
            self.listener = listener
            listener.newConnectionHandler = { [weak self] connection in
                guard let self else { connection.cancel(); return }
                connection.start(queue: self.queue)
                self.receive(connection, accumulated: Data())
            }
            listener.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    guard let port = listener.port?.rawValue else {
                        DispatchQueue.main.async { self.errorMessage = "ZUNO local web server did not allocate a port." }
                        return
                    }
                    DispatchQueue.main.async {
                        self.entryURL = URL(string: "http://127.0.0.1:\(port)/index.html")
                        self.errorMessage = nil
                    }
                case .failed(let error):
                    DispatchQueue.main.async { self.errorMessage = "ZUNO local web server failed: \(error.localizedDescription)" }
                default:
                    break
                }
            }
            listener.start(queue: queue)
        } catch {
            DispatchQueue.main.async { self.errorMessage = "Could not start the bundled ZUNO web app: \(error.localizedDescription)" }
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
        started = false
        DispatchQueue.main.async { self.entryURL = nil }
    }

    private func receive(_ connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, complete, error in
            guard let self else { connection.cancel(); return }
            var buffer = accumulated
            if let data, !data.isEmpty { buffer.append(data) }
            if buffer.count > 32 * 1024 {
                self.respond(connection, status: 431, body: Data("Request headers too large".utf8), contentType: "text/plain; charset=utf-8", headOnly: false)
                return
            }
            let separator = Data("\r\n\r\n".utf8)
            if let range = buffer.range(of: separator) {
                let headerData = buffer.subdata(in: 0..<range.lowerBound)
                let headerText = String(decoding: headerData, as: UTF8.self)
                self.handle(connection, requestHeaders: headerText)
                return
            }
            if error != nil || complete {
                connection.cancel()
                return
            }
            self.receive(connection, accumulated: buffer)
        }
    }

    private func handle(_ connection: NWConnection, requestHeaders: String) {
        guard let requestLine = requestHeaders.components(separatedBy: "\r\n").first else {
            respond(connection, status: 400, body: Data("Bad Request".utf8), contentType: "text/plain; charset=utf-8", headOnly: false)
            return
        }
        let tokens = requestLine.split(separator: " ", omittingEmptySubsequences: true)
        guard tokens.count >= 2 else {
            respond(connection, status: 400, body: Data("Bad Request".utf8), contentType: "text/plain; charset=utf-8", headOnly: false)
            return
        }
        let method = String(tokens[0]).uppercased()
        guard method == "GET" || method == "HEAD" else {
            respond(connection, status: 405, body: Data("Method Not Allowed".utf8), contentType: "text/plain; charset=utf-8", headOnly: false)
            return
        }
        let target = String(tokens[1])
        guard let components = URLComponents(string: "http://127.0.0.1" + target) else {
            respond(connection, status: 400, body: Data("Bad Request".utf8), contentType: "text/plain; charset=utf-8", headOnly: method == "HEAD")
            return
        }
        let decodedPath = (components.path.removingPercentEncoding ?? components.path)
        let relativePath = decodedPath == "/" ? "index.html" : String(decodedPath.dropFirst())
        if relativePath.isEmpty || relativePath.split(separator: "/").contains("..") || relativePath.contains("\\") {
            respond(connection, status: 403, body: Data("Forbidden".utf8), contentType: "text/plain; charset=utf-8", headOnly: method == "HEAD")
            return
        }
        guard let root = rootURL else {
            respond(connection, status: 503, body: Data("Unavailable".utf8), contentType: "text/plain; charset=utf-8", headOnly: method == "HEAD")
            return
        }
        let fileURL = root.appendingPathComponent(relativePath).standardizedFileURL
        guard fileURL.path.hasPrefix(root.path + "/"),
              let values = try? fileURL.resourceValues(forKeys: [.isRegularFileKey]),
              values.isRegularFile == true,
              let body = try? Data(contentsOf: fileURL, options: [.mappedIfSafe]) else {
            respond(connection, status: 404, body: Data("Not Found".utf8), contentType: "text/plain; charset=utf-8", headOnly: method == "HEAD")
            return
        }
        respond(connection, status: 200, body: body, contentType: mimeType(for: fileURL.pathExtension), headOnly: method == "HEAD")
    }

    private func mimeType(for extensionName: String) -> String {
        switch extensionName.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp": return "image/webp"
        case "avif": return "image/avif"
        case "gif": return "image/gif"
        case "mp4": return "video/mp4"
        case "webm": return "video/webm"
        case "mp3": return "audio/mpeg"
        case "m4a": return "audio/mp4"
        case "wav": return "audio/wav"
        case "ogg", "opus": return "audio/ogg"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "wasm": return "application/wasm"
        case "ico": return "image/x-icon"
        default: return "application/octet-stream"
        }
    }

    private func respond(_ connection: NWConnection, status: Int, body: Data, contentType: String, headOnly: Bool) {
        let reason: String
        switch status {
        case 200: reason = "OK"
        case 400: reason = "Bad Request"
        case 403: reason = "Forbidden"
        case 404: reason = "Not Found"
        case 405: reason = "Method Not Allowed"
        case 431: reason = "Request Header Fields Too Large"
        default: reason = "Service Unavailable"
        }
        let headers = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: \(contentType)\r\nContent-Length: \(body.count)\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n\r\n"
        var response = Data(headers.utf8)
        if !headOnly { response.append(body) }
        connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
    }
}
