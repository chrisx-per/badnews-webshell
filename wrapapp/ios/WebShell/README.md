# iOS 侧：Windows 上怎么把这个网站装成 App

**先说结论：Windows 上编译不出 `.ipa`。** Xcode、iOS SDK、`codesign`、`xcodebuild` 全部只在 macOS 上存在，没有第三方替代。凡是声称"Windows 打包 IPA"的工具，本质都是把工程传到远端 Mac 或塞进云端签名服务，本地并不编译。

所以在 Windows 上能落地的只有三条路，按"今天就能用"排序：

---

## 路线 A · 原生壳 + 远程 Mac 构建（要真 App 就走这条）

工程源码已在 `ios/WebShell/`，三个文件，纯 Swift + WebKit，无任何第三方库：

| 文件 | 作用 |
|---|---|
| `AppDelegate.swift` | 程序入口，把 `ViewController` 设为 root |
| `ViewController.swift` | WKWebView 壳：入口 `https://ios-app.bad.news/`，作用域判定、返回手势、摄像头/麦克风拒绝、`target=_blank` 就地打开 |
| `Info.plist` | ATS 白名单（仅 `bad.news` / `lvv2.com` / `jsdelivr.net`，全部要求 HTTPS）、竖屏、启动屏 |

### A-1 在 Mac 上建工程（5 分钟）

```bash
# Mac 上
mkdir WebShell && cd WebShell
# 1) Xcode → File → New → Project → iOS → App
#    Product Name: WebShell
#    Bundle Identifier: news.bad.wrap
#    Interface: Storyboard（或 SwiftUI，二选一，删掉默认的 ViewController 即可）
#    Language: Swift
# 2) 把三个文件拖进工程：AppDelegate.swift / ViewController.swift / Info.plist
#    注意：Info.plist 拖入后要在 Build Settings → Info.plist File 指向它
# 3) 删掉 Xcode 自动生成的 AppDelegate.swift 与 SceneDelegate.swift（本壳不用 Scene）
# 4) Signing & Capabilities → Team 选自己的开发者账号
```

### A-2 命令行打包 ipa

```bash
xcodebuild -project WebShell.xcodeproj \
           -scheme WebShell \
           -configuration Release \
           -sdk iphoneos \
           -archivePath build/WebShell.xcarchive \
           archive

# 导出（需要 ExportOptions.plist，method 用 development / ad-hoc / app-store 之一）
xcodebuild -exportArchive \
           -archivePath build/WebShell.xcarchive \
           -exportPath build/ipa \
           -exportOptionsPlist ExportOptions.plist

# 结果：build/ipa/WebShell.ipa
```

`ExportOptions.plist` 最小内容：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key><string>development</string>
    <key>teamID</key><string>你的10位TeamID</string>
    <key>signingStyle</key><string>automatic</string>
    <key>stripSwiftSymbols</key><true/>
</dict>
</plist>
```

### A-3 用 GitHub Actions 免费出 ipa（Windows 也能跑）

仓库放 `.github/workflows/ios.yml`：

```yaml
name: build-ipa
on: [push, workflow_dispatch]
jobs:
  build:
    runs-on: macos-14          # 免费额度：公开仓库不限，私有仓库每月 2000 分钟
    steps:
      - uses: actions/checkout@v4

      - name: Build archive (unsigned)
        run: |
          xcodebuild -project ios/WebShell.xcodeproj \
                     -scheme WebShell \
                     -configuration Release \
                     -sdk iphoneos \
                     -destination 'generic/platform=iOS' \
                     -archivePath build/WebShell.xcarchive \
                     archive \
                     CODE_SIGNING_ALLOWED=NO

      - name: Package unsigned ipa
        run: |
          mkdir -p build/Payload
          cp -R build/WebShell.xcarchive/Products/Applications/WebShell.app build/Payload/
          cd build && zip -qr WebShell-unsigned.ipa Payload

      - uses: actions/upload-artifact@v4
        with:
          name: ipa
          path: build/WebShell-unsigned.ipa
```

产出的 unsigned ipa 再用 **Sideloadly / AltStore / TrollStore** 在你的设备上签名安装（用自己的 Apple ID 免费证书可跑 7 天，付费开发者证书可跑 1 年）。

---

## 路线 B · Web Clip 描述文件（零编译，今天就能装）

就是原站自己在用的方式。模板已生成：`ios/hanshuang-wrap.mobileconfig`（51,509 B，含真实图标）。

与原始描述文件的**唯一区别**：`IsRemovable` 设为 `true` —— 用户可以长按图标正常删除，不必去「设置 → 通用 → VPN与设备管理」折腾。

### 用法

1. **AirDrop / 邮件 / 自建 HTTPS 站点**把 `.mobileconfig` 传到 iPhone
2. 点开 → 会跳到「设置 → 已下载描述文件」
3. 点「安装」→ 输入锁屏密码 → 再次「安装」
4. 主屏幕出现 `bad.news` 图标，点开即全屏加载站点

### 限制（必须知道）

| 限制 | 说明 |
|---|---|
| iOS 17+ 对自签 CA 的封杀 | 内网 CA 签发的描述文件在 iOS 17 上不再允许直接安装，要么改走 Apple Configurator 手动装，要么走 MDM 推送 |
| 不是 App | 没有独立沙箱、没有推送、没有后台保活、没有原生 API |
| 图标仍在，代码在远端 | 服务端换前端你控制不了（审核报告 R1） |
| 需要用户手动装 | 不能"点一下就装好" |

如果只是想在自己的设备上把它变成全屏图标，**路线 B 够用，且现在就能做**。

---

## 路线 C · 侧载（不推荐，但要知道存在）

| 工具 | 原理 | 代价 |
|---|---|---|
| Sideloadly | 用你的 Apple ID 免费证书签名，7 天一续 | 7 天重签一次，最多 3 个 App |
| AltStore | 同上，装到另一台设备上做续签服务器 | 需要一台常开的电脑 |
| TrollStore | 利用 CoreTrust 漏洞，永不过期 | 仅特定 iOS 14–17.0 版本，且越高版本越难 |
| 企业证书 | 买别人的企业签名 | 证书随时被吊销，账号可被封；分发他人 App 违反 Apple 条款 |

这几条本质是**绕过签名体系**，能不能长期用全看苹果心情。要正经长期用，走路线 A 买开发者账号（$99/年）。

---

## 我这边的状态

| 项 | 状态 |
|---|---|
| iOS 源码（Swift + WKWebView） | 已完成，`ios/WebShell/` |
| Info.plist（ATS 最小白名单） | 已完成 |
| `mobileconfig` 模板 | 已完成，51,509 B，图标取自原站真实图标 |
| Xcode 工程文件（`.xcodeproj`） | 未生成 —— 需要在 Mac 上 `New → Project` 一次，或我按 `project.pbxproj` 手写一份（可以做，但比 Mac 上新建再拖文件麻烦得多） |
| 编译 / 签名 / 出 ipa | NOT RUN —— 本机是 Windows，无 Xcode |
| 真机安装验证 | NOT RUN —— 无 iOS 设备连接 |
