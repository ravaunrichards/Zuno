import SwiftUI
import WebKit

struct ContentView: View {
    @StateObject private var localServer = ZunoLocalWebServer()

    var body: some View {
        Group {
            if let entryURL = localServer.entryURL {
                ZunoWebContainer(entryURL: entryURL)
                    .ignoresSafeArea(.container, edges: .bottom)
            } else if let errorMessage = localServer.errorMessage {
                ContentUnavailableView(
                    "ZUNO could not start",
                    systemImage: "exclamationmark.triangle",
                    description: Text(errorMessage)
                )
                .padding(24)
            } else {
                VStack(spacing: 18) {
                    Image(systemName: "sparkles").font(.system(size: 42)).foregroundStyle(.purple)
                    Text("ZUNO").font(.largeTitle.bold())
                    ProgressView("Preparing your secure app…")
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(red: 0.05, green: 0.05, blue: 0.09))
                .foregroundStyle(.white)
            }
        }
        .task { localServer.start() }
        .onDisappear { localServer.stop() }
        .preferredColorScheme(.dark)
    }
}

private struct ZunoWebContainer: UIViewRepresentable {
    let entryURL: URL

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.backgroundColor = UIColor(red: 0.05, green: 0.05, blue: 0.09, alpha: 1)
        web.isOpaque = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.load(URLRequest(url: entryURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        guard uiView.url?.host != entryURL.host || uiView.url?.port != entryURL.port else { return }
        uiView.load(URLRequest(url: entryURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            if url.scheme == "http", url.host == "127.0.0.1" {
                decisionHandler(.allow)
                return
            }
            if url.scheme == "https", let host = url.host?.lowercased(),
               host == "paypal.com" || host.hasSuffix(".paypal.com") {
                decisionHandler(.allow)
                return
            }
            if url.scheme == "https" {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
        }

        @available(iOS 15.0, *)
        func webView(_ webView: WKWebView,
                     requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo,
                     type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            guard origin.protocol == "http", origin.host == "127.0.0.1" else {
                decisionHandler(.deny)
                return
            }
            decisionHandler(.prompt)
        }
    }
}
