import SwiftUI

@main
struct PhoneAssistantApp: App {
    @StateObject private var model = AssistantModel()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            ContentView().environmentObject(model)
                .task { await model.restore() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { Task { await model.resume() } }
                    else if phase == .background { model.pause() }
                }
        }
    }
}
