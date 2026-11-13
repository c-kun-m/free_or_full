import XCTest

final class ClientSmokeTests: XCTestCase {
    @MainActor
    func testLaunchAndPairingForm() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.textFields["messageInput"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["sendMessage"].isEnabled)
        app.navigationBars.buttons["配对电脑"].tap()
        XCTAssertTrue(app.textFields["pairingAddress"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["pairComputer"].isEnabled)
        app.buttons["关闭"].tap()
        app.tabBars.buttons["电脑任务"].tap()
        XCTAssertTrue(app.navigationBars["电脑任务"].exists)
    }
}
