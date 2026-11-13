#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../apps/ios"
command -v xcodegen >/dev/null || { echo "Install XcodeGen on this Mac first: brew install xcodegen"; exit 1; }
xcodebuild -version
xcodegen generate
device_id=$(xcrun simctl list devices available -j | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(x["udid"] for runtime,items in d["devices"].items() if ".iOS-" in runtime for x in items if x["isAvailable"] and x["name"].startswith("iPhone")))')
xcodebuild test -project PhoneAssistant.xcodeproj -scheme PhoneAssistant \
  -destination "platform=iOS Simulator,id=$device_id" \
  -derivedDataPath build/DerivedData -resultBundlePath "build/Tests-$(date +%s).xcresult" \
  -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO
