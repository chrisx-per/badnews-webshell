import UIKit
import WebKit

/// bad.news 的 WKWebView 壳。
///
/// 相比纯壳版本，这里多了两条：
///   1. 注入 hs-player.user.js —— 把站点自绘的细条进度条换成可用的大触控面板
///   2. 拔掉站点自带的"画中画返回键"之外的东西不做，保持最小侵入
///
/// 注入时机：.atDocumentEnd —— 站点是 Flutter Web，video 元素是 canvas 之外
/// 由插件异步插进来的，所以脚本内部还要自己 MutationObserver + 定时扫描。
final class ViewController: UIViewController {

    private static let startURL = URL(string: "https://ios-app.bad.news/")!

    /// 允许留在 WebView 内的主机（含子域）。
    private static let inScopeHosts: Set<String> = ["bad.news", "lvv2.com", "jsdelivr.net"]

    private var webView: WKWebView!

    // MARK: - 生命周期

    override func viewDidLoad() {
        super.viewDidLoad()

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.websiteDataStore = .default()          // localStorage：token + 播放进度
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.allowsPictureInPictureMediaPlayback = true

        installPlayerEnhancer(into: config)

        webView = WKWebView(frame: .zero, configuration: config)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = .black

        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        webView.load(URLRequest(url: Self.startURL))
    }

    // MARK: - 播放器增强注入

    private func installPlayerEnhancer(into config: WKWebViewConfiguration) {
        guard let url = Bundle.main.url(forResource: "hs-player", withExtension: "user.js"),
              let source = try? String(contentsOf: url, encoding: .utf8) else {
            NSLog("[hanshuang] hs-player.user.js 未打包进 bundle，跳过注入")
            return
        }

        // 只在受控域上注入，站外页面不碰
        let script = WKUserScript(
            source: source,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(script)

        // 站点切 hash 路由时不会重新加载页面，atDocumentEnd 只跑一次。
        // 这里补一个 SPI 回调，保证每次 SPA 路由切换后脚本仍然有效。
        let rearm = """
        (function(){
          if (window.__hsPlayerArmed) return;
          window.__hsPlayerArmed = true;
          window.addEventListener('hashchange', function(){
            if (window.__hsPlayerRearm) { try { window.__hsPlayerRearm(); } catch(e){} }
          });
        })();
        """
        config.userContentController.addUserScript(WKUserScript(
            source: rearm, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    }

    // MARK: - 作用域

    private func isInScope(_ host: String?) -> Bool {
        guard let host = host?.lowercased(), !host.isEmpty else { return false }
        for allowed in Self.inScopeHosts where host == allowed || host.hasSuffix("." + allowed) {
            return true
        }
        return false
    }
}

extension ViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel); return
        }
        let scheme = (url.scheme ?? "").lowercased()

        if scheme == "http" || scheme == "https" {
            if isInScope(url.host) {
                decisionHandler(.allow)
            } else {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            }
            return
        }

        // tel: mailto: 以及自定义 scheme 交给系统
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
        decisionHandler(.cancel)
    }
}

extension ViewController: WKUIDelegate {
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            webView.load(URLRequest(url: url))
        }
        return nil
    }
}
