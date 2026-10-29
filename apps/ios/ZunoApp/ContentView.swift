import SwiftUI

private enum ZunoPalette {
    static let background = Color(red: 0.05, green: 0.05, blue: 0.09)
    static let panel = Color(red: 0.09, green: 0.09, blue: 0.15)
    static let violet = Color(red: 0.60, green: 0.49, blue: 1.0)
    static let mint = Color(red: 0.46, green: 0.90, blue: 0.83)
    static let muted = Color(red: 0.67, green: 0.65, blue: 0.77)
}

struct ContentView: View {
    @State private var selectedTab = 0
    private let tabs = ["Home", "Discover", "LIVE", "Inbox", "Profile"]

    var body: some View {
        TabView(selection: $selectedTab) {
            home.tag(0).tabItem { Label("Home", systemImage: "house.fill") }
            destination("Discover", subtitle: "Find creators, videos, communities and topics.", symbol: "safari")
                .tag(1).tabItem { Label("Discover", systemImage: "safari") }
            destination("LIVE", subtitle: "Enter live rooms when the authenticated room service returns them.", symbol: "dot.radiowaves.left.and.right")
                .tag(2).tabItem { Label("LIVE", systemImage: "dot.radiowaves.left.and.right") }
            destination("Inbox", subtitle: "Conversations load only after sign-in and messaging integration.", symbol: "message")
                .tag(3).tabItem { Label("Inbox", systemImage: "message") }
            destination("Profile", subtitle: "Manage your public identity, privacy and creator settings.", symbol: "person.crop.circle")
                .tag(4).tabItem { Label("Profile", systemImage: "person.crop.circle") }
        }
        .tint(ZunoPalette.violet)
    }

    private var home: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 10) {
                        Text("Z").font(.title.bold()).frame(width: 40, height: 40)
                            .background(ZunoPalette.violet, in: RoundedRectangle(cornerRadius: 13))
                        Text("ZUNO").font(.title2.bold())
                        Spacer()
                        Text("PREVIEW").font(.caption2.bold()).foregroundStyle(ZunoPalette.muted)
                    }
                    .padding(.top, 10)
                    VStack(alignment: .leading, spacing: 12) {
                        Text("ONE PLATFORM. MANY WORLDS.").font(.caption.bold()).tracking(1.8).foregroundStyle(ZunoPalette.mint)
                        Text("Your world, all in one place.").font(.system(size: 35, weight: .bold, design: .rounded))
                        Text("Discover stories. Find your people. Explore LIVE. Create something unforgettable.")
                            .font(.subheadline).foregroundStyle(ZunoPalette.muted)
                        Button("Explore ZUNO") { selectedTab = 1 }
                            .buttonStyle(.borderedProminent).tint(ZunoPalette.violet)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(22).background(
                        LinearGradient(colors: [Color(red: 0.15, green: 0.12, blue: 0.25), ZunoPalette.panel], startPoint: .topLeading, endPoint: .bottomTrailing),
                        in: RoundedRectangle(cornerRadius: 26)
                    )
                    Text("EXPLORE YOUR INTERESTS").font(.caption.bold()).tracking(1.6).foregroundStyle(ZunoPalette.violet)
                    feature("Video & stories", detail: "Short and long-form media, photos and creator stories.", icon: "play.rectangle.fill") { selectedTab = 1 }
                    feature("LIVE & entertainment", detail: "Music, gaming and audience conversations.", icon: "dot.radiowaves.left.and.right") { selectedTab = 2 }
                    feature("Communities", detail: "Shared interests, groups, channels and events.", icon: "person.3.fill") { selectedTab = 1 }
                    feature("Creator tools", detail: "Prepare content and manage a creator presence.", icon: "sparkles") { selectedTab = 4 }
                    Text("This app shell does not claim provider connectivity. Authenticated content, messaging, LIVE and financial data require server integration.")
                        .font(.caption).foregroundStyle(ZunoPalette.muted).padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(ZunoPalette.panel, in: RoundedRectangle(cornerRadius: 15))
                }
                .padding(.horizontal, 18).padding(.bottom, 28)
            }
            .background(ZunoPalette.background)
            .navigationBarHidden(true)
        }
    }

    private func destination(_ title: String, subtitle: String, symbol: String) -> some View {
        NavigationStack {
            VStack(spacing: 15) {
                Image(systemName: symbol).font(.system(size: 38)).foregroundStyle(ZunoPalette.violet)
                Text(title).font(.largeTitle.bold())
                Text(subtitle).multilineTextAlignment(.center).foregroundStyle(ZunoPalette.muted)
            }.padding(30).frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(ZunoPalette.background).toolbar(.hidden, for: .navigationBar)
        }
    }

    private func feature(_ title: String, detail: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: icon).font(.title2).foregroundStyle(ZunoPalette.violet)
                    .frame(width: 48, height: 48).background(ZunoPalette.panel, in: RoundedRectangle(cornerRadius: 14))
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.headline).foregroundStyle(.white)
                    Text(detail).font(.caption).foregroundStyle(ZunoPalette.muted)
                }
                Spacer()
                Image(systemName: "arrow.up.right").foregroundStyle(ZunoPalette.mint)
            }
            .padding(13).background(ZunoPalette.panel, in: RoundedRectangle(cornerRadius: 17))
        }.buttonStyle(.plain)
    }
}
